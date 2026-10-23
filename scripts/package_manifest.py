"""Fail-closed external-resource inventory. Diagnostics never contain file contents."""

import argparse
import hashlib
import json
import os
import stat
from pathlib import Path

DENIED = {"modules", "tests", "e2e", "__pycache__", ".git", ".env", "credentials.json", "test.py"}


def inventory(root: Path) -> dict[str, dict[str, str | int]]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Invalid resource root")
    entries: dict[str, dict[str, str | int]] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part in DENIED or part.endswith((".sqlite", ".sqlite3")) for part in relative.parts):
            raise ValueError("Forbidden release path")
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if path.is_symlink():
            target = os.readlink(path)
            if os.path.isabs(target) or not path.resolve().is_relative_to(root.resolve()):
                raise ValueError("Nonportable resource link")
            if not path.exists():
                raise ValueError("Broken resource link")
            entry: dict[str, str | int] = {"type": "symlink", "target": target, "mode": mode}
        elif path.is_file():
            with path.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            entry = {"type": "file", "bytes": info.st_size, "sha256": digest, "mode": mode}
        elif path.is_dir():
            continue
        else:
            raise ValueError("Unsupported resource type")
        entries[relative.as_posix()] = entry
    executable = root / "core" / ("sage-core.exe" if os.name == "nt" else "sage-core")
    if not executable.is_file() or executable.is_symlink():
        raise ValueError("Missing core executable")
    if os.name != "nt" and not executable.stat().st_mode & stat.S_IXUSR:
        raise ValueError("Core is not executable")
    return entries


def validate_sources(root: Path, rows: list[dict[str, str | int]]) -> None:
    """Compare the entire selected source trees with verified provisioning evidence."""
    expected = {str(row["path"]): row for row in rows}
    if len(expected) != len(rows) or not rows:
        raise ValueError("Invalid source inventory")
    if any(Path(name).is_absolute() or ".." in Path(name).parts for name in expected):
        raise ValueError("Invalid source path")
    roots = {
        Path(*Path(path).parts[: 3 if Path(path).parts[0] == "gh" else 2]) for path in expected
    }
    actual = {
        path.relative_to(root).as_posix()
        for directory in roots
        for path in (root / directory).rglob("*")
        if path.is_file() or path.is_symlink()
    }
    if actual != set(expected):
        raise ValueError("Unexpected native source files")
    for name, row in expected.items():
        path = root / name
        if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():
            raise ValueError("Invalid source path")
        if path.stat().st_size != row["bytes"]:
            raise ValueError("Native source size mismatch")
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != row["sha256"]:
                raise ValueError("Native source digest mismatch")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--packaged", action="store_true")
    parser.add_argument("--record", action="store_true", help="Record reviewed staging baseline")
    args = parser.parse_args()
    try:
        entries = inventory(args.root)
        if args.packaged:
            for name in ("app.asar", "electron.icns"):
                if name in entries:
                    if entries[name]["type"] != "file":
                        raise ValueError("Invalid host resource")
                    del entries[name]
        current = {"schema": 1, "entries": entries}
        if args.record:
            if args.manifest.exists():
                raise ValueError("Baseline already exists")
            args.manifest.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
        elif json.loads(args.manifest.read_text(encoding="utf-8")) != current:
            raise ValueError("Resource inventory mismatch")
        print("PASS resource inventory")
        return 0
    except (OSError, ValueError, RuntimeError):
        print("FAIL resource inventory")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
