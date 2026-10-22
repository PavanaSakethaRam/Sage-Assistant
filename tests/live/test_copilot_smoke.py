"""Explicit quota-bearing gate. CI and absent protected-host auth skip honestly."""

import asyncio
import os
import platform
import sys
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from copilot import CopilotClient

from sage.config import Settings
from sage.contracts import ReasoningRequest
from sage.providers.copilot import CopilotReasoner
from sage.providers.protected_auth import LOGIN, ProtectedSource, platform_key, trusted_executable
from sage.providers.session_store import SessionStore

pytestmark = pytest.mark.skipif(
    os.environ.get("SAGE_LIVE_COPILOT") != "1",
    reason="Live Copilot is opt-in: SAGE_LIVE_COPILOT=1; consumes model quota",
)


@pytest.fixture
def live_token_source(tmp_path: Path) -> Callable[[str, datetime], Awaitable[str | None]]:
    # This is explicitly trusted operator selection for a quota-bearing harness,
    # not production renderer authority. Native main consent remains a live gate.
    login = os.environ.get("SAGE_LIVE_COPILOT_LOGIN", "")
    if not LOGIN.fullmatch(login):
        pytest.skip("Explicit SAGE_LIVE_COPILOT_LOGIN selection is required; no credential read")
    executable = (
        Path(__file__).resolve().parents[2]
        / ".runtime/gh/2.103.0"
        / platform_key()
        / "bin"
        / ("gh.exe" if sys.platform == "win32" else "gh")
    )
    if not trusted_executable(executable):
        pytest.skip("Pinned checksum-verified managed gh is not provisioned")
    return ProtectedSource(executable, tmp_path / "protected-source", login)


def test_one_synthetic_prompt_auth_cancellation_and_disposal(
    tmp_path: Path, live_token_source: Callable[[str, datetime], Awaitable[str | None]]
) -> None:
    async def run() -> None:
        sent = asyncio.Event()
        observed: dict[str, Any] = {}

        class ObservedClient(CopilotClient):
            async def create_session(self, **kwargs: Any) -> Any:
                observed.update(kwargs)
                session = await super().create_session(**kwargs)
                send = session.send_and_wait

                async def send_once(*args: Any, **options: Any) -> Any:
                    sent.set()
                    return await send(*args, **options)

                session.send_and_wait = send_once  # type: ignore[method-assign]
                return session

        target = {
            ("darwin", "arm64"): "darwin-arm64",
            ("darwin", "x86_64"): "darwin-x64",
            ("win32", "AMD64"): "win32-x64",
            ("win32", "ARM64"): "win32-arm64",
        }.get((sys.platform, platform.machine()))
        if target is None:
            pytest.skip("Live runtime gate currently targets macOS and Windows")
        runtime = (
            Path(__file__).resolve().parents[2]
            / ".runtime/copilot/1.0.102/prebuilds"
            / target
            / ("copilot-runtime.exe" if sys.platform == "win32" else "copilot-runtime")
        )
        if not runtime.is_file():
            pytest.skip("Explicit checksum-verified runtime for this platform is not provisioned")
        sessions = SessionStore(tmp_path / "sessions")
        provider = CopilotReasoner(
            sessions,
            runtime,
            token_source=live_token_source,
            settings=lambda: Settings(ai_mode="assistant", reasoning_backend="copilot"),
            client_factory=ObservedClient,
        )
        identifier = uuid4().hex
        request = ReasoningRequest(
            request_id=identifier,
            task_id=uuid4().hex,
            user_text='Return {"text":"synthetic Sage smoke","proposal":null}.',
            attached_context=(),
            backend="copilot",
            deadline=datetime.now(UTC) + timedelta(seconds=30),
            cancellation_id=uuid4().hex,
        )
        pending = asyncio.create_task(provider.reason(request))
        try:
            async with asyncio.timeout(30):
                await sent.wait()
                await provider.cancel(identifier)
                result = await pending
                assert result.status == "cancelled" and result.proposal is None
            assert observed["available_tools"] == [] and observed["tools"] == []
            assert observed["mcp_servers"] == {} and observed["custom_agents"] == []
            assert list(sessions.root.iterdir()) == []
            assert provider.readiness().status != "ready"
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            await provider.aclose()

    asyncio.run(run())
