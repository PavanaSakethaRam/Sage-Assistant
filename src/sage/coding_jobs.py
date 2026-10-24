"""Pure coding authority: durable source-free facts and one expiring volatile slot."""

import asyncio
import hashlib
import json
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath, PureWindowsPath
from typing import Literal
from uuid import uuid4

from sage.coding_contracts import (
    CodeAck,
    CodeContext,
    CodeFileIntent,
    CodeFileReceipt,
    CodeGrant,
    CodeGrantResult,
    CodeHashRecord,
    CodeIntent,
    CodeJobPage,
    CodeJobResult,
    CodeJobView,
    CodeModelRequest,
    CodePage,
    CodeProposal,
    CodeReceipt,
    CodeReview,
    CodeReviewResult,
    CodeStart,
    CodeTestIntent,
    CodeTestReceipt,
    TestRecipe,
    context_hash,
    disclosure_hash,
    literal_hash,
    parse_code_intent,
    parse_code_proposal,
    parse_code_receipt,
    proposal_hash,
    provider_context,
    recipe_hash,
)
from sage.contracts import ProviderReadiness
from sage.providers.base import CodingBackend
from sage.storage import StorageError, Store

_TERMINAL = {
    "completed",
    "rejected",
    "cancelled",
    "failed",
    "partial",
    "interrupted",
    "needs_reconciliation",
    "applied_unsaved",
    "needs_review",
}
_SOURCE_LEASE = timedelta(minutes=30)
_GRANT_LEASE = timedelta(minutes=5)


class CodingError(ValueError):
    """Fixed category only; source, paths, SQL and exception details never escape."""

    def __init__(
        self, category: Literal["invalid", "unavailable", "stale", "storage"] = "stale"
    ) -> None:
        super().__init__(category)


def _stamp(now: datetime) -> str:
    return now.astimezone(UTC).isoformat(timespec="microseconds")


def _json(value: object) -> str:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def _digest(value: object) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


