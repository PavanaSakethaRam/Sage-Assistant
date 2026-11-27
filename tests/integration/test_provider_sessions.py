"""Owned artifacts only: deletion, crash recovery and cleanup failures stay visible."""

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest

from sage.providers.session_store import SessionStore
from tests.helpers.copilot_fake import FakeSdk
from tests.unit.test_provider_contract import backend, request


@pytest.mark.parametrize("crash", [False, True])
def test_session_artifacts_removed_on_success_or_worker_crash(tmp_path: Path, crash: bool) -> None:
    sdk = FakeSdk()
    sdk.error = OSError("synthetic-private-marker") if crash else None
    provider = backend(tmp_path, sdk)
    asyncio.run(provider.reason(request()))
    assert list((tmp_path / "sessions").iterdir()) == []
    assert sdk.deleted == []
    assert sdk.disconnected == 1
    assert sdk.stopped == 1


def test_restart_cleanup_preserves_unrelated_files_and_symlink_target(tmp_path: Path) -> None:
    root = tmp_path / "owned"
    sessions = SessionStore(root)
    path = sessions.create("r1")
    (path / "text").write_text("synthetic-private-marker")
    unrelated = root / "unrelated"
    unrelated.mkdir()
    (unrelated / "keep").write_text("unrelated")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep").write_text("unrelated")
    (path / "link").symlink_to(outside, target_is_directory=True)
    SessionStore(root).recover_cleanup()
    assert not path.exists()
    assert (unrelated / "keep").read_text() == "unrelated"
    assert (outside / "keep").read_text() == "unrelated"


@pytest.mark.parametrize("request_id", ["../outside", "/absolute", "a/b", "", ".", "a\\b"])
def test_session_ids_cannot_escape_root(tmp_path: Path, request_id: str) -> None:
    with pytest.raises(ValueError):
        SessionStore(tmp_path / "owned").create(request_id)
    assert not (tmp_path / "owned").exists()


def test_readonly_cleanup_failure_is_visible(tmp_path: Path) -> None:
    sdk = FakeSdk()
    provider = backend(tmp_path, sdk)
    with patch("sage.providers.session_store.shutil.rmtree", side_effect=PermissionError):
        result = asyncio.run(provider.reason(request()))
    assert result.status == "error"
    assert result.text == "session_cleanup_failed"
    assert result.proposal is None
    assert provider.readiness().status == "incompatible"
    SessionStore(tmp_path / "sessions").recover_cleanup()
    assert list((tmp_path / "sessions").iterdir()) == []


def test_failed_runtime_disconnect_is_not_success(tmp_path: Path) -> None:
    sdk = FakeSdk()
    sdk.delete_error = True
    provider = backend(tmp_path, sdk)
    result = asyncio.run(provider.reason(request()))
    assert result.status == "error"
    assert result.text == "session_cleanup_failed"
    assert provider.readiness().status == "incompatible"
    assert sdk.stopped == 1


def test_memory_history_never_touches_disk_and_disposal_rejects_reads(tmp_path: Path) -> None:
    from sage.providers.session_store import MemorySessionFs

    async def run() -> None:
        ram = MemorySessionFs()
        await ram.write_file("/sage/state/session/events", "private", 0o600)
        await ram.append_file("/sage/state/session/events", " marker")
        assert await ram.read_file("/sage/state/session/events") == "private marker"
        assert (await ram.stat("/sage/state/session/events")).size == 14
        assert await ram.readdir("/sage/state/session") == ["events"]
        entry = (await ram.readdir_with_types("/sage/state/session"))[0]
        assert entry.name == "events" and entry.type.value == "file"
        await ram.rename("/sage/state/session", "/sage/state/renamed")
        assert not await ram.exists("/sage/state/session/events")
        assert await ram.read_file("/sage/state/renamed/events") == "private marker"
        with pytest.raises(OSError):
            await ram.rm("/sage/state/renamed", recursive=False, force=False)
        await ram.rm("/sage/state/renamed", recursive=True, force=False)
        await ram.rm("/sage/state/missing", recursive=False, force=True)
        assert not await ram.exists("/sage/state/renamed")
        with pytest.raises(FileNotFoundError):
            await ram.read_file("/sage/state/renamed/events")
        await ram.write_file("/sage/state/current", "private marker")
        ram.dispose()
        with pytest.raises(ValueError):
            await ram.read_file("/sage/state/current")
        assert list(tmp_path.iterdir()) == []

    asyncio.run(run())


