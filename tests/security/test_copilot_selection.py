"""Private parent selection cannot be forged through the renderer request schema."""

import asyncio
from pathlib import Path

import pytest

from sage.protocol import ProtocolError, SelectedAccount, request
from sage.providers.copilot import CopilotReasoner
from sage.service import CoreService
from sage.storage import Store
from tests.helpers.copilot_fake import FakeSdk
from tests.unit.test_provider_contract import backend


def frame(**changes: object) -> dict[str, object]:
    return {
        "version": 1,
        "kind": "host_copilot_selection",
        "id": "selection",
        "boot_id": "a" * 32,
        "generation": 1,
        "account": {"host": "github.com", "login": "synthetic-user"},
        **changes,
    }


def test_renderer_requests_reject_private_selection() -> None:
    with pytest.raises(ProtocolError):
        request(frame())


def test_private_selection_closed_schema_boot_generation_replay(tmp_path: Path) -> None:
    async def run() -> None:
        service = CoreService(Store.open(tmp_path / "state.sqlite3"))
        good = await service.select_account(frame())
        assert good["result"] == {"generation": 1, "status": "unavailable"}
        for bad in [
            frame(),
            frame(id="new"),
            frame(id="b", generation=2, boot_id="b" * 32),
            frame(id="c", generation=True),
            frame(id="d", generation=2, token="secret"),
            frame(id="e", generation=2, account={"host": "evil.com", "login": "x"}),
            frame(id="f", generation=2, account={"host": "github.com", "login": "--evil"}),
            frame(
                id="g",
                generation=2,
                account={"host": "github.com", "login": "x", "token": "secret"},
            ),
            frame(id="h", generation=2, account={"host": "github.com", "login": "x" * 1000}),
        ]:
            assert (await service.select_account(bad))["kind"] == "error"
        assert (await service.select_account(frame(id="clear", generation=2, account=None)))[
            "result"
        ] == {"generation": 2, "status": "cleared"}
        await service.aclose()

    asyncio.run(run())


def test_selection_replaces_closes_old_backend_and_invalidates_readiness(tmp_path: Path) -> None:
    async def run() -> None:
        sdks: list[FakeSdk] = []
        providers: list[CopilotReasoner] = []

        def factory(account: SelectedAccount | None) -> CopilotReasoner:
            root = tmp_path / f"source-{len(sdks)}"
            root.mkdir()
            sdk = FakeSdk()
            sdk.output = '{"text":"Sage connection check","proposal":null}'
            sdks.append(sdk)
            provider = backend(root, sdk, auth=account is not None)
            providers.append(provider)
            return provider

        service = CoreService(Store.open(tmp_path / "state.sqlite3"), backend_factory=factory)
        await service.dispatch(
            {
                "version": 1,
                "kind": "request",
                "id": "settings",
                "method": "settings.update",
                "params": {"ai_mode": "assistant", "reasoning_backend": "copilot"},
            }
        )
        assert (await service.select_account(frame()))["result"] == {
            "generation": 1,
            "status": "selected",
        }
        assert providers[-1].readiness().status == "not_configured"
        assert sdks[-1].created == 0
        await service.dispatch(
            {
                "version": 1,
                "kind": "request",
                "id": "check",
                "method": "connection.test",
                "params": {},
            }
        )
        assert providers[-1].readiness().status == "ready"
        old = providers[-1]
        await service.select_account(
            frame(id="replace", generation=2, account={"host": "github.com", "login": "other"})
        )
        assert old.readiness().status == "unavailable"
        assert providers[-1].readiness().status == "not_configured"
        await service.dispatch(
            {
                "version": 1,
                "kind": "request",
                "id": "local",
                "method": "settings.update",
                "params": {"ai_mode": "local", "reasoning_backend": None},
            }
        )
        assert (
            providers[-1].readiness().status == "auth_required"
        )  # injected fixture settings stay assistant; source cleared
        assert sdks[-1].created == 0
        await service.aclose()

    asyncio.run(run())


def test_replacement_waits_for_old_acquisition_cancellation_before_ack(tmp_path: Path) -> None:
    async def run() -> None:
        root = tmp_path / "provider"
        root.mkdir()
        sdk = FakeSdk()
        provider = backend(root, sdk)
        entered, cleaned = asyncio.Event(), asyncio.Event()

        async def source(*_: object) -> str:
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()
            return "gho_late"

        provider._token_source = source
        service = CoreService(
            Store.open(tmp_path / "state.sqlite3"),
            backend=provider,
            backend_factory=lambda _: backend(tmp_path / "new", FakeSdk()),
        )
        (tmp_path / "new").mkdir()
        await service.dispatch(
            {
                "version": 1,
                "kind": "request",
                "id": "settings",
                "method": "settings.update",
                "params": {"ai_mode": "assistant", "reasoning_backend": "copilot"},
            }
        )
        task = asyncio.create_task(
            service.dispatch(
                {
                    "version": 1,
                    "kind": "request",
                    "id": "infer",
                    "method": "reasoning.start",
                    "params": {"backend": "copilot", "user_text": "synthetic"},
                }
            )
        )
        await entered.wait()
        assert (await service.select_account(frame()))["result"] == {
            "generation": 1,
            "status": "selected",
        }
        assert cleaned.is_set() and sdk.created == 0
        await task
        assert service.store.list_notes() == []
        await service.aclose()

    asyncio.run(run())


