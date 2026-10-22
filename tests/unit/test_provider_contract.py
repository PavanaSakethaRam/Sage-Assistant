"""Catch cloud startup, invented readiness/usage, and unsafe result/error handling."""

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from sage.config import Settings
from sage.contracts import ReasoningRequest
from sage.providers.copilot import CopilotReasoner
from sage.providers.session_store import SessionStore
from tests.helpers.copilot_fake import FakeSdk


def request(**changes: Any) -> ReasoningRequest:
    return ReasoningRequest(
        request_id="r1",
        task_id="t1",
        user_text="literal current text",
        attached_context=("explicit context",),
        backend="copilot",
        deadline=datetime.now(UTC) + timedelta(seconds=30),
        cancellation_id="cancel-1",
        **changes,
    )


def backend(
    tmp_path: Path, sdk: FakeSdk, *, local: bool = False, auth: bool = True
) -> CopilotReasoner:
    runtime = tmp_path / "native" / "copilot-runtime"
    runtime.parent.mkdir()
    runtime.touch()
    (runtime.parent / "runtime.node").touch()
    (runtime.parent / ".hostless-runtime-assets-v2").touch()
    settings = Settings() if local else Settings(ai_mode="assistant", reasoning_backend="copilot")
    return CopilotReasoner(
        SessionStore(tmp_path / "sessions"),
        runtime,
        settings=lambda: settings,
        token_source=(lambda *_: asyncio.sleep(0, result="gho_synthetic")) if auth else None,
        client_factory=sdk.client,
    )


def test_no_model_call_from_readiness(tmp_path: Path) -> None:
    sdk = FakeSdk()
    provider = backend(tmp_path, sdk)
    assert provider.readiness().status == "not_configured"
    assert sdk.created == 0
    assert sdk.prompts == []
    assert not (tmp_path / "sessions").exists()


def test_unconfigured_auth_never_constructs_sdk(tmp_path: Path) -> None:
    sdk = FakeSdk()
    provider = backend(tmp_path, sdk, auth=False)
    assert provider.readiness().status == "auth_required"
    result = asyncio.run(provider.reason(request()))
    assert result.status == "error"
    assert result.text == "auth_required"
    assert sdk.created == 0


def test_local_mode_never_starts_cloud_client(tmp_path: Path) -> None:
    sdk = FakeSdk()
    provider = backend(tmp_path, sdk, local=True)
    result = asyncio.run(provider.reason(request()))
    assert result.status == "error"
    assert result.text == "inference_unavailable"
    assert sdk.created == 0
    assert sdk.prompts == []


def test_only_attached_context_sent(tmp_path: Path) -> None:
    sdk = FakeSdk()
    provider = backend(tmp_path, sdk)
    result = asyncio.run(provider.reason(request()))
    assert result.status == "completed"
    assert result.proposal is not None
    assert result.proposal.model_dump() == {"title": "draft", "body": "body"}
    assert sdk.prompts == [
        '{"user_text":"literal current text","attached_context":["explicit context"]}'
    ]
    assert (
        provider.readiness().status != "ready"
    )  # ordinary completion is no connection-check proof


def test_usage_unknown_is_not_zero(tmp_path: Path) -> None:
    sdk = FakeSdk()
    result = asyncio.run(backend(tmp_path, sdk).reason(request()))
    assert result.usage is None


@pytest.mark.parametrize(
    ("error", "output", "code"),
    [
        (PermissionError("synthetic-private-marker"), None, "auth_required"),
        (RuntimeError("429 quota synthetic-private-marker"), None, "quota_exhausted"),
        (TimeoutError("synthetic-private-marker"), None, "timeout"),
        (OSError("synthetic-private-marker"), None, "runtime_error"),
        (
            None,
            '{"text":"ok","proposal":{"title":"x","body":"y","approval":true}}',
            "malformed_output",
        ),
        (None, '{"text":"first","text":"second","proposal":null}', "malformed_output"),
        (None, "partial", "malformed_output"),
        (None, '{"text":"ok","proposal":null,"tools":["shell"]}', "malformed_output"),
    ],
)
def test_auth_quota_timeout_and_malformed_output(
    tmp_path: Path, error: Exception | None, output: str | None, code: str
) -> None:
    sdk = FakeSdk()
    sdk.error = error
    if output is not None:
        sdk.output = output
    provider = backend(tmp_path, sdk)
    result = asyncio.run(provider.reason(request()))
    assert result.status == "error"
    assert result.text == code
    assert result.proposal is None
    assert "synthetic-private-marker" not in result.model_dump_json()
    assert provider.readiness().status != "ready"
    assert sdk.stopped == 1


def test_late_cancelled_response_discarded(tmp_path: Path) -> None:
    async def run() -> None:
        sdk = FakeSdk()
        sdk.gate = asyncio.Event()
        sdk.ignore_cancel = True
        provider = backend(tmp_path, sdk)
        pending = asyncio.create_task(provider.reason(request()))
        await sdk.started.wait()
        await provider.cancel("r1")
        sdk.gate.set()
        result = await pending
        assert result.status == "cancelled"
        assert result.proposal is None
        assert result.text == ""
        assert sdk.aborted == 1
        assert sdk.deleted == []
        assert sdk.disconnected == 1
        await provider.aclose()

    asyncio.run(run())


