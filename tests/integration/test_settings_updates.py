"""Partial Setup preferences preserve unrelated persisted settings and authority gates."""

import asyncio
import json
from pathlib import Path
from typing import Any, cast

import pytest

from sage.contracts import ProviderReadiness
from sage.service import CoreService
from sage.storage import Store
from tests.helpers.coding_fake import DeferredCodingBackend
from tests.integration.test_coding_provider import capture
from tests.integration.test_reasoning_service import DeferredBackend, rpc


async def update(core: CoreService, identifier: str, patch: dict[str, Any]) -> dict[str, Any]:
    reply = await core.dispatch(rpc(identifier, "settings.update", patch))
    assert reply["kind"] == "response", reply
    return cast(dict[str, Any], reply["result"])


async def assert_persisted(core: CoreService, expected: dict[str, Any]) -> None:
    reply = await core.dispatch(rpc(f"get-{len(core._seen)}", "settings.get", {}))
    assert reply["result"] == expected
    assert core.get_settings().model_dump(mode="json") == expected
    with core.store.transaction() as db:
        assert (
            json.loads(db.execute("SELECT data_json FROM settings WHERE id=1").fetchone()[0])
            == expected
        )


@pytest.mark.parametrize("coding_first", [False, True])
def test_setup_partial_updates_preserve_the_other_preference(
    tmp_path: Path, coding_first: bool
) -> None:
    async def run() -> None:
        core = CoreService(Store.open(tmp_path / "core.sqlite"))
        patches: list[dict[str, object]] = [
            {"ai_mode": "assistant", "reasoning_backend": "copilot"},
            {"coding_backend": "copilot", "coding_model": None},
        ]
        try:
            for index, patch in enumerate(reversed(patches) if coding_first else patches):
                await update(core, f"setup-{index}", patch)
            await assert_persisted(
                core,
                {
                    "ai_mode": "assistant",
                    "reasoning_backend": "copilot",
                    "coding_backend": "copilot",
                    "coding_model": None,
                },
            )
            await update(core, "model", {"coding_model": "synthetic-model"})
            await assert_persisted(
                core,
                {
                    "ai_mode": "assistant",
                    "reasoning_backend": "copilot",
                    "coding_backend": "copilot",
                    "coding_model": "synthetic-model",
                },
            )
            await update(core, "null", {"coding_model": None})
            generation = core._generation
            await update(core, "empty", {})
            assert core._generation == generation + 1
            await assert_persisted(
                core,
                {
                    "ai_mode": "assistant",
                    "reasoning_backend": "copilot",
                    "coding_backend": "copilot",
                    "coding_model": None,
                },
            )
            await update(core, "local", {"ai_mode": "local", "reasoning_backend": None})
            await assert_persisted(
                core,
                {
                    "ai_mode": "local",
                    "reasoning_backend": None,
                    "coding_backend": "copilot",
                    "coding_model": None,
                },
            )
            readiness = await core.dispatch(rpc("ready", "coding.readiness", {}))
            assert cast(dict[str, Any], readiness["result"])["status"] == "unavailable"
            with core.store.transaction() as db:
                assert db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
                assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 0
        finally:
            await core.aclose()

    asyncio.run(run())


@pytest.mark.parametrize(
    "patch",
    [
        {"unknown": "private"},
        {"ai_mode": "invalid"},
        {"ai_mode": None},
        {"coding_backend": "api"},
        {"coding_model": "x" * 201},
        {"coding_model": "private\0value"},
        {"reasoning_backend": "invalid"},
        {"ai_mode": "local"},
    ],
)
def test_invalid_patch_preserves_settings_and_inflight_authority(
    tmp_path: Path, patch: dict[str, Any]
) -> None:
    async def run() -> None:
        backend = DeferredBackend()
        core = CoreService(Store.open(tmp_path / "core.sqlite"), backend=backend)
        pending: asyncio.Task[dict[str, object]] | None = None
        try:
            await update(
                core, "assistant", {"ai_mode": "assistant", "reasoning_backend": "copilot"}
            )
            pending = asyncio.create_task(
                core.dispatch(
                    rpc(
                        "reason",
                        "reasoning.start",
                        {"backend": "copilot", "user_text": "synthetic"},
                    )
                )
            )
            await backend.started.wait()
            capture(core)
            coding_before = core.coding.get("job-1")
            context_before = core.coding._context
            before = core.get_settings().model_dump(mode="json")
            await assert_persisted(core, before)
            generation = core._generation
            response = await core.dispatch(rpc("invalid", "settings.update", patch))
            assert response == {
                "version": 1,
                "kind": "error",
                "id": "invalid",
                "code": "invalid_request",
            }
            await assert_persisted(core, before)
            assert core._generation == generation
            assert core.coding.get("job-1") == coding_before
            assert core.coding._context is context_before
            assert core.backend is backend and not backend.closed and not backend.cancelled
            backend.finish.set()
            reply = await pending
            assert cast(dict[str, Any], reply["result"])["status"] == "completed"
            with core.store.transaction() as db:
                assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 1
        finally:
            backend.finish.set()
            if pending is not None:
                await pending
            await core.aclose()

    asyncio.run(run())


def test_concurrent_partial_updates_read_current_settings_under_selection_lock(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        core = CoreService(Store.open(tmp_path / "core.sqlite"))
        try:
            await core._selection_lock.acquire()
            first = asyncio.create_task(
                update(core, "mode", {"ai_mode": "assistant", "reasoning_backend": "copilot"})
            )
            second = asyncio.create_task(
                update(
                    core, "coding", {"coding_backend": "copilot", "coding_model": "synthetic-model"}
                )
            )
            await asyncio.sleep(0)
            assert not first.done() and not second.done()
            core._selection_lock.release()
            await asyncio.gather(first, second)
            await assert_persisted(
                core,
                {
                    "ai_mode": "assistant",
                    "reasoning_backend": "copilot",
                    "coding_backend": "copilot",
                    "coding_model": "synthetic-model",
                },
            )
        finally:
            await core.aclose()

    asyncio.run(run())


def test_preferences_do_not_contact_inference_or_probe_cloud_readiness(tmp_path: Path) -> None:
    class UnusedReasoner(DeferredBackend):
        def readiness(self) -> ProviderReadiness:
            raise AssertionError("preferences must not probe reasoning readiness")

    class UnusedCoder(DeferredCodingBackend):
        def coding_readiness(self) -> ProviderReadiness:
            raise AssertionError("local mode must gate coding before provider readiness")

    async def run() -> None:
        reasoner, coder = UnusedReasoner(), UnusedCoder()
        core = CoreService(
            Store.open(tmp_path / "preferences.sqlite"), backend=reasoner, coding_backend=coder
        )
        try:
            await update(
                core,
                "local-coding",
                {"coding_backend": "copilot", "coding_model": "synthetic-model"},
            )
            response = await core.dispatch(rpc("local-ready", "coding.readiness", {}))
            assert cast(dict[str, Any], response["result"])["status"] == "unavailable"
            await update(
                core, "assistant", {"ai_mode": "assistant", "reasoning_backend": "copilot"}
            )
            await update(core, "coding", {"coding_backend": "none", "coding_model": None})
            assert not reasoner.requests and not coder.requests
            with core.store.transaction() as db:
                assert db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
                assert db.execute("SELECT COUNT(*) FROM coding_jobs").fetchone()[0] == 0
        finally:
            await core.aclose()

    asyncio.run(run())
