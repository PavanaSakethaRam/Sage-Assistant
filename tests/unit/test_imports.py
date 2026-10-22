"""A fresh core import must remain passive even without installed providers."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("module", ["sage", "sage.contracts", "sage.config", "sage.paths"])
def test_import_is_inert(module: str, tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[2] / "src"
    script = r"""
import importlib
import sys

sys.path.insert(0, sys.argv[1])
effects = []

def guard(event, args):
    blocked = (
        event.startswith(("socket.", "subprocess.", "ctypes."))
        or event in {"os.system", "os.posix_spawn", "os.fork", "os.exec", "os.mkdir",
                     "os.remove", "os.rename", "os.rmdir", "os.truncate", "os.chmod"}
    )
    if event == "open":
        path, mode, flags = args
        blocked = (
            (isinstance(mode, str) and any(char in mode for char in "wax+"))
            or (isinstance(flags, int) and bool(flags & (1 | 2 | 64 | 512 | 1024)))
            or (isinstance(path, str) and path.startswith(("/dev/", "\\\\.\\")))
        )
    if blocked:
        effects.append(event)
        raise RuntimeError("Import attempted forbidden effect: " + event)

sys.addaudithook(guard)
importlib.import_module(sys.argv[2])
assert not effects, effects
assert not any(name == "main" or name == "modules" or name.startswith("modules.")
               for name in sys.modules)
print("inert")
"""
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", script, str(source), module],
        cwd=tmp_path,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "inert\n"
    assert result.stderr == ""
    assert list(tmp_path.iterdir()) == []
