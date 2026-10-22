"""Owned Windows descriptors and trusted deployment runtime startup."""

import json
import os
from pathlib import Path
from typing import Any, cast

import pytest
from pydantic import ValidationError

from sage.contracts import NoteContent
from sage.providers.protected_auth import ProtectedSource


def test_shared_unicode_parity() -> None:
    rows = json.loads(
        (Path(__file__).parents[1] / "fixtures/text-parity.json").read_text(encoding="utf-8")
    )
    for row in rows:
        if row["valid"]:
            assert NoteContent(title=row["title"], body=row["body"]).model_dump() == {
                "title": row["title"],
                "body": row["body"],
            }
        else:
            with pytest.raises(ValidationError):
                NoteContent(title=row["title"], body=row["body"])


def test_windows_pipe_owns_only_noninheritable_duplicate(monkeypatch: pytest.MonkeyPatch) -> None:
    import sage.__main__ as entry

    read, write = os.pipe()
    try:
        wrapper = entry.WindowsPipe(read, handle_of=lambda fd: fd + 10000)
        duplicate = wrapper.descriptor
        assert duplicate != read and not os.get_inheritable(duplicate)
        assert wrapper.fileno() == duplicate + 10000
        wrapper.close()
        wrapper.close()
        with pytest.raises(OSError):
            os.fstat(duplicate)
        os.fstat(read)
    finally:
        os.close(read)
        os.close(write)


def test_windows_pipe_failed_conversion_closes_duplicate(monkeypatch: pytest.MonkeyPatch) -> None:
    import sage.__main__ as entry

    duplicated: list[int] = []
    original = os.dup

    def duplicate(fd: int) -> int:
        result = original(fd)
        duplicated.append(result)
        return result

    def failure(fd: int) -> int:
        raise OSError("synthetic")

    monkeypatch.setattr(os, "dup", duplicate)
    with pytest.raises(OSError):
        entry.WindowsPipe(0, handle_of=failure)
    with pytest.raises(OSError):
        os.fstat(duplicated[0])


def test_runtime_cli_is_absolute_and_not_rpc_input(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sage.__main__ as entry

    calls: list[Any] = []

    async def run(
        root: Path | None, runtime_path: Path | None = None, gh_path: Path | None = None
    ) -> None:
        calls.append((root, runtime_path, gh_path))

    monkeypatch.setattr(entry, "_run", run)
    monkeypatch.setattr(
        "sys.argv",
        ["sage", "--root", str(tmp_path), "--copilot-runtime", str(tmp_path / "runtime")],
    )
    assert entry.main() == 0
    assert calls == [(tmp_path, tmp_path / "runtime", None)]
    monkeypatch.setattr("sys.argv", ["sage", "--copilot-runtime", "relative"])
    with pytest.raises(SystemExit):
        entry.main()


@pytest.mark.parametrize("fail_output", [False, True])
def test_windows_startup_registers_owned_handles_and_closes_partial_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fail_output: bool
) -> None:
    import asyncio
    import io
    import sys

    import sage.__main__ as entry

    wrappers: list[entry.WindowsPipe] = []
    received: list[object] = []
    original = entry.WindowsPipe

    def wrap(fd: int) -> entry.WindowsPipe:
        owner = original(fd, handle_of=lambda duplicate: duplicate + 10000)
        wrappers.append(owner)
        return owner

    class Transport:
        def close(self) -> None:
            pass

        def is_closing(self) -> bool:
            return True

    class Loop:
        def create_future(self) -> asyncio.Future[None]:
            return asyncio.get_event_loop().create_future()

        async def connect_read_pipe(self, factory: object, pipe: object) -> tuple[Any, Any]:
            received.append(pipe)
            return Transport(), None

        async def connect_write_pipe(self, factory: object, pipe: object) -> tuple[Any, Any]:
            received.append(pipe)
            if fail_output:
                raise OSError("synthetic")
            return Transport(), None

    async def service(reader: object, writer: object, core: Any) -> None:
        assert core.backend.runtime_path == tmp_path / "native"
        assert core.backend._clock == core.clock
        assert core.backend._token_source is None
        await core.select_account(
            {
                "version": 1,
                "kind": "host_copilot_selection",
                "id": "selection",
                "boot_id": "a" * 32,
                "generation": 1,
                "account": {"host": "github.com", "login": "synthetic-user"},
            }
        )
        assert core.backend._clock == core.clock
        selected_source = cast(ProtectedSource, core.backend._token_source)
        assert selected_source.executable == tmp_path / "managed-gh"
        assert selected_source.root == tmp_path / "cache/gh-protected"
        assert selected_source.login == "synthetic-user"

    async def run() -> None:
        read, write = os.pipe()
        try:
            with monkeypatch.context() as patch:
                patch.setattr(sys, "stdin", io.TextIOWrapper(os.fdopen(os.dup(read), "rb")))
                patch.setattr(sys, "stdout", io.TextIOWrapper(os.fdopen(os.dup(write), "wb")))
                patch.setattr(sys, "platform", "win32")
                patch.setattr(entry, "WindowsPipe", wrap)
                patch.setattr(entry, "run_service", service)
                patch.setattr(asyncio, "get_running_loop", Loop)
                if fail_output:
                    with pytest.raises(OSError):
                        await entry._run(tmp_path, tmp_path / "native", tmp_path / "managed-gh")
                else:
                    await entry._run(tmp_path, tmp_path / "native", tmp_path / "managed-gh")
            assert received == wrappers and len(wrappers) == 2
            for wrapper in wrappers:
                with pytest.raises(OSError):
                    os.fstat(wrapper.descriptor)
                with pytest.raises(ValueError):
                    wrapper.fileno()
            os.fstat(read)
            os.fstat(write)
        finally:
            os.close(read)
            os.close(write)

    asyncio.run(run())