def test_only_explicit_fixed_check_can_establish_ready(tmp_path: Path) -> None:
    sdk = FakeSdk()
    sdk.output = '{"text":"Sage connection check","proposal":null}'
    provider = backend(tmp_path, sdk)
    result = asyncio.run(provider.connection_test())
    assert result.status == "ready"
    assert len(sdk.prompts) == 1
    assert sdk.prompts[0] == (
        '{"user_text":"Return exactly {\\"text\\":\\"Sage connection check\\",'
        '\\"proposal\\":null}.","attached_context":[]}'
    )
    sdk.error = PermissionError("private marker")
    asyncio.run(provider.reason(request()))
    assert provider.readiness().status == "auth_required"


def test_task_cancellation_propagates_after_disposal(tmp_path: Path) -> None:
    async def run() -> None:
        sdk = FakeSdk()
        sdk.gate = asyncio.Event()
        provider = backend(tmp_path, sdk)
        task = asyncio.create_task(provider.reason(request()))
        await sdk.started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert sdk.aborted == 1 and sdk.stopped == 1
        assert sdk.deleted == []
        assert sdk.disconnected == 1
        assert list((tmp_path / "sessions").iterdir()) == []
        with pytest.raises(ValueError):
            await sdk.ram.read_file("/sage/state/events")

    asyncio.run(run())


def test_expired_deadline_never_constructs_sdk(tmp_path: Path) -> None:
    sdk = FakeSdk()
    provider = backend(tmp_path, sdk)
    original = request()
    expired = original.model_copy(update={"deadline": datetime.now(UTC) - timedelta(seconds=1)})
    result = asyncio.run(provider.reason(expired))
    assert result.status == "error" and result.text == "timeout"
    assert sdk.created == 0


def test_missing_runtime_and_bad_token_never_construct_sdk(tmp_path: Path) -> None:
    sdk = FakeSdk()
    provider = backend(tmp_path, sdk)
    assert provider.runtime_path is not None
    provider.runtime_path.unlink()
    assert provider.readiness().status == "unavailable"
    assert asyncio.run(provider.reason(request())).text == "runtime_unavailable"
    assert sdk.created == 0
    provider.runtime_path.touch()
    provider._token_source = lambda *_: asyncio.sleep(0, result="ghp_not-supported")
    assert asyncio.run(provider.reason(request())).text == "auth_required"
    assert sdk.created == 0


def test_closed_provider_and_close_during_work_discard_output(tmp_path: Path) -> None:
    async def run() -> None:
        sdk = FakeSdk()
        sdk.gate = asyncio.Event()
        provider = backend(tmp_path, sdk)
        task = asyncio.create_task(provider.reason(request()))
        await sdk.started.wait()
        close = asyncio.create_task(provider.aclose())
        await asyncio.gather(task, close, return_exceptions=True)
        assert sdk.stopped == 1 and sdk.disconnected == 1
        assert provider.readiness().status == "unavailable"
        assert (await provider.reason(request())).text == "inference_unavailable"
        assert sdk.created == 1

    asyncio.run(run())


def test_auth_failure_in_sdk_error_invalidates_check(tmp_path: Path) -> None:
    sdk = FakeSdk()
    sdk.error = RuntimeError("Session error: 401 unauthorized synthetic-private-marker")
    result = asyncio.run(backend(tmp_path, sdk).reason(request()))
    assert result.text == "auth_required" and result.proposal is None


def test_cancel_during_start_never_sends_prompt(tmp_path: Path) -> None:
    async def run() -> None:
        sdk = FakeSdk()
        sdk.start_gate = asyncio.Event()
        provider = backend(tmp_path, sdk)
        pending = asyncio.create_task(provider.reason(request()))
        await sdk.starting.wait()
        await provider.cancel("r1")
        sdk.start_gate.set()
        result = await pending
        assert result.status == "cancelled"
        assert sdk.prompts == []
        assert sdk.stopped == 1

    asyncio.run(run())


def test_sdk_swallowed_task_cancellation_never_returns_proposal(tmp_path: Path) -> None:
    async def run() -> None:
        sdk = FakeSdk()
        sdk.gate = asyncio.Event()
        sdk.ignore_cancel = True
        provider = backend(tmp_path, sdk)
        pending = asyncio.create_task(provider.reason(request()))
        await sdk.started.wait()
        pending.cancel()
        await asyncio.sleep(0)
        sdk.gate.set()
        result = await pending
        assert result.status == "cancelled" and result.proposal is None

    asyncio.run(run())


def test_wrong_native_version_never_creates_session(tmp_path: Path) -> None:
    sdk = FakeSdk()
    sdk.native_version = "1.0.999"
    provider = backend(tmp_path, sdk)
    result = asyncio.run(provider.reason(request()))
    assert result.status == "error" and result.text == "runtime_incompatible"
    assert sdk.session_options == {} and sdk.prompts == []
    assert sdk.stopped == 1
    assert provider.readiness().status == "incompatible"
