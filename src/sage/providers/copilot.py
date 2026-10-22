"""Public pinned SDK, fixed text-only policy, explicit runtime and disposable sessions."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from importlib.metadata import version
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any
from uuid import uuid4

from pydantic import Field, ValidationError

from sage.config import Settings
from sage.contracts import (
    Contract,
    NoteContent,
    ProviderReadiness,
    ReasoningRequest,
    ReasoningResult,
)
from sage.providers.session_store import MemorySessionFs, SessionStore

if TYPE_CHECKING:
    from copilot.generated.rpc import PermissionDecisionReject

SDK_VERSION = "1.0.25"
RUNTIME_VERSION = "1.0.102"
CHECK_PROMPT = 'Return exactly {"text":"Sage connection check","proposal":null}.'


class _Incompatible(Exception):
    pass


class _Cancelled(Exception):
    pass


class _Output(Contract):
    text: Annotated[str, Field(max_length=100_000)]
    proposal: NoteContent | None


@dataclass
class _Running:
    task: asyncio.Task[Any] | None
    session: Any = None
    cancelled: bool = False
    permission_denied: bool = False
    aborted: bool = False
    acquiring: bool = True


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("Duplicate result field")
        result[name] = value
    return result


class CopilotReasoner:
    """No ambient account reads; token_source is a trusted host-owned capability.

    It supplies a per-session static OAuth token, never a fabricated expiry. The
    default has no credential source. Only connection_test can establish ready.
    """

    def __init__(
        self,
        sessions: SessionStore,
        runtime_path: Path | None = None,
        *,
        settings: Callable[[], Settings] = Settings,
        token_source: Callable[[str, datetime], Awaitable[str | None]] | None = None,
        client_factory: Callable[..., Any] | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.sessions = sessions
        self.runtime_path = runtime_path
        self._settings = settings
        self._token_source = token_source
        self._client_factory = client_factory
        self._clock = clock
        self._active: dict[str, _Running] = {}
        self._checked = False
        self._closed = False
        self._fault: str | None = None

    def readiness(self) -> ProviderReadiness:
        status: Any = "not_configured"
        explanation = "explicit_connection_check_required"
        if self._closed or self._settings().ai_mode != "assistant":
            status, explanation = "unavailable", "inference_unavailable"
        elif self._token_source is None:
            status, explanation = "auth_required", "protected_auth_required"
        elif self._fault in {"session_cleanup_failed", "runtime_incompatible"}:
            status, explanation = "incompatible", self._fault
        elif not self._runtime_present():
            status, explanation = "unavailable", "runtime_missing"
        elif version("github-copilot-sdk") != SDK_VERSION:
            status, explanation = "incompatible", "sdk_version_mismatch"
        elif self._fault:
            status = "auth_required" if self._fault == "auth_required" else "error"
            explanation = self._fault
        elif self._checked:
            status, explanation = "ready", "explicit_connection_check_succeeded"
        return ProviderReadiness(
            provider="copilot",
            status=status,
            evidence=("explicit_synthetic_check",) if status == "ready" else (),
            version=f"sdk:{SDK_VERSION}/runtime:{RUNTIME_VERSION}",
            destination="GitHub Copilot cloud",
            explanation=explanation,
        )

    def _runtime_present(self) -> bool:
        path = self.runtime_path
        return (
            path is not None
            and path.is_absolute()
            and path.is_file()
            and (path.parent / "runtime.node").is_file()
            and (path.parent / ".hostless-runtime-assets-v2").is_file()
        )

    async def reason(self, request: ReasoningRequest) -> ReasoningResult:
        if (
            self._closed
            or request.backend != "copilot"
            or self._settings().ai_mode != "assistant"
            or self._settings().reasoning_backend != "copilot"
        ):
            return self._error(request, "inference_unavailable")
        if self._token_source is None:
            return self._error(request, "auth_required")
        if not self._runtime_present() or version("github-copilot-sdk") != SDK_VERSION:
            return self._error(request, "runtime_unavailable")
        if self._fault == "session_cleanup_failed":
            return self._error(request, self._fault)
        if request.request_id in self._active:
            return self._error(request, "correlation_error")
        remaining = min(30.0, (request.deadline - self._clock()).total_seconds())
        if remaining <= 0:
            return self._error(request, "timeout")
        running = _Running(asyncio.current_task())
        self._active[request.request_id] = running
        client: Any = None
        path: Path | None = None
        ram = MemorySessionFs()
        result: ReasoningResult | None = None
        cleanup_failed = False
        cancellation: asyncio.CancelledError | None = None
        token: str | None = None
        try:
            async with asyncio.timeout(remaining):
                token = await self._token_source(request.request_id, request.deadline)
            running.acquiring = False
            current = asyncio.current_task()
            if running.cancelled or self._closed or (current and current.cancelling()):
                raise _Cancelled
            if self._clock() >= request.deadline:
                raise TimeoutError
            if not token or not token.startswith(("gho_", "ghu_")):
                raise PermissionError
            path = self.sessions.create(request.request_id)
            assert self.runtime_path is not None
            sdk_logger = logging.getLogger("copilot")
            sdk_logger.handlers = [logging.NullHandler()]
            sdk_logger.propagate = False
            sdk_logger.setLevel(logging.CRITICAL + 1)
            from copilot import CopilotClient, RuntimeConnection
            from copilot.generated.rpc import PermissionDecisionReject

            client_factory = self._client_factory or CopilotClient
            client = client_factory(
                connection=RuntimeConnection.for_stdio(path=str(self.runtime_path)),
                mode="empty",
                base_directory=str(path),
                working_directory=str(path),
                log_level="none",
                use_logged_in_user=False,
                builtin_plugin_directories=[],
                env={
                    "COPILOT_SKIP_CLI_DOWNLOAD": "1",
                    "COPILOT_DISABLE_KEYTAR": "1",
                    "COPILOT_GITHUB_TELEMETRY_DISABLED": "true",
                    "COPILOT_OTEL_ENABLED": "false",
                    "COPILOT_RUNTIME_PROCESS_FILE_LOGGING": "0",
                },
                session_fs={
                    "initial_working_directory": "/sage/work",
                    "session_state_path": "/sage/state",
                    "conventions": "posix",
                },
            )

            def deny(*args: Any) -> PermissionDecisionReject:
                running.permission_denied = True
                return PermissionDecisionReject(feedback="Sage permits no runtime actions")

            remaining = min(remaining, (request.deadline - self._clock()).total_seconds())
            async with asyncio.timeout(remaining):
                await client.start()
                status = await client.get_status()
                if status.version != RUNTIME_VERSION or status.protocol_version != 3:
                    raise _Incompatible
                if running.cancelled:
                    raise _Cancelled
                running.session = await client.create_session(
                    github_token=token,
                    model=request.model,
                    available_tools=[],
                    tools=[],
                    on_permission_request=deny,
                    mcp_servers={},
                    custom_agents=[],
                    create_session_fs_handler=lambda *_: ram,
                    system_message={
                        "mode": "replace",
                        "content": "Answer only from the supplied text. "
                        "Return JSON with exactly text and "
                        "proposal. proposal is null or an object with exactly title and body. "
                        "A proposal is a review draft and cannot perform an action.",
                    },
                    enable_skills=False,
                    enable_file_hooks=False,
                    enable_host_git_operations=False,
                    enable_session_store=False,
                    enable_config_discovery=False,
                    enable_on_demand_instruction_discovery=False,
                    enable_session_telemetry=False,
                    enable_file_change_tracking=False,
                    enable_citations=False,
                    skip_custom_instructions=True,
                    skip_embedding_retrieval=True,
                    skill_directories=[],
                    agent_directories=[],
                    hook_directories=[],
                    plugin_directories=[],
                    instruction_directories=[],
                    included_builtin_skills=[],
                    embedding_cache_storage="in-memory",
                    mcp_oauth_token_storage="in-memory",
                    streaming=False,
                    reasoning_summary="none",
                )
                if running.cancelled:
                    raise _Cancelled
                token = ""
                prompt = json.dumps(
                    {
                        "user_text": request.user_text,
                        "attached_context": list(request.attached_context),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                event = await running.session.send_and_wait(
                    prompt, response_schema=_Output.model_json_schema(), timeout=remaining
                )
                if running.permission_denied:
                    result = self._error(request, "permission_denied")
                else:
                    try:
                        content = event.data.content
                        if not isinstance(content, str) or len(content) > 200_500:
                            raise ValueError
                        data = json.loads(content, object_pairs_hook=_unique_object)
                        output = _Output.model_validate(data)
                        result = ReasoningResult(
                            request_id=request.request_id,
                            status="completed",
                            text=output.text,
                            proposal=output.proposal,
                        )
                    except (AttributeError, ValueError, ValidationError, RecursionError):
                        result = self._error(request, "malformed_output")
        except asyncio.CancelledError as exc:
            if not running.cancelled:
                cancellation = exc
            running.cancelled = True
        except _Incompatible:
            result = self._error(request, "runtime_incompatible")
        except _Cancelled:
            running.cancelled = True
        except PermissionError:
            result = self._error(request, "auth_required")
        except TimeoutError:
            result = self._error(request, "timeout")
        except Exception as exc:
            # Inspect classification only; never return/log provider exception content.
            message = str(exc).lower()
            quota = "429" in message or "quota" in message
            auth = any(part in message for part in ("401", "403", "unauthorized", "authentication"))
            code = "auth_required" if auth else "quota_exhausted" if quota else "runtime_error"
            result = self._error(request, code)
        finally:
            token = None
            cleanup_task = asyncio.create_task(
                self._cleanup(client, running, ram, path, request.request_id)
            )
            while not cleanup_task.done():
                try:
                    await asyncio.shield(cleanup_task)
                except asyncio.CancelledError as exc:
                    running.cancelled = True
                    cancellation = exc
            cleanup_failed = cleanup_task.result()
            self._active.pop(request.request_id, None)
        if cleanup_failed:
            result = self._error(request, "session_cleanup_failed")
        if cancellation is not None:
            raise cancellation
        current_task = asyncio.current_task()
        if running.cancelled or self._closed or (current_task and current_task.cancelling()):
            return ReasoningResult(request_id=request.request_id, status="cancelled")
        if self._clock() >= request.deadline:
            return self._error(request, "timeout")
        assert result is not None
        return result

    async def _cleanup(
        self,
        client: Any,
        running: _Running,
        ram: MemorySessionFs,
        path: Path | None,
        request_id: str,
    ) -> bool:
        failed = False
        if client is not None:
            if running.cancelled and running.session is not None and not running.aborted:
                try:
                    async with asyncio.timeout(3):
                        await running.session.abort()
                        running.aborted = True
                except Exception:
                    failed = True
            if running.session is not None:
                try:
                    async with asyncio.timeout(3):
                        await running.session.disconnect()
                except Exception:
                    failed = True
            try:
                async with asyncio.timeout(5):
                    await client.stop()
            except Exception:
                failed = True
                try:
                    async with asyncio.timeout(10):
                        await client.force_stop()
                except Exception:
                    failed = True
        ram.dispose()
        if path is not None:
            try:
                self.sessions.cleanup(request_id)
            except OSError:
                failed = True
        return failed

    def _error(self, request: ReasoningRequest, code: str) -> ReasoningResult:
        self._checked = False
        self._fault = code
        return ReasoningResult(request_id=request.request_id, status="error", text=code)

    async def cancel(self, request_id: str) -> None:
        active = self._active.get(request_id)
        if active is not None:
            active.cancelled = True
            if active.acquiring and active.task is not None:
                active.task.cancel()
            if active.session is not None:
                async with asyncio.timeout(3):
                    await active.session.abort()
                    active.aborted = True

    async def connection_test(self) -> ProviderReadiness:
        identifier = uuid4().hex
        result = await self.reason(
            ReasoningRequest(
                request_id=identifier,
                task_id=uuid4().hex,
                user_text=CHECK_PROMPT,
                backend="copilot",
                deadline=self._clock() + timedelta(seconds=30),
                cancellation_id=uuid4().hex,
            )
        )
        if (
            result.status == "completed"
            and result.text == "Sage connection check"
            and result.proposal is None
        ):
            self._fault = None
            self._checked = True
        elif result.status == "completed":
            self._error(
                ReasoningRequest(
                    request_id=identifier,
                    task_id=identifier,
                    user_text="",
                    backend="copilot",
                    deadline=self._clock(),
                    cancellation_id=identifier,
                ),
                "malformed_output",
            )
        return self.readiness()

    async def aclose(self) -> None:
        self._closed = True
        for identifier in list(self._active):
            try:
                await self.cancel(identifier)
            except Exception:
                self._fault = "session_cleanup_failed"
        tasks = [
            entry.task
            for entry in self._active.values()
            if entry.task is not None and entry.task is not asyncio.current_task()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
