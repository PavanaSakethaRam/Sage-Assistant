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

from sage.coding_contracts import CodeModelRequest, CodeProposal, CodeSource
from sage.config import Settings
from sage.contracts import (
    Contract,
    FailureCategory,
    FailureStage,
    NoteContent,
    ProviderDiagnostic,
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


def failure_category(exc: Exception) -> FailureCategory:
    if isinstance(exc, ImportError):
        return "dependency_error"
    if isinstance(exc, (TypeError, ValueError)):
        return "contract_error"
    if isinstance(exc, OSError):
        return "io_error"
    return "unexpected_error"


def construct_client(factory: Callable[..., Any], connection: Any, runtime: str, base: str) -> Any:
    """The same public, explicit stdio options for the provider and inert SDK probe."""
    return factory(
        connection=connection.for_stdio(path=runtime),
        mode="empty",
        base_directory=base,
        working_directory=base,
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


CODING_INSTRUCTIONS = (
    "Return JSON with exactly explanation and files; each file has exactly name and text. "
    "This is data for review, never authority to execute tools or commands. "
    "Create exactly index.html, focus.js, focus.test.mjs and README.md, "
    "or replace only the supplied target. "
    "Build a dependency-free named focus-session tracker: start, pause, reset, elapsed time, "
    "completed sessions and total during the current page session. Disclose refresh resets. "
    "index.html must open directly from file:// without a server or module CORS workaround. "
    "Use a classic browser script with a DOM guard and a tiny pure factory available to Node tests "
    "under both ancestor type=module and type=commonjs scopes; no package.json. "
    "Tests run with Node --test --test-isolation=none --test-reporter=tap focus.test.mjs. "
    "No dependencies, server, persistent history, shell commands or extra files. "
    "Each file is clean UTF-8/LF without BOM, at most 32000 Unicode code points; "
    "all filenames and source together at most 64000; explanation at most 2000."
)
# Escaped JSON can expand each literal code point to twelve ASCII bytes.
CODING_OUTPUT_BYTES = 800_000


class _Incompatible(Exception):
    pass


class _Cancelled(Exception):
    pass


class _Output(Contract):
    text: Annotated[str, Field(max_length=100_000)]
    proposal: NoteContent | None


class _CodeOutput(Contract):
    explanation: Annotated[str, Field(max_length=2_000)]
    files: Annotated[tuple[CodeSource, ...], Field(min_length=1, max_length=4)]


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
        self._diagnostic: ProviderDiagnostic | None = None

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
            diagnostic=self._diagnostic if explanation == "runtime_error" else None,
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

    def coding_readiness(self) -> ProviderReadiness:
        if self._settings().coding_backend != "copilot":
            return ProviderReadiness(
                provider="copilot",
                status="unavailable",
                evidence=(),
                explanation="inference_unavailable",
            )
        return self.readiness()

    async def reason(self, request: ReasoningRequest) -> ReasoningResult:
        result = await self._infer(request)
        assert isinstance(result, ReasoningResult)
        return result

    async def propose_code(self, request: CodeModelRequest) -> CodeProposal:
        request = CodeModelRequest.model_validate_json(request.model_dump_json())
        result = await self._infer(request)
        if not isinstance(result, CodeProposal):
            raise ValueError("Coding provider unavailable")
        return result

    async def _infer(
        self, request: ReasoningRequest | CodeModelRequest
    ) -> ReasoningResult | CodeProposal:
        coding = isinstance(request, CodeModelRequest)
        if (
            self._closed
            or request.backend != "copilot"
            or self._settings().ai_mode != "assistant"
            or (
                self._settings().coding_backend != "copilot"
                if coding
                else self._settings().reasoning_backend != "copilot"
            )
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
        remaining = min(
            120.0 if coding else 30.0, (request.deadline - self._clock()).total_seconds()
        )
        if remaining <= 0:
            return self._error(request, "timeout")
        running = _Running(asyncio.current_task())
        self._active[request.request_id] = running
        client: Any = None
        path: Path | None = None
        ram = MemorySessionFs()
        result: ReasoningResult | CodeProposal | None = None
        cleanup_failed = False
        cancellation: asyncio.CancelledError | None = None
        token: str | None = None
        stage: FailureStage = "token_source"
        unsubscribe: Callable[[], None] | None = None
        overflow = False
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
            stage = "session_storage"
            path = self.sessions.create(request.request_id)
            assert self.runtime_path is not None
            sdk_logger = logging.getLogger("copilot")
            sdk_logger.handlers = [logging.NullHandler()]
            sdk_logger.propagate = False
            sdk_logger.setLevel(logging.CRITICAL + 1)
            stage = "sdk_import"
            from copilot import CopilotClient, RuntimeConnection
            from copilot.generated.rpc import PermissionDecisionReject

            stage = "sdk_construct"
            client = construct_client(
                self._client_factory or CopilotClient,
                RuntimeConnection,
                str(self.runtime_path),
                str(path),
            )

            def deny(*args: Any) -> PermissionDecisionReject:
                running.permission_denied = True
                return PermissionDecisionReject(feedback="Sage permits no runtime actions")

            remaining = min(remaining, (request.deadline - self._clock()).total_seconds())
            async with asyncio.timeout(remaining):
                stage = "runtime_start"
                await client.start()
                stage = "runtime_status"
                status = await client.get_status()
                if status.version != RUNTIME_VERSION or status.protocol_version != 3:
                    raise _Incompatible
                if running.cancelled:
                    raise _Cancelled
                stage = "session_create"
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
                        "content": CODING_INSTRUCTIONS
                        if coding
                        else "Answer only from the supplied text. "
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
                    streaming=coding,
                    reasoning_summary="none",
                )
                if running.cancelled:
                    raise _Cancelled
                token = ""
                if coding:
                    assert isinstance(request, CodeModelRequest)
                    projection: dict[str, object] = {
                        "user_text": request.user_text,
                        "mode": request.mode,
                        "files": [file.model_dump() for file in request.files],
                        "diagnostics": list(request.diagnostics),
                    }
                    if request.target is not None:
                        projection["target"] = request.target
                    owned_bytes = 0
                    owner = asyncio.current_task()

                    def bound(event: Any) -> None:
                        nonlocal owned_bytes, overflow
                        if overflow:
                            return
                        kind = getattr(event.type, "value", event.type)
                        if kind not in {"assistant.message_delta", "assistant.message"}:
                            return
                        text = getattr(
                            event.data,
                            "delta_content" if kind.endswith("_delta") else "content",
                            None,
                        )
                        if not isinstance(text, str):
                            return
                        size = len(text)
                        if size <= CODING_OUTPUT_BYTES:
                            size = len(text.encode("utf-8"))
                        if kind.endswith("_delta"):
                            owned_bytes += size
                        else:
                            owned_bytes = max(owned_bytes, size)
                        if owned_bytes > CODING_OUTPUT_BYTES:
                            overflow = True
                            running.cancelled = True
                            if owner is not None:
                                owner.cancel()

                    unsubscribe = running.session.on(bound)
                else:
                    assert isinstance(request, ReasoningRequest)
                    projection = {
                        "user_text": request.user_text,
                        "attached_context": list(request.attached_context),
                    }
                prompt = json.dumps(projection, ensure_ascii=False, separators=(",", ":"))
                stage = "response_wait"
                event = await running.session.send_and_wait(
                    prompt,
                    response_schema=(_CodeOutput if coding else _Output).model_json_schema(),
                    timeout=remaining,
                )
                if running.permission_denied:
                    result = self._error(request, "permission_denied")
                else:
                    try:
                        content = event.data.content
                        if not isinstance(content, str) or (
                            (
                                len(content) > CODING_OUTPUT_BYTES
                                or len(content.encode("utf-8")) > CODING_OUTPUT_BYTES
                            )
                            if coding
                            else len(content) > 200_500
                        ):
                            raise ValueError
                        if overflow:
                            raise ValueError
                        data = json.loads(content, object_pairs_hook=_unique_object)
                        if coding:
                            # Attach private correlation locally; never request it from the model.
                            output_code = _CodeOutput.model_validate_json(json.dumps(data))
                            assert isinstance(request, CodeModelRequest)
                            proposal = CodeProposal(
                                job_id=request.job_id,
                                revision=request.revision,
                                explanation=output_code.explanation,
                                files=output_code.files,
                            )
                            names = {file.name for file in proposal.files}
                            if (
                                request.mode == "create_focus_project"
                                and names
                                != {"index.html", "focus.js", "focus.test.mjs", "README.md"}
                                or request.mode == "replace_focus_file"
                                and names != {request.target}
                            ):
                                raise ValueError
                            result = proposal
                        else:
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
            result = self._error(
                request,
                code,
                ProviderDiagnostic(stage=stage, category=failure_category(exc))
                if code == "runtime_error"
                else None,
            )
        finally:
            token = None
            if unsubscribe is not None:
                unsubscribe()
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
        if overflow:
            return self._error(request, "malformed_output")
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

    def _error(
        self,
        request: ReasoningRequest | CodeModelRequest,
        code: str,
        diagnostic: ProviderDiagnostic | None = None,
    ) -> ReasoningResult:
        self._checked = False
        self._fault = code
        self._diagnostic = diagnostic
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
            self._diagnostic = None
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
