"""A late model result cannot insert a draft after authority changed."""

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from sage.actions import ActionService
from sage.contracts import NoteContent, ProviderReadiness, ReasoningRequest, ReasoningResult
from sage.service import CoreService
from sage.storage import Store


class DeferredBackend:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.finish = asyncio.Event()
        self.requests: list[ReasoningRequest] = []
        self.cancelled: list[str] = []
        self.closed = False
        self.wrong_identity = False

    def readiness(self) -> ProviderReadiness:
        return ProviderReadiness(provider="copilot", status="ready", explanation="synthetic")

    async def reason(self, request: ReasoningRequest) -> ReasoningResult:
        self.requests.append(request)
        self.started.set()
        try:
            await self.finish.wait()
        except asyncio.CancelledError:
            await self.finish.wait()  # simulate a cancellation-insensitive remote completion
        return ReasoningResult(
            request_id="wrong" if self.wrong_identity else request.request_id,
            status="completed",
            text="ordinary private text",
            proposal=NoteContent(title="draft", body="review private text"),
        )

    async def cancel(self, request_id: str) -> None:
        self.cancelled.append(request_id)

    async def aclose(self) -> None:
        self.closed = True


def rpc(identifier: str, method: str, params: dict[str, Any]) -> dict[str, object]:
    return {"version": 1, "id": identifier, "kind": "request", "method": method, "params": params}


@pytest.mark.parametrize("state", ["cancelled", "interrupted", "pending", "succeeded"])
def test_complete_reasoning_rejects_wrong_state(tmp_path: Path, state: str) -> None:
    store = Store.open(tmp_path / "store.sqlite")
    now = datetime.now(UTC)
    actions = ActionService(store, lambda: now, "boot")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO tasks VALUES (?,?,?,?)", ("task", state, now.isoformat(), now.isoformat())
        )
    with pytest.raises(ValueError):
        actions.complete_reasoning("task", NoteContent(title="draft", body="body"))
    with store.transaction() as db:
        assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM approvals").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0
    store.close()


def test_complete_reasoning_creates_review_only_and_rejects_duplicate(tmp_path: Path) -> None:
    store = Store.open(tmp_path / "store.sqlite")
    now = datetime.now(UTC)
    actions = ActionService(store, lambda: now, "boot")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO tasks VALUES (?,?,?,?)",
            ("task", "reasoning", now.isoformat(), now.isoformat()),
        )
    proposal = actions.complete_reasoning("task", NoteContent(title="draft", body="body"))
    assert proposal.task_id == "task" and proposal.revision == 1
    with pytest.raises(ValueError):
        actions.complete_reasoning("task", NoteContent(title="other", body="other"))
    with store.transaction() as db:
        assert db.execute("SELECT status FROM tasks").fetchone()[0] == "pending"
        assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM approvals").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM operations").fetchone()[0] == 0
    store.close()


@pytest.mark.parametrize(
    "invalidate", ["cancel", "task_cancel", "deadline", "identity", "settings", "shutdown"]
)
def test_late_result_has_no_proposal_side_effect(tmp_path: Path, invalidate: str) -> None:
    async def run() -> None:
        store = Store.open(tmp_path / "store.sqlite")
        backend = DeferredBackend()
        now = datetime.now(UTC)
        times = [now]
        service = CoreService(store, clock=lambda: times[0], backend=backend)
        await service.dispatch(
            rpc(
                "settings",
                "settings.update",
                {"ai_mode": "assistant", "reasoning_backend": "copilot"},
            )
        )
        pending = asyncio.create_task(
            service.dispatch(
                rpc(
                    "reason",
                    "reasoning.start",
                    {"backend": "copilot", "user_text": "private input"},
                )
            )
        )
        await backend.started.wait()
        task_id = backend.requests[0].task_id
        if invalidate == "cancel":
            await service.dispatch(rpc("cancel", "reasoning.cancel", {"request_id": "reason"}))
        elif invalidate == "task_cancel":
            await service.dispatch(rpc("cancel", "tasks.cancel", {"task_id": task_id}))
        elif invalidate == "deadline":
            times[0] += timedelta(seconds=31)
        elif invalidate == "identity":
            backend.wrong_identity = True
        elif invalidate == "settings":
            await service.dispatch(rpc("local", "settings.update", {}))
        elif invalidate == "shutdown":
            await service.dispatch(rpc("shutdown", "app.shutdown", {}))
        backend.finish.set()
        result = await pending
        assert result.get("kind") in {"response", "error"}
        with store.transaction() as db:
            assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM approvals").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0
        await service.aclose()
        assert backend.closed

    asyncio.run(run())


