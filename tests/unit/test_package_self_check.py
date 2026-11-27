"""The fixed offline package probe cannot start storage, accounts, or network."""

import json
import os
import struct
import subprocess
import sys
from pathlib import Path

import pytest


def test_self_check_is_one_bounded_frame_without_state(tmp_path: Path) -> None:
    env = {"LANG": "C.UTF-8", "TMPDIR": str(tmp_path), "TMP": str(tmp_path), "TEMP": str(tmp_path)}
    for key in ("SystemRoot", "WINDIR"):
        if key in os.environ:
            env[key] = os.environ[key]
    result = subprocess.run(
        [sys.executable, "-I", "-m", "sage", "--self-check"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 0
    assert result.stderr == b""
    size = struct.unpack(">I", result.stdout[:4])[0]
    assert size == len(result.stdout) - 4 and size <= 16384
    data = json.loads(result.stdout[4:])
    assert set(data) == {
        "schema",
        "python",
        "openssl",
        "sqlite",
        "sdk",
        "certifi",
        "frozen",
        "ssl_module",
        "bundle",
        "trust",
        "environment_overrides",
    }
    assert data["schema"] == 1 and data["sdk"] == "1.0.25"
    assert data["trust"]["verify_mode"] == 2 and data["trust"]["check_hostname"] is True
    assert not any(data["environment_overrides"].values())
    assert list(tmp_path.iterdir()) == []


def test_offline_probe_shape_and_frame_limit(
    capsysbinary: pytest.CaptureFixture[bytes], monkeypatch: pytest.MonkeyPatch
) -> None:
    from sage.__main__ import self_check

    for key in ("SSLKEYLOGFILE", "SSL_CERT_FILE", "SSL_CERT_DIR"):
        monkeypatch.delenv(key, raising=False)
    self_check()
    frame = capsysbinary.readouterr()
    size = struct.unpack(">I", frame.out[:4])[0]
    assert size == len(frame.out) - 4 and size < 16384
    assert json.loads(frame.out[4:])["trust"]["check_hostname"] is True
    assert frame.err == b""
    monkeypatch.setattr("importlib.metadata.version", lambda _: "x" * 20000)
    with pytest.raises(ValueError, match="Self-check frame limit"):
        self_check()
    assert capsysbinary.readouterr().out == b""