@pytest.mark.parametrize(
    "path", ["/etc/passwd", "../foo", "/sage/../other", "/sage/a\\b", "/sage/\x00"]
)
def test_memory_filesystem_refuses_host_paths(path: str) -> None:
    from sage.providers.session_store import MemorySessionFs

    with pytest.raises(ValueError):
        asyncio.run(MemorySessionFs().write_file(path, "private marker"))


def test_memory_filesystem_bounds_are_atomic() -> None:
    from sage.providers.session_store import MemorySessionFs

    async def run() -> None:
        ram = MemorySessionFs()
        await ram.write_file("/sage/state/a", "keep")
        with pytest.raises(OSError):
            await ram.write_file("/sage/state/a", "x" * 8_388_609)
        assert await ram.read_file("/sage/state/a") == "keep"
        for number in range(511):
            await ram.write_file(f"/sage/state/f{number}", "x")
        with pytest.raises(OSError):
            await ram.write_file("/sage/state/excess", "x")
        assert not await ram.exists("/sage/state/excess")

    asyncio.run(run())


def test_memory_atomic_rename_replaces_existing_file() -> None:
    from sage.providers.session_store import MemorySessionFs

    async def run() -> None:
        ram = MemorySessionFs()
        await ram.write_file("/sage/state/file", "old")
        await ram.write_file("/sage/state/file.tmp", "new")
        await ram.rename("/sage/state/file.tmp", "/sage/state/file")
        assert await ram.read_file("/sage/state/file") == "new"
        assert not await ram.exists("/sage/state/file.tmp")

    asyncio.run(run())


def test_failed_shutdown_forces_owned_runtime_and_blocks_ready(tmp_path: Path) -> None:
    sdk = FakeSdk()
    sdk.stop_error = True
    provider = backend(tmp_path, sdk)
    result = asyncio.run(provider.reason(request()))
    assert sdk.forced == 1
    assert result.status == "error" and result.text == "session_cleanup_failed"
    assert provider.readiness().status == "incompatible"
    assert list((tmp_path / "sessions").iterdir()) == []


def test_symlink_and_unowned_roots_are_never_cleaned(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep").write_text("unrelated")
    link = tmp_path / "link"
    link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(OSError):
        SessionStore(link).create("r1")
    with pytest.raises(OSError):
        SessionStore(link).recover_cleanup()
    owned = SessionStore(tmp_path / "owned")
    owned.root.mkdir()
    (owned.root / "sage-r1").symlink_to(outside, target_is_directory=True)
    with pytest.raises(OSError):
        owned.cleanup("r1")
    (owned.root / "sage-r2").mkdir()
    (owned.root / "sage-r2" / "keep").write_text("unrelated")
    with pytest.raises(OSError):
        owned.cleanup("r2")
    owned.recover_cleanup()
    assert (outside / "keep").read_text() == "unrelated"
    assert (owned.root / "sage-r2" / "keep").read_text() == "unrelated"
    owned.cleanup("missing")


def test_virtual_filesystem_type_errors_preserve_existing_content() -> None:
    from sage.providers.session_store import MemorySessionFs

    async def run() -> None:
        ram = MemorySessionFs()
        await ram.write_file("/sage/state/file", "keep")
        for operation in (
            ram.write_file("/sage/state", "bad"),
            ram.mkdir("/sage/state/file", False),
            ram.mkdir("/sage/missing/child", False),
            ram.readdir("/sage/missing"),
            ram.stat("/sage/missing"),
            ram.rm("/sage/missing", False, False),
            ram.rename("/sage", "/sage/child"),
            ram.rename("/sage/state", "/sage/state/sub"),
            ram.rename("/sage/work", "/sage/state/file"),
            ram.rm("/sage", True, False),
        ):
            with pytest.raises((OSError, ValueError)):
                await operation
        assert await ram.read_file("/sage/state/file") == "keep"
        for number in range(509):
            await ram.mkdir(f"/sage/dir{number}", False)
        with pytest.raises(OSError):
            await ram.mkdir("/sage/excess", False)
        assert not await ram.exists("/sage/excess")

    asyncio.run(run())