def test_selection_shared_fixtures_are_closed_and_never_renderer_requests() -> None:
    import json

    from sage.protocol import selection

    fixtures = json.loads(
        (Path(__file__).parents[1] / "fixtures/copilot-selection.json").read_text()
    )
    for row in fixtures:
        if row["valid"]:
            assert selection(row["frame"]).model_dump() == row["frame"]
        else:
            with pytest.raises(ProtocolError):
                selection(row["frame"])
        with pytest.raises(ProtocolError):
            request(row["frame"])


def test_nonassistant_selection_cannot_survive_local_to_assistant_without_fresh_choice(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        selected: list[str | None] = []

        def factory(account: SelectedAccount | None) -> CopilotReasoner:
            selected.append(account.login if account else None)
            root = tmp_path / f"generation-{len(selected)}"
            root.mkdir()
            return backend(root, FakeSdk(), auth=account is not None)

        service = CoreService(Store.open(tmp_path / "state.sqlite3"), backend_factory=factory)

        def settings(identifier: str, mode: str) -> dict[str, object]:
            return {
                "version": 1,
                "kind": "request",
                "id": identifier,
                "method": "settings.update",
                "params": {
                    "ai_mode": mode,
                    "reasoning_backend": "copilot" if mode == "assistant" else None,
                },
            }

        try:
            assert (await service.select_account(frame()))["result"] == {
                "generation": 1,
                "status": "unavailable",
            }
            assert selected == []
            await service.dispatch(settings("assistant", "assistant"))
            assert selected == []
            assert (await service.select_account(frame(id="fresh", generation=2)))["result"] == {
                "generation": 2,
                "status": "selected",
            }
            await service.dispatch(settings("local", "local"))
            assert selected[-1] is None
            assert (await service.select_account(frame(id="stale", generation=3)))["result"] == {
                "generation": 3,
                "status": "unavailable",
            }
            await service.dispatch(settings("assistant-again", "assistant"))
            assert selected[-1] is None
            assert (await service.select_account(frame(id="fresh-again", generation=4)))[
                "result"
            ] == {"generation": 4, "status": "selected"}
        finally:
            await service.aclose()

    asyncio.run(run())


def test_private_clear_disposes_eight_running_requests_before_ack(tmp_path: Path) -> None:
    from sage.protocol import encode_frame, read_frame
    from sage.service import run_service

    async def run() -> None:
        sdks: list[FakeSdk] = []
        providers: list[CopilotReasoner] = []

        def factory(account: SelectedAccount | None) -> CopilotReasoner:
            path = tmp_path / f"source-{len(sdks)}"
            path.mkdir()
            sdk = FakeSdk()
            sdk.gate = asyncio.Event()
            sdks.append(sdk)
            provider = backend(path, sdk, auth=account is not None)
            providers.append(provider)
            return provider

        service = CoreService(Store.open(tmp_path / "state.sqlite3"), backend_factory=factory)
        incoming, output = asyncio.StreamReader(), asyncio.StreamReader()

        class Writer:
            def write(self, data: bytes) -> None:
                output.feed_data(data)

            async def drain(self) -> None:
                await asyncio.sleep(0)

            def close(self) -> None:
                output.feed_eof()

            async def wait_closed(self) -> None:
                pass

        loop = asyncio.create_task(run_service(incoming, Writer(), service))
        try:
            incoming.feed_data(
                encode_frame(
                    {
                        "version": 1,
                        "kind": "request",
                        "id": "assistant",
                        "method": "settings.update",
                        "params": {"ai_mode": "assistant", "reasoning_backend": "copilot"},
                    }
                )
            )
            await read_frame(output)
            incoming.feed_data(encode_frame(frame()))
            assert (await read_frame(output))["result"] == {"generation": 1, "status": "selected"}
            for i in range(8):
                incoming.feed_data(
                    encode_frame(
                        {
                            "version": 1,
                            "kind": "request",
                            "id": f"work-{i}",
                            "method": "reasoning.start",
                            "params": {"backend": "copilot", "user_text": "synthetic"},
                        }
                    )
                )
            async with asyncio.timeout(2):
                while sdks[0].created != 8 or len(service._inflight) != 8:
                    await asyncio.sleep(0)
                incoming.feed_data(encode_frame(frame(id="clear", generation=2, account=None)))
                while True:
                    response = await read_frame(output)
                    if response["id"] == "clear":
                        assert response["result"] == {"generation": 2, "status": "cleared"}
                        break
                assert sdks[0].stopped == 8
                assert providers[0].readiness().status == "unavailable"
                assert providers[1].readiness().status == "auth_required"
                assert service.store.list_notes() == []
        finally:
            incoming.feed_eof()
            await loop
            await service.aclose()

    asyncio.run(run())
