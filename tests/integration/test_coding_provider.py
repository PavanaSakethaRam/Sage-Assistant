"""Owned coding work acknowledges immediately and never authorizes effects."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

import pytest

from sage.coding_contracts import CodeContext, CodeStart, context_hash, disclosure_hash
from sage.config import Settings
from sage.service import CoreService
from sage.storage import Store
from tests.helpers.coding_fake import make_context, make_proposal


def envelope(method: str, params: dict[str, Any], identifier: str = "rpc") -> dict[str, object]:
    return {"version": 1, "kind": "request", "id": identifier, "method": method, "params": params}


def capture(core: CoreService) -> CodeStart:
    context = CodeContext.model_validate(make_context())
    context = context.model_copy(update={"context_hash": context_hash(context)})
    view = core.coding.accept_context(context)
    draft = {
        "job_id": "job-1",
        "revision": 1,
        "account_generation": view.account_generation,
        "user_text": "PRIVATE_PROMPT",
        "backend": "copilot",
        "model": view.model,
    }
    return CodeStart.model_validate({**draft, "disclosure_hash": disclosure_hash(view, draft)})


def test_local_only_start_returns_failed_source_free_job(tmp_path: Path) -> None:
    async def run() -> None:
        core = CoreService(Store.open(tmp_path / "core.sqlite"))
        start = capture(core)
        result = cast(
            dict[str, Any],
            await core.dispatch(envelope("coding.start", start.model_dump(mode="json"))),
        )
        assert result["kind"] == "response"
        assert result["result"]["state"] == "failed"
        assert "PRIVATE_PROMPT" not in json.dumps(result)
        await core.aclose()

    asyncio.run(run())


def test_old_settings_do_not_enable_coding() -> None:
    assert (
        getattr(Settings(ai_mode="assistant", reasoning_backend="copilot"), "coding_backend", None)
        == "none"
    )


def enabled_core(tmp_path: Path, backend: Any, clock: Any = None) -> CoreService:
    store = Store.open(tmp_path / "core.sqlite")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO settings VALUES (1,?)",
            (Settings(ai_mode="assistant", coding_backend="copilot").model_dump_json(),),
        )
    return CoreService(store, clock=clock, coding_backend=backend)


def test_start_ack_precedes_provider_and_result_stops_at_review(tmp_path: Path) -> None:
    from tests.helpers.coding_fake import DeferredCodingBackend

    async def run() -> None:
        backend = DeferredCodingBackend()
        core = enabled_core(tmp_path, backend)
        result = cast(
            dict[str, Any],
            await core.dispatch(envelope("coding.start", capture(core).model_dump(mode="json"))),
        )
        assert result["result"]["state"] == "proposing"
        await backend.entered.wait()
        assert not backend.release.is_set()
        request = backend.requests[0]
        assert 119 < (request.deadline - core.clock()).total_seconds() <= 120
        assert core.backend is None
        backend.release.set()
        await asyncio.sleep(0)
        assert core.coding.get("job-1").state == "review_required"
        assert core.coding.proposal_get("job-1").files
        with core.store.transaction() as db:
            assert db.execute("SELECT count(*) FROM coding_grants").fetchone()[0] == 0
            assert db.execute("SELECT count(*) FROM notes").fetchone()[0] == 0
        await core.aclose()
        assert backend.closed == 1

    asyncio.run(run())


def test_virtual_inference_deadline_and_late_cancellation_swallow(tmp_path: Path) -> None:
    from tests.helpers.coding_fake import DeferredCodingBackend

    async def run() -> None:
        now = datetime(2035, 1, 2, tzinfo=UTC)
        backend = DeferredCodingBackend()
        backend.swallow = True
        core = enabled_core(tmp_path, backend, lambda: now)
        await core.coding.start(capture(core))
        await backend.entered.wait()
        now += timedelta(seconds=120)
        assert core.coding.get("job-1").diagnostic == "expired"
        await asyncio.sleep(0)
        backend.release.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert core.coding.get("job-1").state == "cancelled"
        assert backend.cancelled == [backend.requests[0].request_id]
        await core.aclose()

    asyncio.run(run())


def test_model_change_invalidates_review_and_closes_each_owner_once(tmp_path: Path) -> None:
    from tests.helpers.coding_fake import DeferredCodingBackend

    async def run() -> None:
        backend = DeferredCodingBackend()
        core = enabled_core(tmp_path, backend)
        await core.coding.start(capture(core))
        await backend.entered.wait()
        backend.release.set()
        await asyncio.sleep(0)
        assert core.coding.get("job-1").state == "review_required"
        result = cast(
            dict[str, Any],
            await core.dispatch(
                envelope(
                    "settings.update",
                    {
                        "ai_mode": "assistant",
                        "coding_backend": "copilot",
                        "coding_model": "changed",
                    },
                    "settings",
                )
            ),
        )
        assert result["kind"] == "response"
        assert core.coding.get("job-1").cancel_requested
        await core.aclose()
        assert backend.closed == 1

    asyncio.run(run())


def test_fixed_copilot_output_is_data_only_and_projection_has_no_private_ids(
    tmp_path: Path,
) -> None:
    from sage.coding_contracts import CodeModelRequest
    from tests.helpers.copilot_fake import FakeSdk
    from tests.unit.test_provider_contract import backend as note_backend

    async def run() -> None:
        sdk = FakeSdk()
        provider = note_backend(tmp_path, sdk, coding=True)
        assert callable(getattr(provider, "propose_code", None)), (
            "coding capability must be independent"
        )
        output = make_proposal()
        sdk.output = json.dumps({"explanation": output["explanation"], "files": output["files"]})
        request = CodeModelRequest(
            job_id="job-1",
            revision=1,
            account_generation=0,
            user_text="PRIVATE_PROMPT",
            backend="copilot",
            disclosure_hash="a" * 64,
            request_id="private-request",
            deadline=datetime.now(UTC) + timedelta(seconds=120),
            mode="create_focus_project",
            files=(),
        )
        proposal = await provider.propose_code(request)
        assert proposal.job_id == "job-1" and proposal.revision == 1
        assert json.loads(sdk.prompts[0]) == {
            "user_text": "PRIVATE_PROMPT",
            "mode": "create_focus_project",
            "files": [],
            "diagnostics": [],
        }
        assert sdk.session_options["available_tools"] == []
        assert sdk.session_options["enable_skills"] is False
        assert sdk.session_options["streaming"] is True
        assert "file://" in sdk.session_options["system_message"]["content"]
        assert sdk.stopped == sdk.disconnected == 1
        assert list((tmp_path / "sessions").iterdir()) == []
        await provider.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("change", ["cancel", "pair", "mode", "account", "rollback", "shutdown"])
def test_all_lifecycle_changes_prevent_late_result(tmp_path: Path, change: str) -> None:
    from tests.helpers.coding_fake import DeferredCodingBackend

    async def run() -> None:
        now = datetime(2035, 1, 2, tzinfo=UTC)
        backend = DeferredCodingBackend()
        backend.swallow = True
        core = enabled_core(tmp_path, backend, lambda: now)
        await core.coding.start(capture(core))
        await backend.entered.wait()
        cleanup: asyncio.Task[Any] | None = None
        if change == "cancel":
            cleanup = asyncio.create_task(core.coding.cancel_work("job-1"))
        elif change == "pair":
            core.coding.revoke_pair("pair-1")
        elif change == "mode":
            await core.dispatch(envelope("settings.update", {"ai_mode": "local"}, "change"))
        elif change == "account":
            cleanup = asyncio.create_task(
                core.select_account(
                    {
                        "version": 1,
                        "kind": "host_copilot_selection",
                        "id": "account",
                        "boot_id": "d" * 32,
                        "generation": 1,
                        "account": None,
                    }
                )
            )
        elif change == "rollback":
            now -= timedelta(seconds=1)
            core.coding.expire()
        else:
            cleanup = asyncio.create_task(core.coding.aclose())
        await asyncio.sleep(0)
        backend.release.set()
        if cleanup:
            await cleanup
        await asyncio.sleep(0)
        assert core.coding.get("job-1").state != "review_required"
        assert core.coding.get("job-1").cancel_requested
        await core.aclose()
        assert backend.closed == 1

    asyncio.run(run())


@pytest.mark.parametrize(
    "malformed",
    ["extra", "notes", "partial", "duplicate", "large", "permission", "stream_overflow", "error"],
)
def test_copilot_rejects_untrusted_output_without_authority(
    tmp_path: Path, malformed: str, caplog: Any
) -> None:
    from sage.coding_contracts import CodeModelRequest
    from sage.providers.copilot import CODING_OUTPUT_BYTES
    from tests.helpers.copilot_fake import FakeSdk
    from tests.unit.test_provider_contract import backend as note_backend

    async def run() -> None:
        sdk = FakeSdk()
        provider = note_backend(tmp_path, sdk, coding=True)
        candidate = make_proposal()
        data: dict[str, Any] = {"explanation": "PRIVATE_OUTPUT", "files": candidate["files"]}
        if malformed == "extra":
            data["command"] = "PRIVATE_COMMAND"
        if malformed == "notes":
            data = {"text": "PRIVATE_OUTPUT", "proposal": {"title": "x", "body": "x"}}
        if malformed == "partial":
            data["files"] = data["files"][:1]
        sdk.output = json.dumps(data)
        if malformed == "duplicate":
            sdk.output = '{"explanation":"x",' + sdk.output[1:]
        if malformed == "large":
            sdk.output = "x" * (CODING_OUTPUT_BYTES + 1)
        if malformed == "permission":
            sdk.permission = True
        if malformed == "stream_overflow":
            sdk.deltas = ["x" * 400001, "x" * 400001]
        if malformed == "error":
            sdk.error = OSError("PRIVATE_EXCEPTION")
        request = CodeModelRequest(
            job_id="job-1",
            revision=1,
            account_generation=0,
            user_text="PRIVATE_PROMPT",
            backend="copilot",
            disclosure_hash="a" * 64,
            request_id="private-request",
            deadline=datetime.now(UTC) + timedelta(seconds=120),
            mode="create_focus_project",
            files=(),
        )
        with pytest.raises(ValueError, match="^Coding provider unavailable$"):
            await provider.propose_code(request)
        assert sdk.effects == []
        assert sdk.stopped == 1 and sdk.disconnected == 1
        assert list((tmp_path / "sessions").iterdir()) == []
        assert "PRIVATE_" not in caplog.text
        await provider.aclose()

    asyncio.run(run())


def test_shared_core_clock_rollback_cancels_idle_coding_owner(tmp_path: Path) -> None:
    from tests.helpers.coding_fake import DeferredCodingBackend

    async def run() -> None:
        now = datetime(2035, 1, 2, tzinfo=UTC)
        backend = DeferredCodingBackend()
        core = enabled_core(tmp_path, backend, lambda: now)
        await core.coding.start(capture(core))
        await backend.entered.wait()
        now += timedelta(seconds=2)
        core.clock()  # Note/service observation advances the shared high-water mark.
        now -= timedelta(seconds=1)
        await core.dispatch(envelope("coding.readiness", {}, "clock-check"))
        backend.release.set()
        await asyncio.sleep(0)
        assert core.coding.get("job-1").cancel_requested
        await core.aclose()

    asyncio.run(run())


def test_new_job_waits_for_cancelled_owner_to_drain(tmp_path: Path) -> None:
    from sage.coding_jobs import CodingError
    from tests.helpers.coding_fake import DeferredCodingBackend

    async def run() -> None:
        backend = DeferredCodingBackend()
        backend.swallow = True
        core = enabled_core(tmp_path, backend)
        await core.coding.start(capture(core))
        await backend.entered.wait()
        core.coding.cancel("job-1")
        await asyncio.sleep(0)
        context = CodeContext.model_validate(make_context())
        context = context.model_copy(
            update={"binding": context.binding.model_copy(update={"job_id": "job-2"})}
        )
        context = context.model_copy(update={"context_hash": context_hash(context)})
        view = core.coding.accept_context(context)
        draft = {
            "job_id": "job-2",
            "revision": 1,
            "account_generation": 0,
            "user_text": "new",
            "backend": "copilot",
        }
        start = CodeStart.model_validate({**draft, "disclosure_hash": disclosure_hash(view, draft)})
        try:
            with pytest.raises(CodingError):
                await core.coding.start(start)
            assert len(backend.requests) == 1
        finally:
            backend.release.set()
            await core.aclose()

    asyncio.run(run())


def test_shutdown_closes_distinct_note_and_coding_owners_exactly_once(tmp_path: Path) -> None:
    from sage.contracts import ReasoningRequest, ReasoningResult
    from tests.helpers.coding_fake import DeferredCodingBackend

    class Notes(DeferredCodingBackend):
        def readiness(self) -> Any:
            return self.coding_readiness()

        async def reason(self, request: ReasoningRequest) -> ReasoningResult:
            return ReasoningResult(request_id=request.request_id, status="cancelled")

    async def run() -> None:
        notes, coding = Notes(), DeferredCodingBackend()
        core = CoreService(
            Store.open(tmp_path / "core.sqlite"), backend=notes, coding_backend=coding
        )
        await core.aclose()
        await core.aclose()
        assert notes.closed == coding.closed == 1

    asyncio.run(run())


def test_coding_close_failure_still_closes_the_note_owner(tmp_path: Path) -> None:
    from sage.contracts import ReasoningRequest, ReasoningResult
    from tests.helpers.coding_fake import DeferredCodingBackend

    class Notes(DeferredCodingBackend):
        def readiness(self) -> Any:
            return self.coding_readiness()

        async def reason(self, request: ReasoningRequest) -> ReasoningResult:
            return ReasoningResult(request_id=request.request_id, status="cancelled")

    class Broken(DeferredCodingBackend):
        async def aclose(self) -> None:
            self.closed += 1
            raise ValueError("fixed failure")

    async def run() -> None:
        notes, coding = Notes(), Broken()
        core = CoreService(
            Store.open(tmp_path / "core.sqlite"), backend=notes, coding_backend=coding
        )
        with pytest.raises(ValueError, match="fixed failure"):
            await core.aclose()
        assert notes.closed == coding.closed == 1

    asyncio.run(run())


def test_followup_projects_only_selected_text_and_target(tmp_path: Path) -> None:
    from sage.coding_contracts import CodeModelRequest, CodeSource
    from tests.helpers.copilot_fake import FakeSdk
    from tests.unit.test_provider_contract import backend as provider_factory

    async def run() -> None:
        sdk = FakeSdk()
        sdk.output = json.dumps(
            {"explanation": "replacement", "files": [{"name": "focus.js", "text": "replacement\n"}]}
        )
        provider = provider_factory(tmp_path, sdk, coding=True)
        request = CodeModelRequest(
            job_id="private-job",
            revision=7,
            account_generation=3,
            user_text="PRIVATE_PROMPT",
            backend="copilot",
            model="selected-model",
            disclosure_hash="a" * 64,
            request_id="private-request",
            deadline=datetime.now(UTC) + timedelta(seconds=120),
            mode="replace_focus_file",
            target="focus.js",
            files=(CodeSource(name="focus.js", text="PRIVATE_SELECTED\n"),),
            diagnostics=("PRIVATE_DIAGNOSTIC",),
        )
        proposal = await provider.propose_code(request)
        assert proposal.job_id == "private-job" and proposal.revision == 7
        assert json.loads(sdk.prompts[0]) == {
            "user_text": "PRIVATE_PROMPT",
            "mode": "replace_focus_file",
            "target": "focus.js",
            "files": [{"name": "focus.js", "text": "PRIVATE_SELECTED\n"}],
            "diagnostics": ["PRIVATE_DIAGNOSTIC"],
        }
        assert sdk.session_options["model"] == "selected-model"
        assert list((tmp_path / "sessions").iterdir()) == []
        await provider.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("account_change", [False, True])
def test_logical_owners_settle_concurrently_within_existing_cleanup_budget(
    tmp_path: Path, account_change: bool
) -> None:
    from sage.contracts import ReasoningRequest, ReasoningResult
    from tests.helpers.coding_fake import DeferredCodingBackend

    async def run() -> None:
        note_entered, coding_entered = asyncio.Event(), asyncio.Event()

        class Notes(DeferredCodingBackend):
            def readiness(self) -> Any:
                return self.coding_readiness()

            async def reason(self, request: ReasoningRequest) -> ReasoningResult:
                return ReasoningResult(request_id=request.request_id, status="cancelled")

            async def aclose(self) -> None:
                note_entered.set()
                await coding_entered.wait()
                self.closed += 1

        class Coding(DeferredCodingBackend):
            async def aclose(self) -> None:
                coding_entered.set()
                await note_entered.wait()
                self.closed += 1

        notes, coding = Notes(), Coding()
        core = CoreService(
            Store.open(tmp_path / "core.sqlite"), backend=notes, coding_backend=coding
        )
        action: Any
        if account_change:
            action = core.select_account(
                {
                    "version": 1,
                    "kind": "host_copilot_selection",
                    "id": "selection",
                    "boot_id": "d" * 32,
                    "generation": 1,
                    "account": None,
                }
            )
        else:
            action = core.aclose()
        try:
            await asyncio.wait_for(action, 0.2)
            assert notes.closed == coding.closed == 1
        finally:
            note_entered.set()
            coding_entered.set()
            await core.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("streaming", [False, True])
def test_oversized_sdk_string_is_rejected_before_owned_encoding(
    tmp_path: Path, streaming: bool
) -> None:
    from sage.coding_contracts import CodeModelRequest
    from sage.providers.copilot import CODING_OUTPUT_BYTES
    from tests.helpers.copilot_fake import FakeSdk
    from tests.unit.test_provider_contract import backend as provider_factory

    encoded: list[bool] = []

    class Oversized(str):
        def encode(self, encoding: str = "utf-8", errors: str = "strict") -> bytes:
            encoded.append(True)
            return super().encode(encoding, errors)

    async def run() -> None:
        sdk = FakeSdk()
        text = Oversized("x" * (CODING_OUTPUT_BYTES + 1))
        if streaming:
            sdk.deltas = [text]
        else:
            sdk.output = text
        provider = provider_factory(tmp_path, sdk, coding=True)
        request = CodeModelRequest(
            job_id="job-1",
            revision=1,
            account_generation=0,
            user_text="synthetic",
            backend="copilot",
            disclosure_hash="a" * 64,
            request_id="request",
            deadline=datetime.now(UTC) + timedelta(seconds=120),
            mode="create_focus_project",
            files=(),
        )
        with pytest.raises(ValueError, match="^Coding provider unavailable$"):
            await provider.propose_code(request)
        assert encoded == []
        assert sdk.stopped == sdk.disconnected == 1
        await provider.aclose()

    asyncio.run(run())
