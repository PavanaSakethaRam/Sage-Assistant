"""Disposable Sage directories and a bounded RAM filesystem for SDK history."""

from __future__ import annotations

import re
import shutil
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from copilot.generated.rpc import SessionFSReaddirWithTypesEntry
    from copilot.session_fs_provider import SessionFsFileInfo

_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_MARKER = ".sage-disposable-session-v1"


class SessionStore:
    def __init__(self, root: Path) -> None:
        self.root = root.absolute()

    def _path(self, request_id: str) -> Path:
        if not _ID.fullmatch(request_id):
            raise ValueError("Invalid session identity")
        if self.root.is_symlink():
            raise OSError("Disposable root must not be a symlink")
        return self.root / ("sage-" + request_id)

    def create(self, request_id: str) -> Path:
        path = self._path(request_id)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.mkdir(mode=0o700)
        (path / _MARKER).write_text("sage-owned-disposable-v1", encoding="ascii")
        return path

    def cleanup(self, request_id: str) -> None:
        path = self._path(request_id)
        if path.is_symlink():
            raise OSError("Session directory must not be a symlink")
        if path.exists():
            marker = path / _MARKER
            if marker.is_symlink() or not marker.is_file():
                raise OSError("Unowned session directory")
            shutil.rmtree(path)

    def recover_cleanup(self) -> None:
        if self.root.is_symlink():
            raise OSError("Disposable root must not be a symlink")
        if self.root.exists():
            for path in self.root.iterdir():
                if (
                    path.name.startswith("sage-")
                    and not path.is_symlink()
                    and path.is_dir()
                    and (path / _MARKER).is_file()
                ):
                    self.cleanup(path.name[5:])


class MemorySessionFs:
    """Virtual POSIX paths regardless of host OS; never opens a host file."""

    def __init__(self) -> None:
        self._files: dict[str, str] = {}
        self._directories = {"/sage", "/sage/work", "/sage/state"}
        self._created = datetime.now(UTC)
        self._disposed = False

    def _path(self, path: str) -> str:
        value = PurePosixPath(path)
        if (
            self._disposed
            or not value.is_absolute()
            or ".." in value.parts
            or "\\" in path
            or "\x00" in path
            or not (str(value) == "/sage" or str(value).startswith("/sage/"))
        ):
            raise ValueError("Invalid virtual session path")
        return str(value)

    async def read_file(self, path: str) -> str:
        value = self._path(path)
        if value not in self._files:
            raise FileNotFoundError("Session file missing")
        return self._files[value]

    async def write_file(self, path: str, content: str, mode: int | None = None) -> None:
        value = self._path(path)
        if value in self._directories:
            raise IsADirectoryError("Session path is a directory")
        size = sum(len(text.encode("utf-8")) for key, text in self._files.items() if key != value)
        if (
            len(self._files) >= 512
            and value not in self._files
            or size + len(content.encode("utf-8")) > 8_388_608
        ):
            raise OSError("Session memory limit exceeded")
        await self.mkdir(str(PurePosixPath(value).parent), recursive=True)
        self._files[value] = content

    async def append_file(self, path: str, content: str, mode: int | None = None) -> None:
        value = self._path(path)
        await self.write_file(value, self._files.get(value, "") + content, mode)

    async def exists(self, path: str) -> bool:
        value = self._path(path)
        return value in self._files or value in self._directories

    async def stat(self, path: str) -> SessionFsFileInfo:
        from copilot.session_fs_provider import SessionFsFileInfo

        value = self._path(path)
        if not await self.exists(value):
            raise FileNotFoundError("Session path missing")
        return SessionFsFileInfo(
            value in self._files,
            value in self._directories,
            len(self._files.get(value, "").encode("utf-8")),
            self._created,
            self._created,
        )

    async def mkdir(self, path: str, recursive: bool, mode: int | None = None) -> None:
        value = self._path(path)
        if value in self._files:
            raise FileExistsError("Session file already exists")
        parent = str(PurePosixPath(value).parent)
        if parent != "/" and parent not in self._directories:
            if not recursive:
                raise FileNotFoundError("Session parent missing")
            await self.mkdir(parent, True)
        if len(self._directories) >= 512 and value not in self._directories:
            raise OSError("Session directory limit exceeded")
        self._directories.add(value)

    async def readdir(self, path: str) -> list[str]:
        value = self._path(path)
        if value not in self._directories:
            raise FileNotFoundError("Session directory missing")
        return sorted(
            PurePosixPath(key).name
            for key in self._directories | self._files.keys()
            if str(PurePosixPath(key).parent) == value
        )

    async def readdir_with_types(self, path: str) -> list[SessionFSReaddirWithTypesEntry]:
        from copilot.generated.rpc import DebugCollectLogsEntryKind, SessionFSReaddirWithTypesEntry

        value = self._path(path)
        return [
            SessionFSReaddirWithTypesEntry(
                name=name,
                type=DebugCollectLogsEntryKind.FILE
                if value + "/" + name in self._files
                else DebugCollectLogsEntryKind.DIRECTORY,
            )
            for name in await self.readdir(value)
        ]

    async def rm(self, path: str, recursive: bool, force: bool) -> None:
        value = self._path(path)
        if value == "/sage":
            raise ValueError("Cannot remove session root")
        if not await self.exists(value):
            if force:
                return
            raise FileNotFoundError("Session path missing")
        descendants = [
            key for key in self._directories | self._files.keys() if key.startswith(value + "/")
        ]
        if descendants and not recursive:
            raise OSError("Session directory is not empty")
        for key in [value, *descendants]:
            self._files.pop(key, None)
            self._directories.discard(key)

    async def rename(self, src: str, dest: str) -> None:
        source, target = self._path(src), self._path(dest)
        if source == "/sage" or target.startswith(source + "/") or target in self._directories:
            raise ValueError("Invalid session rename")
        await self.stat(source)
        if target in self._files and source not in self._files:
            raise IsADirectoryError("Session rename type mismatch")
        await self.mkdir(str(PurePosixPath(target).parent), True)
        for key in list(self._files):
            if key == source or key.startswith(source + "/"):
                self._files[target + key[len(source) :]] = self._files.pop(key)
        for key in list(self._directories):
            if key == source or key.startswith(source + "/"):
                self._directories.remove(key)
                self._directories.add(target + key[len(source) :])

    def dispose(self) -> None:
        self._files.clear()
        self._directories.clear()
        self._disposed = True
