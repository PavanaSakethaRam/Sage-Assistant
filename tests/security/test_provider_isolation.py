"""Removing tool/env restrictions would enable this fake SDK's observable effects."""

import asyncio
from pathlib import Path

from tests.helpers.copilot_fake import FakeSdk
from tests.unit.test_provider_contract import backend, request


def test_empty_mode_and_no_ambient_tools(tmp_path: Path) -> None:
    sdk = FakeSdk()
    asyncio.run(backend(tmp_path, sdk).reason(request()))
    assert sdk.client_options["mode"] == "empty"
    assert sdk.client_options["use_logged_in_user"] is False
    assert sdk.session_options["available_tools"] == []
    assert sdk.session_options["tools"] == []
    assert sdk.session_options["mcp_servers"] == {}
    assert sdk.session_options["custom_agents"] == []
    for name in (
        "enable_skills",
        "enable_file_hooks",
        "enable_host_git_operations",
        "enable_session_store",
        "enable_config_discovery",
        "enable_on_demand_instruction_discovery",
        "enable_session_telemetry",
    ):
        assert sdk.session_options[name] is False
    assert sdk.effects == []
    env = sdk.client_options["env"]
    assert env["COPILOT_SKIP_CLI_DOWNLOAD"] == "1"
    assert env["COPILOT_GITHUB_TELEMETRY_DISABLED"] == "true"
    assert "GITHUB_TOKEN" not in env and "GH_TOKEN" not in env
    assert "PATH" not in env and "HOME" not in env
    assert sdk.session_options["github_token"] == "gho_synthetic"
    assert "github_token" not in sdk.client_options


def test_unexpected_permissions_denied(tmp_path: Path) -> None:
    sdk = FakeSdk()
    sdk.permission = True
    result = asyncio.run(backend(tmp_path, sdk).reason(request()))
    assert sdk.effects == []
    assert result.status == "error"
    assert result.text == "permission_denied"
    assert result.proposal is None


def test_sdk_diagnostics_cannot_leak_content(
    tmp_path: Path, capsys: object, caplog: object
) -> None:
    import logging
    from typing import Any, cast

    sdk = FakeSdk()
    original = sdk.client

    def client(**kwargs: Any) -> Any:
        logging.getLogger("copilot.session").warning("synthetic-private-marker")
        return original(**kwargs)

    provider = backend(tmp_path, sdk)
    provider._client_factory = client
    asyncio.run(provider.reason(request()))
    captured = cast(Any, capsys).readouterr()
    assert "synthetic-private-marker" not in captured.out + captured.err
    assert not any(
        "synthetic-private-marker" in record.getMessage() for record in cast(Any, caplog).records
    )


def test_local_core_never_invokes_configured_cloud_backend(tmp_path: Path) -> None:
    from sage.service import CoreService
    from sage.storage import Store
    from tests.integration.test_reasoning_service import rpc

    async def run() -> None:
        sdk = FakeSdk()
        provider = backend(tmp_path, sdk)
        service = CoreService(Store.open(tmp_path / "store.sqlite"), backend=provider)
        for identifier, method, params in [
            ("reason", "reasoning.start", {"backend": "copilot", "user_text": "private"}),
            ("check", "connection.test", {}),
        ]:
            result = await service.dispatch(rpc(identifier, method, params))
            assert result["result"] == {"status": "unavailable", "code": "inference_unavailable"}
        assert sdk.created == 0 and sdk.prompts == []
        with service.store.transaction() as db:
            assert db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        await service.aclose()

    asyncio.run(run())


def test_connection_check_rejects_caller_prompt_and_context(tmp_path: Path) -> None:
    from sage.service import CoreService
    from sage.storage import Store
    from tests.integration.test_reasoning_service import rpc

    async def run() -> None:
        sdk = FakeSdk()
        provider = backend(tmp_path, sdk)
        service = CoreService(Store.open(tmp_path / "store.sqlite"), backend=provider)
        await service.dispatch(
            rpc("s", "settings.update", {"ai_mode": "assistant", "reasoning_backend": "copilot"})
        )
        invalid_params: list[dict[str, object]] = [
            {"prompt": "private"},
            {"attached_context": ["private"]},
            {"token": "private"},
            {"backend": "copilot"},
            {"model": "x"},
        ]
        for number, params in enumerate(invalid_params):
            result = await service.dispatch(rpc(f"check{number}", "connection.test", params))
            assert result["kind"] == "error" and result["code"] == "invalid_request"
        assert sdk.created == 0 and sdk.prompts == []
        await service.aclose()

    asyncio.run(run())
