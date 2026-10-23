"""Check the actual Windows portable ZIP against the packaged application tree."""

import hashlib
import json
import stat
import zipfile
from pathlib import Path, PurePosixPath
from typing import Protocol

ROOT = Path(__file__).resolve().parents[1]


class ZipInventoryError(ValueError):
    """Fixed diagnostic label without artifact paths or contents."""


class Readable(Protocol):
    def read(self, size: int = -1) -> bytes: ...


def digest(stream: Readable) -> str:
    value = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        value.update(chunk)
    return value.hexdigest()


def check_entry_type(info: zipfile.ZipInfo) -> None:
    """Admit only regular files and directories, including Windows ZIP metadata."""
    directory = info.is_dir()
    file_type = stat.S_IFMT(info.external_attr >> 16)
    allowed = (0, stat.S_IFDIR) if directory else (0, stat.S_IFREG)
    # CPython sets create_system=0 on Windows but still writes st_mode to the
    # upper word. Treat that word as DOS attributes only without a POSIX type.
    dos_attributes = info.external_attr & 0xFFFF
    if info.create_system == 0 and file_type == 0:
        dos_attributes |= info.external_attr >> 16
    if (
        file_type not in allowed
        or dos_attributes & (0x08 | 0x40 | 0x400)  # volume, device, reparse point
        or (not directory and dos_attributes & 0x10)
        or (directory and info.file_size != 0)
    ):
        raise ZipInventoryError("unsupported_entry_type")


def verify(appdir: Path, archive: Path) -> int:
    if not appdir.is_dir() or not archive.is_file():
        raise ZipInventoryError("missing_package")
    source: dict[str, Path] = {}
    for path in appdir.rglob("*"):
        if path.is_symlink():
            raise ZipInventoryError("source_symlink")
        if path.is_file():
            source[path.relative_to(appdir).as_posix()] = path
    if not source:
        raise ZipInventoryError("empty_package")
    with zipfile.ZipFile(archive) as zipped:
        entries: dict[str, zipfile.ZipInfo] = {}
        for info in zipped.infolist():
            name = info.filename
            parts = PurePosixPath(name).parts
            if (
                not parts
                or name.startswith("/")
                or "\\" in name
                or ".." in parts
                or ":" in parts[0]
                or str(PurePosixPath(name)) != name.rstrip("/")
            ):
                raise ZipInventoryError("unsafe_entry")
            check_entry_type(info)
            if info.is_dir():
                continue
            if name in entries:
                raise ZipInventoryError("duplicate_entry")
            entries[name] = info
        if set(entries) != set(source):
            raise ZipInventoryError("source_mismatch")
        for name, path in source.items():
            if entries[name].file_size != path.stat().st_size:
                raise ZipInventoryError("content_mismatch")
            with path.open("rb") as original, zipped.open(entries[name]) as packed:
                if digest(original) != digest(packed):
                    raise ZipInventoryError("content_mismatch")
    return len(source)


def main() -> int:
    try:
        package = json.loads((ROOT / "package.json").read_text())
        stem = "Sage-win32-x64"
        appdir = ROOT / "out" / stem
        archive = (
            ROOT / "out" / "make" / "zip" / "win32" / "x64" / f"{stem}-{package['version']}.zip"
        )
        count = verify(appdir, archive)
        print(f"PASS Windows ZIP inventory: {count} files")
        return 0
    except ZipInventoryError as error:
        print(f"FAIL Windows ZIP inventory: {error}")
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile):
        print("FAIL Windows ZIP inventory: invalid_archive")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
