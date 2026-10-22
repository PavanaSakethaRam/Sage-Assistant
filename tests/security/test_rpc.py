"""The private RPC accepts only closed requests and never renderer authority."""

import asyncio
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest

from sage.protocol import encode_frame, read_frame
from sage.service import CoreService, run_service
from sage.storage import Store


def request(identifier: str, method: str, **params: object) -> dict[str, object]:
    return {"version": 1, "id": identifier, "kind": "request", "method": method, "params": params}


@pytest.fixture
def core(tmp_path: Path) -> Iterator[CoreService]:
    store = Store.open(tmp_path / "state.sqlite3")
    service = CoreService(store)
    try:
        yield service
    finally:
        service.close()


def dispatch(core: CoreService, message: dict[str, object]) -> dict[str, object]:
    return asyncio.run(core.dispatch(message))


def result(response: dict[str, object]) -> dict[str, object]:
    assert response["kind"] == "response", response
    return cast(dict[str, object], response["result"])


@pytest.mark.parametrize(
    "change",
    [
        {"version": 2},
        {"version": True},
        {"id": ""},
        {"id": "x\nbody"},
        {"id": 1},
        {"kind": "response"},
        {"kind": "progress"},
        {"kind": "unknown"},
        {"extra": "secret"},
        {"method": "shell.run"},
        {"params": {"approval": {}}},
        {"params": {"limit": True}},
        {"params": {"limit": 0}},
        {"params": {"limit": 101}},
    ],
)
def test_invalid_request_never_invokes_actions(
    core: CoreService, change: dict[str, object]
) -> None:
    message = request("invalid", "notes.list") | change
    assert dispatch(core, message)["kind"] == "error"
    assert core.store.list_notes() == []
    with core.store.transaction() as db:
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0


def test_missing_fields_and_duplicate_ids_are_rejected(core: CoreService) -> None:
    for index, field in enumerate(["version", "id", "kind", "method", "params"]):
        message = request(f"missing-{index}", "settings.get")
        del message[field]
        assert dispatch(core, message)["kind"] == "error"
    message = request("once", "notes.propose", title="Title", body="Body")
    proposal = result(dispatch(core, message))
    assert dispatch(core, message)["code"] == "duplicate_id"
    assert result(dispatch(core, request("list", "tasks.list")))["items"]
    assert "approval" not in json.dumps(proposal)


def test_settings_and_unavailable_inference_are_explicit(core: CoreService) -> None:
    assert result(dispatch(core, request("default", "settings.get")))["ai_mode"] == "local"
    assert (
        dispatch(
            core, request("bad", "settings.update", ai_mode="local", reasoning_backend="copilot")
        )["kind"]
        == "error"
    )
    changed = result(
        dispatch(
            core,
            request("set", "settings.update", ai_mode="assistant", reasoning_backend="copilot"),
        )
    )
    assert changed == {"ai_mode": "assistant", "reasoning_backend": "copilot"}
    assert result(dispatch(core, request("test", "connection.test")))["status"] == "unavailable"
    assert result(dispatch(core, request("readiness", "readiness.list")))["items"]
    assert (
        result(
            dispatch(
                core, request("start", "reasoning.start", user_text="hello", backend="copilot")
            )
        )["status"]
        == "unavailable"
    )
    with core.store.transaction() as db:
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0


@pytest.mark.parametrize(
    "params",
    [
        {"user_text": "a" * 32_001, "backend": "copilot"},
        {"user_text": "hello\0", "backend": "copilot"},
        {"user_text": "hello", "backend": "copilot", "attached_context": ["x" * 64_001]},
        {"user_text": "hello", "backend": "shell"},
        {"user_text": "hello", "backend": "copilot", "prompt": "injected"},
    ],
)
def test_reasoning_input_bounds(core: CoreService, params: dict[str, object]) -> None:
    assert dispatch(core, request("bad-reason", "reasoning.start", **params))["kind"] == "error"


