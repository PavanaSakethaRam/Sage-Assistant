"""Build the locked native onedir core; never search PATH for a Python runtime."""

import argparse
import importlib.metadata
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate_modules(names: set[str]) -> None:
    runtime = {
        "sage",
        "copilot",
        "pydantic",
        "pydantic_core",
        "platformdirs",
        "dateutil",
        "httpx",
        "httpcore",
        "anyio",
        "certifi",
        "h11",
        "idna",
        "six",
        "typing_extensions",
        "typing_inspection",
        "annotated_types",
        "tzdata",
        "_sysconfigdata__darwin_darwin",
    }
    if any(name.split(".")[0] not in runtime | sys.stdlib_module_names for name in names):
        raise ValueError("Unexpected module in frozen core")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.name != "core" or output.exists():
        parser.error("Output must be a new directory named core")
    if sys.version_info[:3] != (3, 13, 17) or sys.platform not in {"darwin", "win32"}:
        parser.error("Build requires native Windows/macOS CPython 3.13.17")
    for name, version in [("pyinstaller", "6.22.3"), ("pyinstaller-hooks-contrib", "2026.9")]:
        if importlib.metadata.version(name) != version:
            parser.error("Unexpected freezer version")
    cache = ROOT / ".cache/pyinstaller"
    cache.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYINSTALLER_CONFIG_DIR=str(cache))
    subprocess.run(
        [
            sys.executable,
            "-I",
            "-m",
            "PyInstaller",
            "--clean",
            "--noconfirm",
            "--distpath",
            str(output.parent),
            "--workpath",
            str(ROOT / "build/core"),
            str(ROOT / "sage-core.spec"),
        ],
        cwd=ROOT,
        env=env,
        check=True,
    )
    # Inspect the real PYZ, including the nested archive inside the executable.
    from importlib import import_module

    CArchiveReader = import_module("PyInstaller.archive.readers").CArchiveReader

    executable = output / ("sage-core.exe" if os.name == "nt" else "sage-core")
    reader = CArchiveReader(str(executable))
    names = set(reader.open_embedded_archive("PYZ.pyz").toc)
    validate_modules(names)
    evidence = {
        "python": sys.version,
        "platform": platform.platform(),
        "freezer": importlib.metadata.version("pyinstaller"),
        "hooks": importlib.metadata.version("pyinstaller-hooks-contrib"),
        "modules": sorted(names),
    }
    (ROOT / "build/core-analysis.json").write_text(json.dumps(evidence, indent=2) + "\n")
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/package_manifest.py"),
            str(output.parent),
            "--manifest",
            str(ROOT / "build/core-manifest.json"),
            "--record",
        ],
        cwd=ROOT,
        check=True,
    )
    print("PASS native frozen core built")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