def test_service_normal_completion_keeps_only_review_data(tmp_path: Path) -> None:
    async def run() -> None:
        store = Store.open(tmp_path / "store.sqlite")
        backend = DeferredBackend()
        backend.finish.set()
        service = CoreService(store, backend=backend)
        await service.dispatch(
            rpc(
                "settings",
                "settings.update",
                {"ai_mode": "assistant", "reasoning_backend": "copilot"},
            )
        )
        result = await service.dispatch(
            rpc("reason", "reasoning.start", {"backend": "copilot", "user_text": "private input"})
        )
        data: Any = result["result"]
        assert data["status"] == "completed"
        assert data["proposal"]["arguments"] == {"title": "draft", "body": "review private text"}
        assert data["task_id"] == backend.requests[0].task_id
        with store.transaction() as db:
            assert db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM operations").fetchone()[0] == 0
            rows = list(db.execute("SELECT * FROM tasks"))
            assert len(rows) == 1 and rows[0]["status"] == "pending"
        await service.aclose()

    asyncio.run(run())


def test_read_path_clock_highwater_invalidates_later_save(tmp_path: Path) -> None:
    async def run() -> None:
        now = datetime.now(UTC)
        current = [now]
        store = Store.open(tmp_path / "store.sqlite")
        service = CoreService(store, clock=lambda: current[0])
        proposal: Any = (
            await service.dispatch(rpc("p", "notes.propose", {"title": "draft", "body": "body"}))
        )["result"]
        current[0] += timedelta(minutes=2)
        await service.dispatch(rpc("read", "settings.get", {}))
        current[0] -= timedelta(minutes=1)
        saved: Any = (
            await service.dispatch(
                rpc(
                    "save",
                    "notes.decide",
                    {"proposal_id": proposal["id"], "revision": 1, "decision": "save"},
                )
            )
        )["result"]
        assert saved["status"] == "rejected"
        with store.transaction() as db:
            assert db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0
        service.close()

    asyncio.run(run())


@pytest.mark.parametrize("cancel_request", [False, True])
def test_stale_inference_preserves_current_review_revision(
    tmp_path: Path, cancel_request: bool
) -> None:
    async def run() -> None:
        store = Store.open(tmp_path / "store.sqlite")
        backend = DeferredBackend()
        service = CoreService(store, backend=backend)
        await service.dispatch(
            rpc(
                "settings",
                "settings.update",
                {"ai_mode": "assistant", "reasoning_backend": "copilot"},
            )
        )
        pending = asyncio.create_task(
            service.dispatch(
                rpc("reason", "reasoning.start", {"backend": "copilot", "user_text": "input"})
            )
        )
        await backend.started.wait()
        task_id = backend.requests[0].task_id
        existing = service.actions.complete_reasoning(
            task_id, NoteContent(title="current", body="current body")
        )
        edited = service.actions.revise_note(existing.id, 1, "edited", "edited body")
        if cancel_request:
            await service.dispatch(rpc("cancel", "reasoning.cancel", {"request_id": "reason"}))
        backend.finish.set()
        await pending
        detail = store.task_detail(task_id)
        assert detail is not None and detail["status"] == "pending"
        proposal: Any = detail["proposal"]
        assert proposal["id"] == edited.id and proposal["revision"] == 2
        assert proposal["arguments"] == {"title": "edited", "body": "edited body"}
        with store.transaction() as db:
            assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 2
            assert db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0
        await service.aclose()

    asyncio.run(run())