def test_note_review_recovery_and_literal_paged_reads(core: CoreService) -> None:
    body = "😀" * 100_000
    ids: list[str] = []
    for index in range(3):
        proposal = result(
            dispatch(core, request(f"p{index}", "notes.propose", title=" literal é ", body=body))
        )
        task_id = cast(str, proposal["task_id"])
        detail = result(dispatch(core, request(f"t{index}", "tasks.get", task_id=task_id)))
        assert detail["review_required"] is True
        assert cast(dict[str, object], detail["proposal"])["arguments"] == {
            "title": " literal é ",
            "body": body,
        }
        outcome = result(
            dispatch(
                core,
                request(
                    f"s{index}",
                    "notes.decide",
                    proposal_id=proposal["id"],
                    revision=proposal["revision"],
                    decision="save",
                ),
            )
        )
        assert outcome["status"] == "succeeded"
        ids.append(cast(str, outcome["note_id"]))
    page = result(dispatch(core, request("page", "notes.list", limit=2, offset=0)))
    assert len(cast(list[object], page["items"])) == 2
    assert page["next_offset"] == 2
    assert "body" not in json.dumps(page)
    assert len(encode_frame(page)) < 10_000
    page2 = result(
        dispatch(core, request("page2", "notes.search", query="literal", limit=2, offset=2))
    )
    assert len(cast(list[object], page2["items"])) == 1
    assert page2["next_offset"] is None
    for index, identifier in enumerate(ids):
        note = result(dispatch(core, request(f"g{index}", "notes.get", note_id=identifier)))
        assert note["body"] == body
        assert len(encode_frame(note)) < 1_048_580
    core.store.cleanup(datetime.now(UTC) + timedelta(hours=24))
    detail = result(dispatch(core, request("recover", "tasks.get", task_id=task_id)))
    assert detail["proposal"] is None
    assert cast(dict[str, object], detail["outcome"])["status"] == "succeeded"


def test_revise_cancel_scrub_and_restart_review(core: CoreService) -> None:
    proposal = result(dispatch(core, request("p", "notes.propose", title="Old", body="Private")))
    restarted = CoreService(core.store)
    try:
        assert (
            result(
                dispatch(
                    restarted,
                    request(
                        "old",
                        "notes.decide",
                        proposal_id=proposal["id"],
                        revision=1,
                        decision="save",
                    ),
                )
            )["status"]
            == "rejected"
        )
        revised = result(
            dispatch(
                restarted,
                request(
                    "edit",
                    "notes.revise",
                    proposal_id=proposal["id"],
                    revision=1,
                    title="New",
                    body="Private",
                ),
            )
        )
        assert revised["id"] != proposal["id"]
        assert revised["revision"] == 2
        assert (
            result(
                dispatch(restarted, request("cancel", "tasks.cancel", task_id=proposal["task_id"]))
            )["status"]
            == "cancelled"
        )
        detail = result(
            dispatch(restarted, request("get", "tasks.get", task_id=proposal["task_id"]))
        )
        assert detail["proposal"] is None
        assert detail["review_required"] is False
    finally:
        # Store lifetime remains owned by the fixture's original core.
        pass


def test_unknown_records_and_authority_fields_fail_closed(core: CoreService) -> None:
    assert (
        dispatch(core, request("missing-note", "notes.get", note_id="missing"))["code"]
        == "not_found"
    )
    assert (
        dispatch(core, request("missing-task", "tasks.get", task_id="missing"))["code"]
        == "not_found"
    )
    assert (
        dispatch(
            core,
            request(
                "authority",
                "notes.decide",
                proposal_id="x",
                revision=1,
                decision="save",
                approval={"decision": "approved"},
            ),
        )["code"]
        == "invalid_request"
    )


class Writer:
    def __init__(self, *, broken: bool = False) -> None:
        self.data = bytearray()
        self.closed = False
        self.broken = broken

    def write(self, data: bytes) -> None:
        if self.broken:
            raise BrokenPipeError("CREDENTIAL_SECRET")
        self.data.extend(data)

    async def drain(self) -> None:
        await asyncio.sleep(0)

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None


async def responses(writer: Writer) -> list[dict[str, object]]:
    reader = asyncio.StreamReader()
    reader.feed_data(writer.data)
    reader.feed_eof()
    found = []
    while True:
        try:
            found.append(await read_frame(reader))
        except EOFError:
            return found


def test_run_service_closed_kinds_and_broken_pipe(core: CoreService) -> None:
    async def run() -> None:
        for broken in (False, True):
            reader = asyncio.StreamReader()
            reader.feed_data(encode_frame(request("r", "settings.get") | {"kind": "response"}))
            reader.feed_eof()
            writer = Writer(broken=broken)
            await run_service(reader, writer, core)
            assert writer.closed
            if not broken:
                assert (await responses(writer))[0]["kind"] == "error"

    asyncio.run(run())


