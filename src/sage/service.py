"""One local core owner and a closed private request dispatcher."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, Protocol
from uuid import uuid4

from pydantic import AfterValidator, Field, ValidationError, field_validator

from sage.actions import ActionService
from sage.coding_contracts import (
    CodeJobId,
    CodePage,
    CodePairId,
    CodeReview,
    CodeStart,
    ContextOffer,
    TestRecipe,
    parse_code_intent,
    parse_code_receipt,
)
from sage.coding_jobs import CodingJobs
from sage.config import Settings
from sage.contracts import (
    Backend,
    Contract,
    NoteContent,
    ReasoningRequest,
    ReasoningResult,
    Revision,
    _context_text,
)
from sage.logging import diagnostic
from sage.protocol import (
    ErrorCode,
    Failure,
    HostCodingReply,
    ProtocolError,
    Request,
    Response,
    RpcId,
    SelectedAccount,
    encode_frame,
    failure,
    host_coding,
    read_frame,
    request,
    selection,
)
from sage.providers.base import CodingBackend, ReasoningBackend
from sage.storage import Store


class Empty(Contract):
    pass


class Page(Contract):
    limit: Annotated[int, Field(ge=1, le=100)] = 20
    offset: Annotated[int, Field(ge=0, le=1_000_000)] = 0


class Search(Page):
    query: Annotated[str, Field(max_length=32_000), AfterValidator(_context_text)]


class NoteId(Contract):
    note_id: RpcId


class TaskId(Contract):
    task_id: RpcId


class ReviewId(Contract):
    proposal_id: RpcId
    revision: Revision


class RevisionInput(ReviewId, NoteContent):
    pass


class Decision(ReviewId):
    decision: Literal["save", "cancel"]


class Cancel(Contract):
    request_id: RpcId


class ReasoningInput(Contract):
    user_text: Annotated[str, Field(max_length=32_000)]
    attached_context: list[str] = Field(default_factory=list, max_length=64_000)
    backend: Backend
    model: Annotated[str, Field(max_length=200)] | None = None

    @field_validator("user_text")
    @classmethod
    def text_controls(cls, value: str) -> str:
        return _context_text(value)

    @field_validator("attached_context")
    @classmethod
    def context_limit(cls, value: list[str]) -> list[str]:
        if sum(map(len, value)) > 64_000:
            raise ValueError("Context too large")
        for part in value:
            _context_text(part)
        return value


@dataclass
class _Inference:
    request: ReasoningRequest
    generation: int
    cancelled: bool = False


async def _settle_owners(coding: Awaitable[None], notes: ReasoningBackend | None) -> None:
    work = [coding]
    if notes is not None:
        work.append(notes.aclose())
    results = await asyncio.gather(*work, return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException):
            raise result


class CoreService:
    """Startup owns one Store and one long-lived ActionService with a fresh boot."""

    def __init__(
        self,
        store: Store,
        clock: Callable[[], datetime] | None = None,
        backend: ReasoningBackend | None = None,
        backend_factory: Callable[[SelectedAccount | None], ReasoningBackend] | None = None,
        coding_backend: CodingBackend | None = None,
        coding_backend_factory: Callable[[SelectedAccount | None], CodingBackend] | None = None,
    ) -> None:
        self.store = store
        self.clock = clock or (lambda: datetime.now(UTC))
        self.boot_id = uuid4().hex
        self.actions = ActionService(store, self.clock, self.boot_id)
        self._clock_latest: datetime | None = None
        self.clock = self._observe_clock
        self.coding = CodingJobs(store, self.boot_id, self.clock, coding_backend)
        self.coding.interrupt()
        self.backend = backend
        self._backend_factory = backend_factory
        self._coding_backend_factory = coding_backend_factory
        self._account: SelectedAccount | None = None
        self._coding_boot: str | None = None
        self._coding_generation = 0
        self._selection_boot: str | None = None
        self._selection_generation = 0
        self._selection_lock = asyncio.Lock()
        self._generation = 0
        self._inflight: dict[str, _Inference] = {}
        self._seen: set[str] = set()
        self.shutting_down = False
        self.store.interrupt_inference(self.clock())
        self._configure_coding()

    def _observe_clock(self) -> datetime:
        now = self.actions.observe_clock()
        rollback = self._clock_latest is not None and now < self._clock_latest
        self._clock_latest = now
        # ActionService has committed shared grant revocation before source/work clearing.
        if rollback and hasattr(self, "coding"):
            self.coding.interrupt()
        return now

    def _configure_coding(self) -> None:
        settings = self.get_settings()
        enabled = settings.ai_mode == "assistant" and settings.coding_backend == "copilot"
        self.coding.configure_selection(
            backend="copilot" if enabled else "none",
            account=self._account.login if enabled and self._account else None,
            model=settings.coding_model if enabled else None,
            account_generation=self._selection_generation if enabled else 0,
        )

    async def coding_control(self, message: dict[str, object]) -> dict[str, object]:
        identifier: str | None = None
        try:
            control = host_coding(message)
            identifier = control.id
            if self.shutting_down:
                return failure(control.id, "shutting_down")
            if control.id in self._seen:
                return failure(control.id, "duplicate_id")
            if len(self._seen) >= 4096:
                return failure(control.id, "session_limit")
            if (
                self._coding_boot is not None
                and control.host_boot_id != self._coding_boot
                or control.generation <= self._coding_generation
            ):
                return failure(control.id, "invalid_request")
            self._seen.add(control.id)
            self._coding_boot = control.host_boot_id
            self._coding_generation = control.generation
            value = control.parsed_params()
            result: Contract
            match control.operation:
                case "context":
                    assert isinstance(value, ContextOffer)
                    result = self.coding.accept_context(
                        value.context, expires_at=value.deadline(self.clock())
                    )
                case "proposal_get":
                    assert isinstance(value, CodeJobId)
                    result = self.coding.proposal_get(value.job_id)
                case "test_prepare":
                    assert isinstance(value, TestRecipe)
                    result = self.coding.prepare_test(value)
                case "finish":
                    assert isinstance(value, CodeJobId)
                    result = self.coding.finish(value.job_id)
                case "review":
                    assert isinstance(value, CodeReview)
                    result = self.coding.review(value)
                case "intent":
                    result = self.coding.begin(parse_code_intent(control.params))
                case "observation":
                    result = self.coding.observe(parse_code_receipt(control.params))
                case "revoke_pair":
                    assert isinstance(value, CodePairId)
                    self.coding.revoke_pair(value.pair_id)
                    return HostCodingReply(
                        id=control.id,
                        host_boot_id=control.host_boot_id,
                        generation=control.generation,
                        operation=control.operation,
                        result={"status": "revoked"},
                    ).model_dump(mode="json")
            return HostCodingReply(
                id=control.id,
                host_boot_id=control.host_boot_id,
                generation=control.generation,
                operation=control.operation,
                result=result.model_dump(mode="json"),
            ).model_dump(mode="json")
        except (ValueError, ValidationError):
            return failure(identifier, "invalid_request")
        except Exception:
            diagnostic("request_failed")
            return failure(None, "internal_error")

    async def select_account(self, message: dict[str, object]) -> dict[str, object]:
        """Parent pipe only. Boot correlates; the inherited pipe supplies authority."""
        try:
            frame = selection(message)
        except ProtocolError:
            return failure(None, "invalid_request")
        async with self._selection_lock:
            if self.shutting_down:
                return failure(frame.id, "shutting_down")
            if frame.id in self._seen:
                return failure(frame.id, "duplicate_id")
            if len(self._seen) >= 4096:
                return failure(frame.id, "session_limit")
            if (
                self._selection_boot is not None and frame.boot_id != self._selection_boot
            ) or frame.generation <= self._selection_generation:
                return failure(frame.id, "invalid_request")
            self._seen.add(frame.id)
            self._selection_boot = frame.boot_id
            self._selection_generation = frame.generation
            if frame.account is not None and self.get_settings().ai_mode != "assistant":
                return Response(
                    id=frame.id, result={"generation": frame.generation, "status": "unavailable"}
                ).model_dump(mode="json")
            await self._replace_source(frame.account)
            status = (
                "cleared"
                if frame.account is None
                else "selected"
                if self._backend_factory is not None or self._coding_backend_factory is not None
                else "unavailable"
            )
            return Response(
                id=frame.id, result={"generation": frame.generation, "status": status}
            ).model_dump(mode="json")

    async def _replace_source(self, account: SelectedAccount | None) -> None:
        self._generation += 1
        self._account = account
        self.coding.interrupt()
        previous, self.backend = self.backend, None
        await self._cancel_inflight()
        await _settle_owners(self.coding.replace_backend(None), previous)
        if self._coding_backend_factory is not None:
            await self.coding.replace_backend(self._coding_backend_factory(account))
        self._configure_coding()
        if self._backend_factory is not None:
            self.backend = self._backend_factory(account)

    def close(self) -> None:
        self.shutting_down = True
        self.store.close()

    async def aclose(self) -> None:
        self.shutting_down = True
        for entry in self._inflight.values():
            entry.cancelled = True
        previous, self.backend = self.backend, None
        try:
            await _settle_owners(self.coding.aclose(), previous)
        finally:
            self.close()

    def get_settings(self) -> Settings:
        with self.store.transaction() as db:
            row = db.execute("SELECT data_json FROM settings WHERE id=1").fetchone()
        return Settings.model_validate_json(row[0]) if row else Settings()

    async def dispatch(self, message: dict[str, object]) -> dict[str, object]:
        try:
            envelope = request(message)
        except ProtocolError:
            return failure(None, "invalid_request")
        if envelope.id in self._seen:
            return failure(envelope.id, "duplicate_id")
        if len(self._seen) >= 4096:
            return failure(envelope.id, "session_limit")
        self._seen.add(envelope.id)
        if self.shutting_down:
            return failure(envelope.id, "shutting_down")
        try:
            self.clock()
            if envelope.method in {"reasoning.start", "connection.test", "reasoning.cancel"}:
                value = await self._provider_dispatch(envelope)
            elif envelope.method == "coding.start":
                value = (
                    await self.coding.start(CodeStart.model_validate(envelope.params))
                ).model_dump(mode="json")
            elif envelope.method == "coding.cancel":
                value = (
                    await self.coding.cancel_work(CodeJobId.model_validate(envelope.params).job_id)
                ).model_dump(mode="json")
            elif envelope.method == "settings.update":
                settings = Settings.model_validate(envelope.params)
                async with self._selection_lock:
                    self._generation += 1
                    await self._cancel_inflight()
                    if settings.ai_mode != "assistant" and self._backend_factory is not None:
                        await self._replace_source(None)
                    if settings != self.get_settings():
                        self.coding.interrupt()
                    value = self._dispatch(envelope)
                    self._configure_coding()
            else:
                if envelope.method == "app.shutdown":
                    Empty.model_validate(envelope.params)
                    await self._cancel_inflight()
                    await self.coding.aclose()
                elif envelope.method == "tasks.cancel":
                    target = TaskId.model_validate(envelope.params)
                    for identifier, entry in list(self._inflight.items()):
                        if entry.request.task_id == target.task_id:
                            await self._cancel_request(identifier)
                value = self._dispatch(envelope)
            return Response(id=envelope.id, result=value).model_dump(mode="json")
        except LookupError:
            return failure(envelope.id, "not_found")
        except (ValueError, ValidationError):
            return failure(envelope.id, "invalid_request")
        except Exception:
            diagnostic("request_failed")
            return failure(envelope.id, "internal_error")

    async def _cancel_request(self, request_id: str) -> bool:
        entry = self._inflight.get(request_id)
        if entry is None:
            return False
        entry.cancelled = True
        with self.store.transaction() as db:
            db.execute(
                "UPDATE tasks SET status='cancelled' WHERE id=? AND status='reasoning'",
                (entry.request.task_id,),
            )
        if self.backend is not None:
            await self.backend.cancel(request_id)
        return True

    async def _cancel_inflight(self) -> None:
        for identifier in list(self._inflight):
            await self._cancel_request(identifier)

    async def _provider_dispatch(self, envelope: Request) -> dict[str, object]:
        if envelope.method == "reasoning.cancel":
            cancel = Cancel.model_validate(envelope.params)
            cancelled = await self._cancel_request(cancel.request_id)
            return {"status": "cancelled" if cancelled else "unknown_request"}
        if envelope.method == "connection.test":
            Empty.model_validate(envelope.params)
            if self.backend is None or self.get_settings().ai_mode != "assistant":
                return {"status": "unavailable", "code": "inference_unavailable"}
            # Fixed supported Copilot capability, not a provider/plugin method registry.
            from sage.providers.copilot import CopilotReasoner

            if not isinstance(self.backend, CopilotReasoner):
                return {"status": "unavailable", "code": "inference_unavailable"}
            return (
                self.backend.readiness().model_dump(mode="json")
                if self.shutting_down
                else (await self.backend.connection_test()).model_dump(mode="json")
            )
        value = ReasoningInput.model_validate(envelope.params)
        settings = self.get_settings()
        if (
            self.backend is None
            or settings.ai_mode != "assistant"
            or settings.reasoning_backend != "copilot"
            or value.backend != "copilot"
        ):
            return {"status": "unavailable", "code": "inference_unavailable"}
        if self.backend.readiness().status in {"unavailable", "auth_required", "incompatible"}:
            return {"status": "unavailable", "code": "inference_unavailable"}
        now = self.clock()
        request = ReasoningRequest(
            request_id=envelope.id,
            task_id=uuid4().hex,
            user_text=value.user_text,
            attached_context=tuple(value.attached_context),
            backend=value.backend,
            model=value.model,
            deadline=now + timedelta(milliseconds=envelope.timeout_ms),
            cancellation_id=uuid4().hex,
        )
        entry = _Inference(request, self._generation)
        self._inflight[envelope.id] = entry
        stamp = now.isoformat(timespec="microseconds")
        with self.store.transaction() as db:
            db.execute(
                "INSERT INTO tasks (id,status,created_at,updated_at) VALUES (?,?,?,?)",
                (request.task_id, "reasoning", stamp, stamp),
            )
        try:
            result = ReasoningResult.model_validate(await self.backend.reason(request))
            now = self.clock()
            current = self._inflight.get(envelope.id)
            with self.store.transaction() as db:
                task = db.execute(
                    "SELECT status FROM tasks WHERE id=?", (request.task_id,)
                ).fetchone()
                revision = db.execute(
                    "SELECT 1 FROM revisions WHERE task_id=?", (request.task_id,)
                ).fetchone()
            # No await occurs from this authority check through trusted draft insertion.
            active_task = asyncio.current_task()
            valid = (
                current is entry
                and not entry.cancelled
                and not self.shutting_down
                and entry.generation == self._generation
                and now < request.deadline
                and self.get_settings() == settings
                and result.request_id == envelope.id
                and task is not None
                and task["status"] == "reasoning"
                and revision is None
                and not (active_task and active_task.cancelling())
            )
            if not valid:
                with self.store.transaction() as db:
                    db.execute(
                        "UPDATE tasks SET status='cancelled',updated_at=? "
                        "WHERE id=? AND status='reasoning'",
                        (now.isoformat(timespec="microseconds"), request.task_id),
                    )
                return {
                    "status": "cancelled",
                    "task_id": request.task_id,
                    "text": "",
                    "proposal": None,
                    "usage": None,
                }
            proposal = None
            if result.status == "completed" and result.proposal is not None:
                proposal = self.actions.complete_reasoning(request.task_id, result.proposal)
            else:
                status = {"completed": "completed", "error": "failed", "cancelled": "cancelled"}[
                    result.status
                ]
                with self.store.transaction() as db:
                    db.execute(
                        "UPDATE tasks SET status=?,updated_at=? WHERE id=? AND status='reasoning'",
                        (status, now.isoformat(timespec="microseconds"), request.task_id),
                    )
            return {
                "status": result.status,
                "task_id": request.task_id,
                "text": result.text,
                "proposal": proposal.model_dump(mode="json") if proposal else None,
                "usage": result.usage.model_dump(mode="json") if result.usage else None,
            }
        except asyncio.CancelledError:
            entry.cancelled = True
            with self.store.transaction() as db:
                db.execute(
                    "UPDATE tasks SET status='cancelled' WHERE id=? AND status='reasoning'",
                    (request.task_id,),
                )
            await self.backend.cancel(request.request_id)
            raise
        except Exception:
            with self.store.transaction() as db:
                db.execute(
                    "UPDATE tasks SET status='failed' WHERE id=? AND status='reasoning'",
                    (request.task_id,),
                )
            raise
        finally:
            self._inflight.pop(envelope.id, None)

    def _dispatch(self, envelope: Request) -> dict[str, object]:
        params = envelope.params
        match envelope.method:
            case "coding.get":
                return self.coding.get(CodeJobId.model_validate(params).job_id).model_dump(
                    mode="json"
                )
            case "coding.list":
                coding_page = CodePage.model_validate(params)
                return self.coding.list(coding_page.limit, coding_page.offset).model_dump(
                    mode="json"
                )
            case "coding.readiness":
                Empty.model_validate(params)
                return self.coding.readiness().model_dump(mode="json")
            case "settings.get":
                Empty.model_validate(params)
                with self.store.transaction() as db:
                    row = db.execute("SELECT data_json FROM settings WHERE id=1").fetchone()
                settings = Settings.model_validate_json(row[0]) if row else Settings()
                return settings.model_dump(mode="json")
            case "settings.update":
                settings = Settings.model_validate(params)
                with self.store.transaction() as db:
                    db.execute(
                        "INSERT INTO settings (id,data_json) VALUES (1,?) "
                        "ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
                        (settings.model_dump_json(),),
                    )
                return settings.model_dump(mode="json")
            case "readiness.list":
                Empty.model_validate(params)
                items: list[dict[str, object]] = [
                    {
                        "provider": provider,
                        "status": "unavailable",
                        "evidence": [],
                        "version": None,
                        "destination": None,
                        "explanation": "inference_unavailable",
                        "diagnostic": None,
                    }
                    for provider in ("copilot", "local", "api")
                ]
                if self.backend is not None:
                    items[0] = self.backend.readiness().model_dump(mode="json")
                return {"items": items}
            case "notes.propose":
                note = NoteContent.model_validate(params)
                return self.actions.propose_note(uuid4().hex, note.title, note.body).model_dump(
                    mode="json"
                )
            case "notes.revise":
                edit = RevisionInput.model_validate(params)
                self.store.cleanup(self.clock())
                return self.actions.revise_note(
                    edit.proposal_id, edit.revision, edit.title, edit.body
                ).model_dump(mode="json")
            case "notes.decide":
                decision = Decision.model_validate(params)
                self.store.cleanup(self.clock())
                return self.actions.decide(
                    decision.proposal_id, decision.revision, decision.decision
                ).model_dump(mode="json")
            case "notes.get":
                note_id = NoteId.model_validate(params)
                saved = self.store.get_note(note_id.note_id)
                if saved is None:
                    raise LookupError
                return saved.model_dump(mode="json")
            case "notes.list" | "notes.search":
                page = (
                    Search.model_validate(params)
                    if envelope.method == "notes.search"
                    else Page.model_validate(params)
                )
                query = page.query if isinstance(page, Search) else None
                items = self.store.note_summaries(page.limit + 1, page.offset, query)
                return self._page(items, page)
            case "tasks.list":
                page = Page.model_validate(params)
                self.store.cleanup(self.clock())
                return self._page(self.store.task_summaries(page.limit + 1, page.offset), page)
            case "tasks.get":
                task = TaskId.model_validate(params)
                self.store.cleanup(self.clock())
                detail = self.store.task_detail(task.task_id)
                if detail is None:
                    raise LookupError
                outcome = self.actions.get_outcome(task.task_id)
                detail["outcome"] = outcome.model_dump(mode="json") if outcome else None
                return detail
            case "tasks.cancel":
                task = TaskId.model_validate(params)
                self.store.cleanup(self.clock())
                return self.actions.cancel_task(task.task_id).model_dump(mode="json")
            case "app.shutdown":
                Empty.model_validate(params)
                self.shutting_down = True
                return {"status": "shutting_down"}
            case _:
                raise ValueError("Unknown method")

    @staticmethod
    def _page(items: list[dict[str, object]], page: Page) -> dict[str, object]:
        return {
            "items": items[: page.limit],
            "next_offset": page.offset + page.limit if len(items) > page.limit else None,
        }


class Writer(Protocol):
    def write(self, data: bytes) -> None: ...
    async def drain(self) -> None: ...
    def close(self) -> None: ...
    async def wait_closed(self) -> None: ...


async def run_service(reader: asyncio.StreamReader, writer: Writer, service: CoreService) -> None:
    """One connection, at most eight requests; cancellation invalidates late output.

    Coding start acknowledges a separately owned background job. Private coding
    control is main-only and never consumes renderer request capacity.
    This loop emits exactly one terminal frame per accepted request; children
    never write stdout themselves. No unbounded output/progress queue exists.
    """
    pending: dict[str, tuple[Request, asyncio.Task[None]]] = {}
    lock = asyncio.Lock()
    broken = False
    ready: set[str] = set()
    invalidated: dict[str, ErrorCode] = {}
    suppressed: set[str] = set()
    stopped = asyncio.Event()
    incoming: asyncio.Task[dict[str, object]] | None = None

    async def send(message: dict[str, object]) -> None:
        nonlocal broken
        if broken:
            return
        try:
            async with lock:
                writer.write(encode_frame(message))
                await asyncio.wait_for(writer.drain(), 5)
        except (OSError, TimeoutError, ProtocolError):
            broken = True
            stopped.set()
            diagnostic("transport_failed")

    async def execute(envelope: Request, message: dict[str, object]) -> None:
        deadline = asyncio.timeout(envelope.timeout_ms / 1000)
        try:
            async with deadline:
                response = await service.dispatch(message)
        except TimeoutError:
            response = failure(envelope.id, "timeout")
        except asyncio.CancelledError:
            response = failure(envelope.id, "cancelled")
        except Exception:
            diagnostic("request_failed")
            response = failure(envelope.id, "internal_error")
        if deadline.expired():
            response = failure(envelope.id, "timeout")
        if envelope.id in invalidated:
            response = failure(envelope.id, invalidated[envelope.id])
        # Only a closed, correctly correlated terminal envelope may reach the pipe.
        try:
            if response.get("id") != envelope.id or type(response.get("version")) is not int:
                raise ValueError
            schema = Response if response.get("kind") == "response" else Failure
            response = schema.model_validate(response).model_dump(mode="json")
        except (ValueError, ValidationError):
            response = failure(envelope.id, "internal_error")
        ready.add(envelope.id)
        try:
            if envelope.id not in suppressed:
                await send(response)
        finally:
            pending.pop(envelope.id, None)
            ready.discard(envelope.id)
            invalidated.pop(envelope.id, None)
            suppressed.discard(envelope.id)

    async def retention() -> None:
        while True:
            await asyncio.sleep(60)
            try:
                service.coding.expire()
                service.store.cleanup(service.clock())
            except Exception:
                diagnostic("retention_failed")

    cleanup = asyncio.create_task(retention())
    stop_waiter = asyncio.create_task(stopped.wait())
    try:
        while not broken and not service.shutting_down:
            try:
                incoming = asyncio.create_task(read_frame(reader))
                done, _ = await asyncio.wait(
                    (incoming, stop_waiter), return_when=asyncio.FIRST_COMPLETED
                )
                if stop_waiter in done:
                    break
                message = incoming.result()
            except EOFError:
                break
            except (ProtocolError, TimeoutError):
                await send(failure(None, "invalid_frame"))
                break
            if message.get("kind") == "host_coding":
                await send(await service.coding_control(message))
                continue
            if message.get("kind") == "host_copilot_selection":
                try:
                    await send(await service.select_account(message))
                except Exception:
                    await send(failure(None, "internal_error"))
                continue
            try:
                envelope = request(message)
            except ProtocolError:
                await send(failure(None, "invalid_request"))
                continue
            if envelope.id in pending:
                suppressed.add(envelope.id)
                pending[envelope.id][1].cancel()
                await send(failure(envelope.id, "duplicate_id"))
                break
            if envelope.method == "reasoning.cancel":
                try:
                    cancellation = Cancel.model_validate(envelope.params)
                except ValidationError:
                    await send(await service.dispatch(message))
                    continue
                target = pending.get(cancellation.request_id)
                response = await service.dispatch(message)
                if (
                    response.get("kind") == "response"
                    and target is not None
                    and target[0].method == "reasoning.start"
                ):
                    invalidated[cancellation.request_id] = "cancelled"
                    target[1].cancel()
                    response = Response(id=envelope.id, result={"status": "cancelled"}).model_dump(
                        mode="json"
                    )
                await send(response)
                continue
            if len(pending) >= 8:
                await send(failure(envelope.id, "busy"))
                break
            task = asyncio.create_task(execute(envelope, message))
            pending[envelope.id] = (envelope, task)
            # Give shutdown and local effects their ordering point before the next read.
            await asyncio.sleep(0)
    finally:
        # Revoke authority before any public/provider cleanup can suspend on EOF or failure.
        service.shutting_down = True
        try:
            service.coding.interrupt()
        except Exception:
            diagnostic("request_failed")
        for identifier, (_, task) in list(pending.items()):
            if identifier not in ready:
                invalidated.setdefault(identifier, "cancelled")
                task.cancel()
        cleanup.cancel()
        stop_waiter.cancel()
        if incoming is not None:
            incoming.cancel()
        note_owner = service.backend
        settled = await asyncio.gather(
            _settle_owners(service.coding.aclose(), note_owner),
            *(task for _, task in list(pending.values())),
            cleanup,
            stop_waiter,
            *((incoming,) if incoming is not None else ()),
            return_exceptions=True,
        )
        if service.backend is note_owner:
            service.backend = None
        if isinstance(settled[0], BaseException):
            diagnostic("request_failed")
        writer.close()
        try:
            await asyncio.wait_for(writer.wait_closed(), 5)
        except (OSError, TimeoutError):
            diagnostic("transport_failed")