def test_backend_crash_leaves_failed_metadata_without_private_text(tmp_path: Path) -> None:
    async def run() -> None:
        class Crashed(DeferredBackend):
            async def reason(self, request: ReasoningRequest) -> ReasoningResult:
                raise OSError("private input and provider failure")

        store = Store.open(tmp_path / "store.sqlite")
        service = CoreService(store, backend=Crashed())
        await service.dispatch(
            rpc(
                "settings",
                "settings.update",
                {"ai_mode": "assistant", "reasoning_backend": "copilot"},
            )
        )
        result = await service.dispatch(
            rpc("reason", "reasoning.start", {"backend": "copilot", "user_text": "private input"})
        )
        assert result == {"version": 1, "id": "reason", "kind": "error", "code": "internal_error"}
        with store.transaction() as db:
            assert db.execute("SELECT status FROM tasks").fetchone()[0] == "failed"
            assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 0
        await service.aclose()

    asyncio.run(run())


def test_core_cancellation_discards_swallowed_response(tmp_path: Path) -> None:
    async def run() -> None:
        store = Store.open(tmp_path / "store.sqlite")
        backend = DeferredBackend()
        service = CoreService(store, backend=backend)
        await service.dispatch(
            rpc(
                "settings",
                "settings.update",
                {"ai_mode": "assistant", "reasoning_backend": "copilot"},
            )
        )
        pending = asyncio.create_task(
            service.dispatch(
                rpc("reason", "reasoning.start", {"backend": "copilot", "user_text": "input"})
            )
        )
        await backend.started.wait()
        pending.cancel()
        await asyncio.sleep(0)
        backend.finish.set()
        result: Any = (await pending)["result"]
        assert result["status"] == "cancelled" and result["proposal"] is None
        with store.transaction() as db:
            assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM approvals").fetchone()[0] == 0
        await service.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("phase", ["update", "commit"])
def test_clock_invalidation_survives_real_failure_and_catchup(tmp_path: Path, phase: str) -> None:
    async def run() -> None:
        now = datetime.now(UTC)
        current = [now]
        store = Store.open(tmp_path / "store.sqlite")
        service = CoreService(store, clock=lambda: current[0])
        proposal: Any = (
            await service.dispatch(rpc("p", "notes.propose", {"title": "draft", "body": "body"}))
        )["result"]
        current[0] += timedelta(minutes=2)
        await service.dispatch(rpc("high", "settings.get", {}))
        with store.transaction() as db:
            db.execute(
                "CREATE TABLE clock_fault (task_id TEXT REFERENCES tasks(id) "
                "DEFERRABLE INITIALLY DEFERRED)"
            )
            statement = (
                "INSERT INTO clock_fault VALUES ('missing-task')"
                if phase == "commit"
                else "SELECT RAISE(ABORT, 'synthetic clock write failure')"
            )
            db.execute(
                "CREATE TRIGGER fail_clock_commit AFTER UPDATE OF expires_at ON approvals "
                f"BEGIN {statement}; END"
            )
        current[0] -= timedelta(minutes=1)
        failure = await service.dispatch(rpc("low", "settings.get", {}))
        assert failure["kind"] == "error" and failure["code"] == "internal_error"
        with store.transaction() as db:
            db.execute("DROP TRIGGER fail_clock_commit")
            assert db.execute("SELECT COUNT(*) FROM clock_fault").fetchone()[0] == 0
        current[0] = now + timedelta(minutes=3)
        outcome: Any = (
            await service.dispatch(
                rpc(
                    "save",
                    "notes.decide",
                    {"proposal_id": proposal["id"], "revision": 1, "decision": "save"},
                )
            )
        )["result"]
        assert outcome["status"] == "rejected"
        with store.transaction() as db:
            assert db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0
        current[0] = now + timedelta(minutes=1)
        revised: Any = (
            await service.dispatch(
                rpc(
                    "revise",
                    "notes.revise",
                    {
                        "proposal_id": proposal["id"],
                        "revision": 1,
                        "title": "fresh",
                        "body": "fresh body",
                    },
                )
            )
        )["result"]
        fresh: Any = (
            await service.dispatch(
                rpc(
                    "freshsave",
                    "notes.decide",
                    {"proposal_id": revised["id"], "revision": 2, "decision": "save"},
                )
            )
        )["result"]
        assert fresh["status"] == "succeeded"
        service.close()

    asyncio.run(run())
