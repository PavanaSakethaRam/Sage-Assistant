"""Literal coding examples for boundary tests; never imported by product code."""

from typing import Any

HASH = "a" * 64
BINDING = {
    "job_id": "job-1",
    "boot_id": "boot-1",
    "pair_id": "pair-1",
    "window_id": "window-1",
    "root_id": "root-1",
    "revision": 1,
    "policy_version": "code-v1",
}


def make_file(**overrides: Any) -> dict[str, Any]:
    return {
        "name": "index.html",
        "text": "<main>Focus</main>\n",
        "text_hash": HASH,
        "disk_hash": HASH,
        "document_version": 1,
        "file_id": "file-1",
        **overrides,
    }


def make_context(**overrides: Any) -> dict[str, Any]:
    return {
        "binding": BINDING.copy(),
        "mode": "create_focus_project",
        "root_uri": "file:///private/owner-marker/focus",
        "root_file_id": "root-file-1",
        "files": [],
        "context_hash": HASH,
        **overrides,
    }


def make_proposal(**overrides: Any) -> dict[str, Any]:
    return {
        "job_id": "job-1",
        "revision": 1,
        "explanation": "A simple focus tracker.",
        "files": [
            {"name": "index.html", "text": "<main>Focus</main>\n"},
            {"name": "focus.js", "text": "export const focus = true;\n"},
            {"name": "focus.test.mjs", "text": "import { test } from 'node:test';\n"},
            {"name": "README.md", "text": "# Focus\n"},
        ],
        **overrides,
    }


def make_receipt(**overrides: Any) -> dict[str, Any]:
    return {
        "binding": BINDING.copy(),
        "operation_id": "operation-1",
        "effect_id": "effect-1",
        "scope": "code.create",
        "target": "index.html",
        "ordinal": 0,
        "expected_hash": HASH,
        "status": "created",
        "observed_hash": HASH,
        "observed_length": 12,
        **overrides,
    }


class DeferredCodingBackend:
    """Constructor-injected double; no local product backend or runtime."""

    def __init__(self) -> None:
        import asyncio

        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.requests: list[Any] = []
        self.closed = 0
        self.cancelled: list[str] = []
        self.swallow = False
        self.error: Exception | None = None

    def coding_readiness(self) -> Any:
        from sage.contracts import ProviderReadiness

        return ProviderReadiness(
            provider="copilot",
            status="not_configured",
            evidence=(),
            explanation="explicit_connection_check_required",
        )

    async def propose_code(self, request: Any) -> Any:
        import asyncio

        from sage.coding_contracts import CodeProposal

        self.requests.append(request)
        self.entered.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            if not self.swallow:
                raise
            await self.release.wait()
        if self.error:
            raise self.error
        return CodeProposal.model_validate(
            make_proposal(job_id=request.job_id, revision=request.revision)
        )

    async def cancel(self, request_id: str) -> None:
        self.cancelled.append(request_id)

    async def aclose(self) -> None:
        self.closed += 1