def test_sensitive_markers_absent_from_errors_and_logs(
    core: CoreService, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(limit: int, offset: int, query: str | None = None) -> list[dict[str, object]]:
        raise RuntimeError("PROVIDER_BODY SECRET_CREDENTIAL PROMPT_MARKER")

    monkeypatch.setattr(core.store, "note_summaries", fail)
    response = dispatch(core, request("safe", "notes.list"))
    assert response["code"] == "internal_error"
    captured = capsys.readouterr()
    assert captured.out == ""
    for marker in ["PROVIDER_BODY", "SECRET_CREDENTIAL", "PROMPT_MARKER"]:
        assert marker not in json.dumps(response) + captured.err


def test_transport_deadline_cancel_and_late_completion(tmp_path: Path) -> None:
    """A cancellation-insensitive completion must not become successful output."""

    class Delayed(CoreService):
        async def dispatch(self, message: dict[str, object]) -> dict[str, object]:
            if message.get("method") == "reasoning.start":
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    # Model a provider completing just after timeout/cancellation.
                    return {
                        "version": 1,
                        "id": message["id"],
                        "kind": "response",
                        "result": {"text": "LATE_PRIVATE_BODY"},
                    }
            return await super().dispatch(message)

    async def run(cancel: bool) -> None:
        service = Delayed(Store.open(tmp_path / f"late-{cancel}.sqlite3"))
        reader = asyncio.StreamReader()
        writer = Writer()
        start = request("work", "reasoning.start", user_text="hello", backend="copilot")
        start["timeout_ms"] = 1
        reader.feed_data(encode_frame(start))
        running = asyncio.create_task(run_service(reader, writer, service))
        if cancel:
            # Wait on task scheduling, never wall-clock sleep or provider I/O.
            for _ in range(10):
                await asyncio.sleep(0)
            reader.feed_data(encode_frame(request("cancel", "reasoning.cancel", request_id="work")))
        for _ in range(1000):
            await asyncio.sleep(0)
            if writer.data:
                break
        reader.feed_eof()
        await asyncio.wait_for(running, 2)
        found = await responses(writer)
        original = [item for item in found if item["id"] == "work"]
        assert len(original) == 1
        assert original[0]["code"] == ("cancelled" if cancel else "timeout")
        assert "LATE_PRIVATE_BODY" not in writer.data.decode()
        service.close()

    asyncio.run(run(False))
    asyncio.run(run(True))


def test_transport_inflight_bound_and_eof_cancels_work(tmp_path: Path) -> None:
    class Delayed(CoreService):
        active = 0
        maximum = 0
        cancelled = 0

        async def dispatch(self, message: dict[str, object]) -> dict[str, object]:
            self.active += 1
            self.maximum = max(self.maximum, self.active)
            try:
                await asyncio.Event().wait()
                raise AssertionError("Unreachable")
            finally:
                self.active -= 1
                self.cancelled += 1

    async def run() -> None:
        service = Delayed(Store.open(tmp_path / "bounded.sqlite3"))
        reader = asyncio.StreamReader()
        writer = Writer()
        for index in range(9):
            reader.feed_data(encode_frame(request(f"work{index}", "settings.get")))
        reader.feed_eof()
        await asyncio.wait_for(run_service(reader, writer, service), 2)
        assert service.maximum == 8
        assert service.active == 0
        assert service.cancelled == 8
        assert any(item.get("code") == "busy" for item in await responses(writer))
        service.close()

    asyncio.run(run())


def test_transport_rejects_duplicate_active_id_once(tmp_path: Path) -> None:
    class Delayed(CoreService):
        async def dispatch(self, message: dict[str, object]) -> dict[str, object]:
            await asyncio.Event().wait()
            raise AssertionError("Unreachable")

    async def run() -> None:
        service = Delayed(Store.open(tmp_path / "duplicate.sqlite3"))
        reader = asyncio.StreamReader()
        writer = Writer()
        message = request("same", "reasoning.start", user_text="hello", backend="copilot")
        reader.feed_data(encode_frame(message) * 2)
        reader.feed_eof()
        await asyncio.wait_for(run_service(reader, writer, service), 2)
        found = await responses(writer)
        assert len(found) == 1
        assert found[0]["code"] == "duplicate_id"
        service.close()

    asyncio.run(run())


def test_get_outcome_is_read_only_and_validates_corruption(core: CoreService) -> None:
    proposal = result(dispatch(core, request("p", "notes.propose", title="Title", body="Body")))
    saved = result(
        dispatch(
            core,
            request("s", "notes.decide", proposal_id=proposal["id"], revision=1, decision="save"),
        )
    )
    core.store.cleanup(datetime.now(UTC) + timedelta(hours=24))
    before = []
    with core.store.transaction() as db:
        for table in ("notes", "approvals", "operations"):
            before.append(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
    recovered = core.actions.get_outcome(cast(str, proposal["task_id"]))
    assert recovered is not None
    assert recovered.note_id == saved["note_id"]
    with core.store.transaction() as db:
        after = [
            db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in ("notes", "approvals", "operations")
        ]
        db.execute("UPDATE approvals SET arguments_hash=?", ("0" * 64,))
    assert after == before == [1, 1, 1]
    assert core.actions.get_outcome(cast(str, proposal["task_id"])) is None
    assert core.actions.get_outcome("missing") is None


def test_startup_interrupts_only_actual_inference_metadata(tmp_path: Path) -> None:
    store = Store.open(tmp_path / "startup.sqlite3")
    stamp = datetime.now(UTC).isoformat(timespec="microseconds")
    with store.transaction() as db:
        for identifier, status in [("started", "reasoning"), ("done", "succeeded")]:
            db.execute(
                "INSERT INTO tasks (id,status,created_at,updated_at) VALUES (?,?,?,?)",
                (identifier, status, stamp, stamp),
            )
    service = CoreService(store)
    assert (
        result(dispatch(service, request("get", "tasks.get", task_id="started")))["status"]
        == "interrupted"
    )
    assert (
        result(dispatch(service, request("done", "tasks.get", task_id="done")))["status"]
        == "succeeded"
    )
    service.close()


def test_closed_service_and_request_session_memory_bound(core: CoreService) -> None:
    for index in range(4096):
        response = dispatch(core, request(f"r{index}", "connection.test"))
        assert response["kind"] == "response"
    assert dispatch(core, request("overflow", "connection.test"))["code"] == "session_limit"
    fresh = CoreService(core.store)
    fresh.shutting_down = True
    assert (
        dispatch(fresh, request("closed", "notes.propose", title="X", body="Y"))["code"]
        == "shutting_down"
    )


def test_async_broken_drain_wakes_idle_reader(core: CoreService) -> None:
    async def run() -> None:
        gate = asyncio.Event()

        class BrokenDrain(Writer):
            async def drain(self) -> None:
                await gate.wait()
                raise BrokenPipeError("SYNTHETIC_SECRET")

        reader = asyncio.StreamReader()
        reader.feed_data(encode_frame(request("r", "settings.get")))
        writer = BrokenDrain()
        running = asyncio.create_task(run_service(reader, writer, core))
        for _ in range(10):
            await asyncio.sleep(0)
        gate.set()
        await asyncio.wait_for(running, 1)
        assert writer.closed

    asyncio.run(run())


def test_transport_rejects_uncorrelated_or_open_response(tmp_path: Path) -> None:
    class InvalidResponse(CoreService):
        async def dispatch(self, message: dict[str, object]) -> dict[str, object]:
            return {
                "version": 1,
                "kind": "response",
                "id": message["id"],
                "result": {},
                "unknown": "SYNTHETIC_SECRET",
            }

    async def run() -> None:
        service = InvalidResponse(Store.open(tmp_path / "response.sqlite3"))
        reader = asyncio.StreamReader()
        reader.feed_data(encode_frame(request("r", "settings.get")))
        reader.feed_eof()
        writer = Writer()
        await run_service(reader, writer, service)
        found = await responses(writer)
        assert found[0]["code"] == "internal_error"
        assert b"SYNTHETIC_SECRET" not in writer.data
        service.close()

    asyncio.run(run())


def test_runtime_retention_scrubs_drafts_and_redacts_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def run() -> None:
        now = [datetime.now(UTC)]
        service = CoreService(Store.open(tmp_path / "retention.sqlite3"), clock=lambda: now[0])
        proposal = service.actions.propose_note("retained", "Title", "Private body")
        tick = asyncio.Event()
        original_sleep = asyncio.sleep

        async def sleep(delay: float) -> None:
            if delay == 60:
                await tick.wait()
                tick.clear()
            await original_sleep(0)

        monkeypatch.setattr(asyncio, "sleep", sleep)
        reader = asyncio.StreamReader()
        writer = Writer()
        running = asyncio.create_task(run_service(reader, writer, service))
        for _ in range(10):
            await original_sleep(0)
        now[0] += timedelta(hours=24)
        tick.set()
        for _ in range(20):
            await original_sleep(0)
        detail = service.store.task_detail(proposal.task_id)
        assert detail is not None and detail["proposal"] is None

        def fail(now: datetime) -> None:
            raise RuntimeError("SYNTHETIC_SECRET")

        monkeypatch.setattr(service.store, "cleanup", fail)
        tick.set()
        for _ in range(20):
            await original_sleep(0)
        reader.feed_eof()
        await running
        service.close()

    asyncio.run(run())
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "retention_failed\n"


@pytest.mark.parametrize("mode", ["timeout", "exception", "uncorrelated"])
def test_transport_terminal_failures_are_safe(
    core: CoreService, mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def dispatch(message: dict[str, object]) -> dict[str, object]:
        if mode == "timeout":
            raise TimeoutError("SYNTHETIC_SECRET")
        if mode == "exception":
            raise RuntimeError("SYNTHETIC_SECRET")
        return {"version": 1, "id": "unknown", "kind": "response", "result": {}}

    monkeypatch.setattr(core, "dispatch", dispatch)

    async def run() -> None:
        reader = asyncio.StreamReader()
        reader.feed_data(encode_frame(request("r", "settings.get")))
        reader.feed_eof()
        writer = Writer()
        await run_service(reader, writer, core)
        response = (await responses(writer))[0]
        assert response["code"] == ("timeout" if mode == "timeout" else "internal_error")
        assert b"SYNTHETIC_SECRET" not in writer.data

    asyncio.run(run())


def test_cancel_only_targets_live_reasoning(core: CoreService) -> None:
    async def run() -> None:
        reader = asyncio.StreamReader()
        for message in [
            request("missing", "reasoning.cancel", request_id="unknown"),
            request("bad", "reasoning.cancel", extra="bad"),
            request("again", "reasoning.cancel", request_id="unknown"),
        ]:
            reader.feed_data(encode_frame(message))
        reader.feed_eof()
        writer = Writer()
        await run_service(reader, writer, core)
        found = await responses(writer)
        assert found[0]["result"] == {"status": "unknown_request"}
        assert found[1]["code"] == "invalid_request"
        assert found[2]["result"] == {"status": "unknown_request"}

    asyncio.run(run())


def test_framing_failure_closes_connection(core: CoreService) -> None:
    async def run() -> None:
        reader = asyncio.StreamReader()
        reader.feed_data((1_048_577).to_bytes(4, "big"))
        writer = Writer()
        await run_service(reader, writer, core)
        assert (await responses(writer))[0]["code"] == "invalid_frame"
        assert writer.closed

    asyncio.run(run())


def test_reasoning_valid_context_and_local_settings_survive_reopen(core: CoreService) -> None:
    assert (
        result(
            dispatch(
                core,
                request(
                    "reason",
                    "reasoning.start",
                    backend="copilot",
                    user_text="hello",
                    attached_context=["explicit\ncontext"],
                ),
            )
        )["status"]
        == "unavailable"
    )
    dispatch(
        core, request("change", "settings.update", ai_mode="assistant", reasoning_backend="copilot")
    )
    assert (
        result(dispatch(core, request("get-change", "settings.get")))["reasoning_backend"]
        == "copilot"
    )
    assert result(dispatch(core, request("empty-search", "notes.search", query="")))["items"] == []


@pytest.mark.parametrize(
    "method,params",
    [
        ("notes.search", {"query": "bad\0query"}),
        ("notes.search", {"query": "bad\x01query"}),
    ],
)
def test_search_rejects_controls(core: CoreService, method: str, params: dict[str, object]) -> None:
    assert dispatch(core, request("search-control", method, **params))["code"] == "invalid_request"


def test_owner_cancellation_discards_late_completion(tmp_path: Path) -> None:
    class Late(CoreService):
        async def dispatch(self, message: dict[str, object]) -> dict[str, object]:
            try:
                await asyncio.Event().wait()
                raise AssertionError("No completion before cancellation")
            except asyncio.CancelledError:
                return {
                    "version": 1,
                    "id": message["id"],
                    "kind": "response",
                    "result": {"text": "LATE_PRIVATE_BODY"},
                }

    async def run() -> None:
        service = Late(Store.open(tmp_path / "owner-cancel.sqlite3"))
        reader = asyncio.StreamReader()
        reader.feed_data(
            encode_frame(request("r", "reasoning.start", user_text="x", backend="copilot"))
        )
        writer = Writer()
        running = asyncio.create_task(run_service(reader, writer, service))
        for _ in range(10):
            await asyncio.sleep(0)
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running
        assert b"LATE_PRIVATE_BODY" not in writer.data
        assert writer.closed
        service.close()

    asyncio.run(run())