class CodingJobs:
    def __init__(
        self,
        store: Store,
        boot_id: str,
        clock: Callable[[], datetime],
        backend: CodingBackend | None = None,
    ) -> None:
        if type(boot_id) is not str or not boot_id:
            raise CodingError("invalid")
        self._store = store
        self._boot_id = boot_id
        self._clock = clock
        self._selection: tuple[str, str | None, str | None, int] = ("none", None, None, 0)
        self._context: CodeContext | None = None
        self._proposal: CodeProposal | None = None
        self._recipe: TestRecipe | None = None
        self._review_expires: datetime | None = None
        self._latest: datetime | None = None
        self._invalidate_pending = False
        self._backend = backend
        self._work: asyncio.Task[None] | None = None
        self._draining: set[asyncio.Task[object]] = set()
        self._request_id: str | None = None
        self._inference_deadline: datetime | None = None
        self._lease_timer: asyncio.TimerHandle | None = None
        self._epoch = 0
        self._closed = False

    def readiness(self) -> ProviderReadiness:
        if self._closed or self._selection[0] == "none" or self._backend is None:
            return ProviderReadiness(
                provider="copilot",
                status="unavailable",
                evidence=(),
                explanation="inference_unavailable",
            )
        return self._backend.coding_readiness()

    def _cancel_owned(self) -> None:
        self._epoch += 1
        work = self._work
        if work is not None and not work.done():
            if work is not asyncio.current_task():
                work.cancel()
            if self._backend is not None and self._request_id is not None:
                task = asyncio.create_task(self._backend.cancel(self._request_id))
                self._draining.add(task)
                task.add_done_callback(self._draining.discard)
                task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        self._inference_deadline = None

    async def _drain(self) -> None:
        tasks = [*self._draining]
        if self._work is not None and self._work is not asyncio.current_task():
            tasks.append(self._work)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._work = None
        self._request_id = None

    async def replace_backend(self, backend: CodingBackend | None) -> None:
        previous = self._backend
        self.interrupt()
        await self._drain()
        self._backend = backend
        if previous is not None and previous is not backend:
            await previous.aclose()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self.replace_backend(None)

    async def cancel_work(self, job_id: str) -> CodeJobView:
        view = self.cancel(job_id)
        await self._drain()
        return view

    async def start(self, start: CodeStart) -> CodeJobView:
        start = CodeStart.model_validate_json(start.model_dump_json())
        view = self.get(start.job_id)
        if self._work is not None and not self._work.done():
            raise CodingError("unavailable")
        if self.readiness().status in {"unavailable", "auth_required", "incompatible", "error"}:
            with self._transaction() as (db, now):
                return self._stop(db, view, now, "provider_unavailable", "failed")
        view = self.begin_proposal(start)
        assert self._context is not None and self._backend is not None
        context, backend = self._context, self._backend
        deadline = min(self._clock() + timedelta(seconds=120), view.expires_at)
        data = dict(
            start.model_dump(),
            request_id=uuid4().hex,
            deadline=deadline,
            mode=context.mode,
            files=provider_context(context),
            diagnostics=context.diagnostics,
        )
        if context.target is not None:
            data["target"] = context.target
        request = CodeModelRequest.model_validate(data)
        self._request_id = request.request_id
        self._inference_deadline = deadline
        epoch = self._epoch

        async def propose() -> None:
            try:
                async with asyncio.timeout(max(0, (deadline - self._clock()).total_seconds())):
                    proposal = await backend.propose_code(request)
                self.expire()
                if self._epoch == epoch and self._context is context and self._clock() < deadline:
                    self.set_proposal(proposal)
            except asyncio.CancelledError:
                pass
            except Exception:
                if self._epoch == epoch:
                    with self._transaction() as (db, now):
                        self._stop(
                            db, self._view(db, start.job_id), now, "provider_error", "failed"
                        )
            finally:
                if self._epoch == epoch:
                    self._inference_deadline = None

        self._work = asyncio.create_task(propose())
        return view

    def proposal_get(self, job_id: str) -> CodeProposal:
        view = self.get(job_id)
        self._fresh(view)
        if view.state != "review_required" or self._proposal is None:
            raise CodingError()
        return self._proposal

    @contextmanager
    def _transaction(self) -> Iterator[tuple[sqlite3.Connection, datetime]]:
        # Shared ActionService observation must commit BEFORE this transaction opens.
        try:
            now = self._clock()
            if now.utcoffset() is None:
                raise CodingError("invalid")
            now = now.astimezone(UTC)
            if self._latest is not None and now < self._latest:
                self._invalidate_pending = True
                self._clear()
            self._latest = now
            with self._store.transaction() as db:
                if self._invalidate_pending:
                    db.execute(
                        "UPDATE coding_grants SET revoked=1 WHERE grant_boot_id=?", (self._boot_id,)
                    )
                    for row in db.execute(
                        "SELECT view_json FROM coding_jobs WHERE active=1"
                    ).fetchall():
                        self._stop(
                            db, CodeJobView.model_validate_json(row[0]), now, "stale_context"
                        )
                self._cleanup(db, now)
                yield db, now
            self._invalidate_pending = False
        except StorageError:
            raise CodingError("storage") from None
        except (ValueError, TypeError) as error:
            if isinstance(error, CodingError):
                raise
            raise CodingError("invalid") from None

    def _clear(self, job_id: str | None = None) -> None:
        if (
            job_id is not None
            and self._context is not None
            and self._context.binding.job_id != job_id
        ):
            return
        self._cancel_owned()
        if self._lease_timer is not None:
            self._lease_timer.cancel()
            self._lease_timer = None
        self._context = None
        self._proposal = None
        self._recipe = None
        self._review_expires = None

    @staticmethod
    def _view(db: sqlite3.Connection, job_id: str) -> CodeJobView:
        row = db.execute("SELECT view_json,state FROM coding_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise CodingError()
        view = CodeJobView.model_validate_json(row["view_json"])
        if view.state != row["state"]:
            raise CodingError()
        return view

    @staticmethod
    def _save(db: sqlite3.Connection, view: CodeJobView, now: datetime) -> None:
        # Validate trusted derived views too; never persist transient bodies.
        checked = CodeJobView.model_validate_json(view.model_dump_json())
        db.execute(
            "UPDATE coding_jobs SET state=?,active=?,view_json=?,updated_at=? WHERE id=?",
            (
                checked.state,
                int(checked.state not in _TERMINAL),
                checked.model_dump_json(),
                _stamp(now),
                checked.binding.job_id,
            ),
        )

    @staticmethod
    def _inflight(db: sqlite3.Connection, job_id: str) -> bool:
        return (
            db.execute(
                "SELECT 1 FROM coding_effects e JOIN coding_grants g "
                "ON e.operation_id=g.operation_id WHERE g.job_id=? AND e.receipt_json IS NULL",
                (job_id,),
            ).fetchone()
            is not None
        )

    def _stop(
        self,
        db: sqlite3.Connection,
        view: CodeJobView,
        now: datetime,
        diagnostic: str,
        state: str = "cancelled",
    ) -> CodeJobView:
        db.execute("UPDATE coding_grants SET revoked=1 WHERE job_id=?", (view.binding.job_id,))
        if self._context is not None and self._context.binding.job_id == view.binding.job_id:
            self._clear()
        pending = self._inflight(db, view.binding.job_id)
        if (
            state == "cancelled"
            and not pending
            and view.state in {"applying", "applied_saved"}
            and view.receipts
        ):
            state = (
                "partial"
                if len(view.receipts) < 4 and view.mode == "create_focus_project"
                else "cancelled"
            )
        if state == "cancelled" and not pending and view.state == "test_review" and view.receipts:
            last = view.receipts[-1]
            if isinstance(last, CodeTestReceipt):
                state = (
                    "completed"
                    if last.status == "passed"
                    else "needs_reconciliation"
                    if last.status in {"unknown", "termination_unconfirmed"}
                    else "failed"
                )
        changed = view.model_copy(
            update={
                "state": view.state if pending else state,
                "cancel_requested": True,
                "diagnostic": diagnostic,
            }
        )
        self._save(db, changed, now)
        return changed

    def _cleanup(self, db: sqlite3.Connection, now: datetime) -> None:
        cutoff = _stamp(now - timedelta(days=30))
        db.execute("DELETE FROM coding_jobs WHERE updated_at<=?", (cutoff,))
        if (
            self._context is not None
            and not db.execute(
                "SELECT 1 FROM coding_jobs WHERE id=?", (self._context.binding.job_id,)
            ).fetchone()
        ):
            self._clear()
        expired_jobs: set[str] = set()
        for grant_row in db.execute(
            "SELECT job_id,data_json FROM coding_grants WHERE revoked=0"
        ).fetchall():
            grant = CodeGrant.model_validate_json(grant_row["data_json"])
            if now >= grant.expires_at:
                db.execute(
                    "UPDATE coding_grants SET revoked=1 WHERE operation_id=?", (grant.operation_id,)
                )
                expired_jobs.add(grant_row["job_id"])
        for row in db.execute("SELECT view_json FROM coding_jobs WHERE active=1").fetchall():
            view = CodeJobView.model_validate_json(row[0])
            grant_expired = view.binding.job_id in expired_jobs and view.state in {
                "applying",
                "testing",
            }
            review_expired = (
                self._context is not None
                and self._context.binding == view.binding
                and self._review_expires is not None
                and now >= self._review_expires
                and view.state in {"review_required", "test_review"}
                and not any(r.scope == "code.test" for r in view.receipts)
            )
            inference_expired = (
                view.state == "proposing"
                and self._inference_deadline is not None
                and now >= self._inference_deadline
            )
            if (
                now >= view.expires_at or review_expired or grant_expired or inference_expired
            ) and (not view.cancel_requested or view.state == "test_review"):
                self._stop(db, view, now, "expired")

    def configure_selection(
        self,
        *,
        backend: Literal["none", "copilot"],
        account: str | None,
        model: str | None,
        account_generation: int,
    ) -> None:
        if (
            backend not in {"none", "copilot"}
            or type(account_generation) is not int
            or not 0 <= account_generation <= 9_007_199_254_740_991
        ):
            raise CodingError("invalid")
        if account_generation == 0 and account is not None:
            raise CodingError("invalid")
        if backend == "none" and (account is not None or model is not None):
            raise CodingError("invalid")
        if backend == "copilot":
            # Reuse the strict bounded metadata validators without accepting source.
            try:
                CodeStart(
                    job_id="selection",
                    revision=1,
                    account_generation=account_generation,
                    user_text="",
                    backend="copilot",
                    model=model,
                    disclosure_hash="0" * 64,
                )
            except ValueError:
                raise CodingError("invalid") from None
        if account is not None and (
            type(account) is not str
            or not 1 <= len(account) <= 100
            or any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF for c in account)
        ):
            raise CodingError("invalid")
        selection = (backend, account, model, account_generation)
        if selection == self._selection:
            return
        self._clear()
        with self._transaction() as (db, now):
            for row in db.execute("SELECT view_json FROM coding_jobs WHERE active=1").fetchall():
                self._stop(db, CodeJobView.model_validate_json(row[0]), now, "stale_context")
        self._selection = selection

    def accept_context(
        self, context: CodeContext, *, expires_at: datetime | None = None
    ) -> CodeJobView:
        try:
            context = CodeContext.model_validate_json(context.model_dump_json())
            if context.context_hash != context_hash(context) or any(
                file.text_hash != literal_hash(file.text) or file.disk_hash != file.text_hash
                for file in context.files
            ):
                raise CodingError("invalid")
        except (ValueError, AttributeError):
            raise CodingError("invalid") from None
        with self._transaction() as (db, now):
            if db.execute(
                "SELECT 1 FROM coding_jobs WHERE active=1 OR id=?", (context.binding.job_id,)
            ).fetchone():
                raise CodingError()
            _, account, model, generation = self._selection
            # Disabled capture is local metadata only; begin_proposal refuses it.
            data: dict[str, object] = {
                "binding": context.binding,
                "mode": context.mode,
                "state": "context_ready",
                "destination": "GitHub Copilot cloud",
                "account": account,
                "model": model,
                "account_generation": generation,
                "context_hash": context.context_hash,
                "file_count": len(context.files),
                "manifest": tuple(file.name for file in context.files),
                "hashes": tuple(
                    CodeHashRecord(
                        name=file.name,
                        source_hash=file.text_hash,
                        proposed_hash=None,
                        observed_hash=None,
                    )
                    for file in context.files
                ),
                "source_codepoints": sum(len(file.text) for file in context.files),
                "diagnostics_codepoints": sum(len(item) for item in context.diagnostics),
                "metadata_codepoints": sum(len(file.name) for file in context.files)
                + len(context.mode)
                + len(context.target or ""),
                "expires_at": min(now + _SOURCE_LEASE, expires_at)
                if expires_at is not None
                else now + _SOURCE_LEASE,
                "diagnostic": None,
                "receipts": (),
            }
            if context.target is not None:
                data["target"] = context.target
            view = CodeJobView.model_validate(data)
            db.execute(
                "INSERT INTO coding_jobs VALUES(?,?,?,?,?)",
                (context.binding.job_id, view.state, 1, view.model_dump_json(), _stamp(now)),
            )
        self._clear()
        self._context = context
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            self._lease_timer = loop.call_later(
                max(0, (view.expires_at - self._clock()).total_seconds()), self.expire
            )
        return view

    def get(self, job_id: str) -> CodeJobView:
        with self._transaction() as (db, _):
            return self._view(db, job_id)

    def list(self, limit: int = 20, offset: int = 0) -> CodeJobPage:
        try:
            page = CodePage(limit=limit, offset=offset)
        except ValueError:
            raise CodingError("invalid") from None
        with self._transaction() as (db, _):
            rows = db.execute(
                "SELECT view_json FROM coding_jobs ORDER BY updated_at,id LIMIT ? OFFSET ?",
                (page.limit + 1, page.offset),
            ).fetchall()
            return CodeJobPage(
                items=tuple(CodeJobView.model_validate_json(row[0]) for row in rows[:limit]),
                next_offset=offset + limit if len(rows) > limit else None,
            )

    def _fresh(self, view: CodeJobView) -> CodeContext:
        if self._context is None or self._context.binding != view.binding or view.cancel_requested:
            raise CodingError()
        if self._selection != ("copilot", view.account, view.model, view.account_generation):
            raise CodingError("unavailable")
        return self._context

    def begin_proposal(self, start: CodeStart) -> CodeJobView:
        with self._transaction() as (db, now):
            view = self._view(db, start.job_id)
            self._fresh(view)
            if (
                view.state != "context_ready"
                or disclosure_hash(view, start.model_dump(exclude={"disclosure_hash"}))
                != start.disclosure_hash
            ):
                raise CodingError()
            view = view.model_copy(update={"state": "proposing"})
            self._save(db, view, now)
            return view

    def set_proposal(self, proposal: CodeProposal) -> CodeJobView:
        with self._transaction() as (db, now):
            proposal = CodeProposal.model_validate_json(proposal.model_dump_json())
            view = self._view(db, proposal.job_id)
            context = self._fresh(view)
            if view.state != "proposing":
                raise CodingError()
            valid = parse_code_proposal(proposal, context)
            sources = {file.name: file.text_hash for file in context.files}
            proposed = {file.name: literal_hash(file.text) for file in valid.files}
            names = tuple(file.name for file in context.files) or tuple(
                file.name for file in valid.files
            )
            view = view.model_copy(
                update={
                    "state": "review_required",
                    "hashes": tuple(
                        CodeHashRecord(
                            name=name,
                            source_hash=sources.get(name),
                            proposed_hash=proposed.get(name),
                            observed_hash=None,
                        )
                        for name in names
                    ),
                }
            )
            self._save(db, view, now)
        self._proposal = valid
        self._review_expires = min(now + _GRANT_LEASE, view.expires_at)
        return view

    def prepare_test(self, recipe: TestRecipe) -> CodeJobView:
        if self._context is None:
            raise CodingError()
        with self._transaction() as (db, now):
            view = self._view(db, self._context.binding.job_id)
            self._fresh(view)
            recipe = TestRecipe.model_validate_json(recipe.model_dump_json())
            path = PurePosixPath if recipe.platform == "darwin" else PureWindowsPath
            if (
                view.state != "applied_saved"
                or recipe.recipe_hash != recipe_hash(recipe)
                or recipe.root_id != view.binding.root_id
                or recipe.executable_version != "26.12.1"
                or not now < recipe.deadline <= now + _GRANT_LEASE
                or path(recipe.executable).is_relative_to(path(recipe.cwd))
            ):
                raise CodingError()
            hashes = {row.name: row.hash for row in recipe.file_hashes}
            if any(
                (row.observed_hash or row.source_hash) is not None
                and hashes[row.name] != (row.observed_hash or row.source_hash)
                for row in view.hashes
            ):
                raise CodingError()
            view = view.model_copy(update={"state": "test_review"})
            self._save(db, view, now)
        self._recipe = recipe
        self._review_expires = min(recipe.deadline, view.expires_at)
        return view

    def review(self, decision: CodeReview) -> CodeReviewResult:
        with self._transaction() as (db, now):
            decision = CodeReview.model_validate_json(decision.model_dump_json())
            view = self._view(db, decision.binding.job_id)
            context = self._fresh(view)
            if decision.binding != view.binding:
                raise CodingError()
            if decision.scope == "code.test":
                if (
                    view.state != "test_review"
                    or self._recipe is None
                    or any(r.scope == "code.test" for r in view.receipts)
                ):
                    raise CodingError()
                approved = self._recipe.recipe_hash
                if now >= self._recipe.deadline:
                    raise CodingError()
            else:
                if view.state != "review_required" or self._proposal is None:
                    raise CodingError()
                approved = proposal_hash(self._proposal, context, decision.scope)
            if decision.approved_hash != approved:
                raise CodingError()
            if decision.decision == "reject":
                changed = self._stop(db, view, now, "stale_context", "rejected")
                return CodeJobResult(kind="job", job=changed)
            grant = CodeGrant(
                binding=view.binding,
                grant_boot_id=self._boot_id,
                scope=decision.scope,
                operation_id=uuid4().hex,
                approved_hash=approved,
                issued_at=now,
                expires_at=min(
                    now + _GRANT_LEASE,
                    view.expires_at,
                    self._recipe.deadline
                    if decision.scope == "code.test" and self._recipe
                    else view.expires_at,
                ),
            )
            db.execute(
                "INSERT INTO coding_grants(operation_id,job_id,grant_boot_id,scope,data_json) "
                "VALUES(?,?,?,?,?)",
                (
                    grant.operation_id,
                    view.binding.job_id,
                    self._boot_id,
                    grant.scope,
                    grant.model_dump_json(),
                ),
            )
            self._save(
                db,
                view.model_copy(
                    update={"state": "testing" if grant.scope == "code.test" else "applying"}
                ),
                now,
            )
            return CodeGrantResult(kind="grant", grant=grant)

    @staticmethod
    def _projection(intent: CodeFileIntent | CodeTestIntent) -> dict[str, object]:
        data = intent.model_dump(mode="json", exclude={"recipe"})
        if isinstance(intent, CodeTestIntent):
            recipe = intent.recipe
            data["recipe"] = {
                "recipe_hash": recipe.recipe_hash,
                "environment_hash": _digest(recipe.environment),
                "executable_hash": recipe.executable_hash,
                "executable_identity": recipe.executable_identity,
                "executable_version": recipe.executable_version,
                "argv": recipe.argv,
                "deadline": recipe.model_dump(mode="json")["deadline"],
                "output_cap": recipe.output_cap,
                "timeout_seconds": recipe.timeout_seconds,
            }
        return data

    def begin(self, intent: CodeIntent) -> CodeAck:
        try:
            valid = parse_code_intent(intent.model_dump(mode="json"))
        except (ValueError, AttributeError):
            raise CodingError("invalid") from None
        material = self._projection(valid)
        digest = _digest(material)
        with self._transaction() as (db, now):
            previous = db.execute(
                "SELECT * FROM coding_effects WHERE effect_id=?", (valid.effect_id,)
            ).fetchone()
            if previous is not None:
                same = previous["intent_hash"] == digest and previous["intent_json"] == _json(
                    material
                )
                return CodeAck(
                    operation_id=valid.operation_id,
                    effect_id=valid.effect_id,
                    status="duplicate" if same else "conflict",
                    recorded_hash=digest if same else None,
                )
            view = self._view(db, valid.binding.job_id)
            context = self._fresh(view)
            row = db.execute(
                "SELECT * FROM coding_grants WHERE operation_id=?", (valid.operation_id,)
            ).fetchone()
            if row is None:
                raise CodingError()
            grant = CodeGrant.model_validate_json(row["data_json"])
            if (
                row["revoked"]
                or row["grant_boot_id"] != self._boot_id
                or grant.grant_boot_id != self._boot_id
                or row["scope"] != valid.scope
                or grant.scope != valid.scope
                or row["job_id"] != view.binding.job_id
                or grant.binding != valid.binding
                or view.binding != valid.binding
                or grant.expires_at
                != min(
                    grant.issued_at + _GRANT_LEASE,
                    view.expires_at,
                    valid.recipe.deadline if isinstance(valid, CodeTestIntent) else view.expires_at,
                )
                or not grant.issued_at <= now < grant.expires_at
            ):
                raise CodingError()
            effects = db.execute(
                "SELECT * FROM coding_effects WHERE operation_id=? ORDER BY ordinal",
                (valid.operation_id,),
            ).fetchall()
            if valid.ordinal != len(effects) or any(row["receipt_json"] is None for row in effects):
                raise CodingError()
            expected_length = None
            if isinstance(valid, CodeTestIntent):
                if (
                    view.state != "testing"
                    or effects
                    or self._recipe is None
                    or valid.recipe != self._recipe
                    or valid.expected_hash != recipe_hash(valid.recipe)
                    or grant.approved_hash != valid.expected_hash
                    or now >= valid.recipe.deadline
                ):
                    raise CodingError()
            else:
                if view.state != "applying" or self._proposal is None:
                    raise CodingError()
                files = self._proposal.files
                if (
                    valid.ordinal >= len(files)
                    or valid.target != files[valid.ordinal].name
                    or valid.expected_hash != literal_hash(files[valid.ordinal].text)
                    or grant.approved_hash != proposal_hash(self._proposal, context, valid.scope)
                ):
                    raise CodingError()
                expected_length = len(files[valid.ordinal].text.encode("utf-8"))
            if grant.consumed_at is not None:
                raise CodingError()
            if row["consumed_at"] is not None:
                consumed = datetime.fromisoformat(row["consumed_at"])
                if (
                    consumed.utcoffset() is None
                    or not grant.issued_at <= consumed <= now
                    or consumed >= grant.expires_at
                ):
                    raise CodingError()
            if (row["consumed_at"] is None) != (len(effects) == 0):
                raise CodingError()
            db.execute(
                "UPDATE coding_grants SET consumed_at=coalesce(consumed_at,?) WHERE operation_id=?",
                (_stamp(now), valid.operation_id),
            )
            db.execute(
                "INSERT INTO coding_effects(effect_id,operation_id,ordinal,scope,intent_json,"
                "intent_hash,expected_length) VALUES(?,?,?,?,?,?,?)",
                (
                    valid.effect_id,
                    valid.operation_id,
                    valid.ordinal,
                    valid.scope,
                    _json(material),
                    digest,
                    expected_length,
                ),
            )
            return CodeAck(
                operation_id=valid.operation_id,
                effect_id=valid.effect_id,
                status="recorded",
                recorded_hash=digest,
            )

    def observe(self, receipt: CodeReceipt) -> CodeAck:
        try:
            valid = parse_code_receipt(receipt.model_dump(mode="json"))
        except (ValueError, AttributeError):
            raise CodingError("invalid") from None
        material = valid.model_dump(mode="json")
        digest = _digest(material)
        with self._transaction() as (db, now):
            row = db.execute(
                "SELECT * FROM coding_effects WHERE effect_id=? AND operation_id=?",
                (valid.effect_id, valid.operation_id),
            ).fetchone()
            conflict = CodeAck(
                operation_id=valid.operation_id, effect_id=valid.effect_id, status="conflict"
            )
            if row is None:
                return conflict
            intent = json.loads(row["intent_json"])
            if (
                row["intent_hash"] != _digest(intent)
                or row["operation_id"] != intent["operation_id"]
                or row["ordinal"] != intent["ordinal"]
                or row["scope"] != intent["scope"]
            ):
                return conflict
            identity = ("binding", "operation_id", "effect_id", "scope", "ordinal", "expected_hash")
            if any(material[key] != intent[key] for key in identity):
                return conflict
            if isinstance(valid, CodeFileReceipt):
                if valid.target != intent["target"]:
                    return conflict
                if valid.status in {"created", "applied_saved"} and (
                    valid.observed_hash != valid.expected_hash
                    or valid.observed_length != row["expected_length"]
                ):
                    raise CodingError("invalid")
            else:
                recipe = intent["recipe"]
                if any(
                    material[key] != recipe[key]
                    for key in ("environment_hash", "executable_hash", "executable_version")
                ):
                    return conflict
                if valid.status == "passed" and (
                    valid.exit_code != 0
                    or valid.signal is not None
                    or valid.timeout
                    or valid.overflow
                    or valid.cancel_requested
                ):
                    raise CodingError("invalid")
            if row["receipt_json"] is not None:
                same = row["receipt_hash"] == digest and row["receipt_json"] == _json(material)
                if not same:
                    view = self._view(db, valid.binding.job_id)
                    self._stop(db, view, now, "reconciliation_required", "needs_reconciliation")
                return CodeAck(
                    operation_id=valid.operation_id,
                    effect_id=valid.effect_id,
                    status="duplicate" if same else "conflict",
                    recorded_hash=digest if same else None,
                )
            view = self._view(db, valid.binding.job_id)
            if valid.binding != view.binding:
                return conflict
            receipts = (*view.receipts, valid)
            changes: dict[str, object] = {"receipts": receipts}
            if isinstance(valid, CodeTestReceipt):
                changes["state"] = (
                    "test_review"
                    if view.state not in _TERMINAL
                    else "completed"
                    if valid.status == "passed"
                    else "needs_reconciliation"
                    if valid.status in {"unknown", "termination_unconfirmed"}
                    else "failed"
                )
            else:
                changes["hashes"] = tuple(
                    record.model_copy(update={"observed_hash": valid.observed_hash})
                    if record.name == valid.target
                    else record
                    for record in view.hashes
                )
                good = valid.status in {"created", "applied_saved"}
                if not good:
                    changes["state"] = valid.status
                elif view.cancel_requested or view.state in _TERMINAL:
                    changes["state"] = (
                        "partial"
                        if valid.scope == "code.create" and len(receipts) < 4
                        else "cancelled"
                    )
                elif valid.scope == "code.replace" or len(receipts) == 4:
                    changes["state"] = "applied_saved"
                else:
                    changes["state"] = "applying"
            changed = view.model_copy(update=changes)
            db.execute(
                "UPDATE coding_effects SET receipt_json=?,receipt_hash=? WHERE effect_id=?",
                (_json(material), digest, valid.effect_id),
            )
            if changed.state in _TERMINAL:
                db.execute(
                    "UPDATE coding_grants SET revoked=1 WHERE job_id=?", (view.binding.job_id,)
                )
            self._save(db, changed, now)
        if changed.state in _TERMINAL:
            self._clear(changed.binding.job_id)
        return CodeAck(
            operation_id=valid.operation_id,
            effect_id=valid.effect_id,
            status="recorded",
            recorded_hash=digest,
        )

    def finish(self, job_id: str) -> CodeJobView:
        with self._transaction() as (db, now):
            view = self._view(db, job_id)
            state = view.state
            if self._inflight(db, job_id):
                state = "needs_reconciliation"
            elif (
                state == "test_review"
                and view.receipts
                and isinstance(view.receipts[-1], CodeTestReceipt)
            ):
                receipt = view.receipts[-1]
                state = (
                    "completed"
                    if receipt.status == "passed"
                    else "needs_reconciliation"
                    if receipt.status in {"unknown", "termination_unconfirmed"}
                    else "failed"
                )
            elif state == "applied_saved":
                state = "completed"
            elif state not in _TERMINAL:
                raise CodingError()
            db.execute("UPDATE coding_grants SET revoked=1 WHERE job_id=?", (job_id,))
            view = view.model_copy(update={"state": state})
            self._save(db, view, now)
        self._clear(job_id)
        return view

    def cancel(self, job_id: str) -> CodeJobView:
        with self._transaction() as (db, now):
            view = self._view(db, job_id)
            if view.state in _TERMINAL:
                return view
            return self._stop(db, view, now, "stale_context")

    def revoke_pair(self, pair_id: str) -> None:
        with self._transaction() as (db, now):
            for row in db.execute("SELECT view_json FROM coding_jobs WHERE active=1").fetchall():
                view = CodeJobView.model_validate_json(row[0])
                if view.binding.pair_id == pair_id:
                    self._stop(db, view, now, "stale_context")

    def expire(self) -> None:
        with self._transaction():
            pass

    def interrupt(self) -> None:
        self._clear()
        with self._transaction() as (db, now):
            db.execute("UPDATE coding_grants SET revoked=1")
            for row in db.execute("SELECT view_json FROM coding_jobs WHERE active=1").fetchall():
                view = CodeJobView.model_validate_json(row[0])
                self._save(
                    db,
                    view.model_copy(
                        update={
                            "state": "interrupted",
                            "diagnostic": "interrupted",
                            "cancel_requested": True,
                        }
                    ),
                    now,
                )
