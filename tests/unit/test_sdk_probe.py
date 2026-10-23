"""Credential-free public SDK construction and capability-denial sensitivity."""

import json
import os
import struct
import subprocess
import sys
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

import pytest

from sage.sdk_probe import CapabilityGuard, decode_result, probe


def test_real_pinned_sdk_constructs_without_runtime_or_store(tmp_path: Path) -> None:
    env = {"LANG": "C.UTF-8", "TMPDIR": str(tmp_path), "TMP": str(tmp_path), "TEMP": str(tmp_path)}
    for key in ("SystemRoot", "WINDIR"):
        if key in os.environ:
            env[key] = os.environ[key]
    child = subprocess.run(
        [sys.executable, "-I", "-B", "-m", "sage", "--sdk-self-check"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert child.returncode == 0 and child.stderr == b""
    result = decode_result(child.stdout)
    assert result == {
        "schema": 1,
        "status": "pass",
        "stage": "complete",
        "category": "none",
        "sdk": "1.0.25",
        "python": ".".join(map(str, sys.version_info[:3])),
        "frozen": False,
    }
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    "options",
    [
        ["--self-check"],
        ["--root", "/synthetic"],
        ["--copilot-runtime", "/synthetic"],
        ["--gh-runtime", "/synthetic"],
        ["--module", "os"],
        ["--sdk-self-check=value"],
    ],
)
def test_probe_accepts_no_parameters(options: list[str]) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "sage", "--sdk-self-check", *options],
        env={"PATH": os.defpath, "PYTHONPATH": str(Path("src").resolve())},
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 2 and result.stdout == b""


@pytest.mark.parametrize(
    ("operation", "category"),
    [
        ("import socket; socket.socket()", "blocked_network"),
        ("import subprocess; subprocess.Popen(['synthetic-not-executable'])", "blocked_process"),
        ("import sqlite3; sqlite3.connect(':memory:')", "blocked_storage"),
        ("open('/synthetic-write', 'w')", "blocked_storage"),
        ("open('/synthetic-config', 'rb')", "blocked_storage"),
        ("import os; os.stat('/synthetic-config')", "blocked_storage"),
        ("import ctypes; ctypes.CDLL(None)", "blocked_native"),
        ("print('synthetic-private-marker')", "blocked_output"),
    ],
)
def test_installed_guard_denies_and_latches_even_if_caught(operation: str, category: str) -> None:
    # This literal test program is not part of the production CLI or shipped wheel.
    program = (
        "from sage.sdk_probe import CapabilityGuard; import sys\n"
        "sink=sys.stdout; guard=CapabilityGuard(); guard.install()\n"
        "try:\n " + operation + "\nexcept BaseException: pass\n"
        "sink.write(guard.denied or 'MISSED'); sink.flush()\n"
    )
    child = subprocess.run(
        [sys.executable, "-B", "-c", program],
        env={"PATH": os.defpath, "PYTHONPATH": str(Path("src").resolve())},
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert child.returncode == 0 and child.stdout == category.encode() and child.stderr == b""


def test_guard_resource_reads_are_confined_and_writes_never_allowed(tmp_path: Path) -> None:
    resource = tmp_path / "trusted" / "module.py"
    resource.parent.mkdir()
    resource.write_text("pass")
    outside = tmp_path / "private"
    outside.write_text("synthetic-private-marker")
    (resource.parent / "escape").symlink_to(outside)
    guard = CapabilityGuard(roots=(resource.parent,))
    guard.audit("open", (str(resource), "r", 0))
    guard.audit("os.listdir", (str(resource.parent),))
    guard.audit("import", ("trusted", None, None, None, None))
    for args in [
        (str(resource), "w", 0),
        (str(outside), "r", 0),
        (str(resource.parent / "escape"), "r", 0),
        (3, "r", 0),
    ]:
        with pytest.raises(PermissionError):
            guard.audit("open", args)
    assert guard.denied == "blocked_storage"


@pytest.mark.parametrize("kind", ["outside", "container", "trusted", "trusted_named_py"])
def test_filename_import_never_inherits_resource_read_permission(tmp_path: Path, kind: str) -> None:
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    container = tmp_path / "sage-core"
    container.touch()
    guard = CapabilityGuard(roots=(trusted,))
    guard.container = str(container)
    filename = {
        "outside": tmp_path / "outside.so",
        "container": container,
        "trusted": trusted / "inert.so",
        "trusted_named_py": trusted / "inert.py",
    }[kind]
    if kind == "container":
        guard.audit("open", (str(filename), "r", 0))
    with pytest.raises(PermissionError):
        guard.audit("import", ("synthetic_inert", str(filename), None, None, None))
    assert guard.denied == "blocked_native"


@pytest.mark.parametrize("filename", ["/synthetic-outside.so", "/synthetic-read-container"])
def test_installed_import_event_denial_uses_inert_sys_audit_only(filename: str) -> None:
    program = (
        "from sage.sdk_probe import CapabilityGuard; import sys\n"
        "sink=sys.stdout; guard=CapabilityGuard(); guard.container='/synthetic-read-container'\n"
        "guard.install()\n"
        "try: sys.audit('import','synthetic_inert',sys.argv[1],None,None,None)\n"
        "except PermissionError: pass\n"
        "sink.write(guard.denied or 'MISSED'); sink.flush()\n"
    )
    child = subprocess.run(
        [sys.executable, "-B", "-c", program, filename],
        env={"PATH": os.defpath, "PYTHONPATH": str(Path("src").resolve())},
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert child.returncode == 0 and child.stdout == b"blocked_native" and child.stderr == b""


def test_installed_guard_preserves_genuine_trusted_pure_python_import(tmp_path: Path) -> None:
    resource = tmp_path / "sage_probe_resource.py"
    resource.write_text("answer = 42\n")
    program = (
        "from sage.sdk_probe import CapabilityGuard; import sys; from pathlib import Path\n"
        "sink=sys.stdout; guard=CapabilityGuard(roots=(Path(sys.argv[1]),)); guard.install()\n"
        "import sage_probe_resource\n"
        "sink.write(str(sage_probe_resource.answer)+':'+str(guard.denied)); sink.flush()\n"
    )
    child = subprocess.run(
        [sys.executable, "-B", "-c", program, str(tmp_path)],
        env={"PATH": os.defpath, "PYTHONPATH": str(Path("src").resolve())},
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert child.returncode == 0 and child.stdout == b"42:None" and child.stderr == b""
    assert list(tmp_path.iterdir()) == [resource]


def test_frozen_pyz_container_exact_read_does_not_admit_neighbors_writes_or_execution(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "_internal"
    bundle.mkdir()
    executable = tmp_path / "sage-core"
    executable.touch()
    neighbor = tmp_path / "private-config"
    neighbor.touch()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle), raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))
    guard = CapabilityGuard()
    assert guard.roots == (str(bundle),)
    guard.audit("open", (str(executable), "r", 0))
    for args in [(str(neighbor), "r", 0), (str(executable), "w", 0), (str(tmp_path), "r", 0)]:
        with pytest.raises(PermissionError):
            guard.audit("open", args)
    for event in ("subprocess.Popen", "ctypes.dlopen"):
        with pytest.raises(PermissionError):
            guard.audit(event, (str(executable),))


def test_guard_denies_outside_metadata_before_access_and_never_follows_escape(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    outside = tmp_path / "owned-private" / "config"
    outside.parent.mkdir()
    outside.write_text("synthetic-private-marker")
    escape = trusted / "escape"
    escape.symlink_to(outside)
    guard = CapabilityGuard(roots=(trusted,))
    observed: list[Path] = []
    original = os.lstat

    def metadata(path: Any, *args: Any, **kwargs: Any) -> os.stat_result:
        observed.append(Path(path))
        return original(path, *args, **kwargs)

    # No process-global hooks: exercise the real production admission method with
    # captured filesystem operations, observing access before the denial occurs.
    monkeypatch.setattr(guard, "_lstat", metadata)
    monkeypatch.setattr(os, "lstat", metadata)
    for name in [outside, trusted / ".." / "owned-private" / "config", escape]:
        observed.clear()
        with pytest.raises(PermissionError):
            guard.read(name)
        assert not any(p == outside or p == outside.parent for p in observed)
        if name != escape:
            assert observed == []


@pytest.mark.parametrize("payload", [b"", b"\x00\x00\x40\x01", b"\x00\x00\x00\x02{}extra"])
def test_malformed_probe_frames_fail_closed(payload: bytes) -> None:
    with pytest.raises(ValueError):
        decode_result(payload)


@pytest.mark.parametrize(
    "change",
    [
        {"stage": "private-path"},
        {"category": "raw exception"},
        {"extra": "forbidden"},
        {"status": "ready"},
    ],
)
def test_unknown_probe_metadata_fails_closed(change: dict[str, Any]) -> None:
    data = {
        "schema": 1,
        "status": "pass",
        "stage": "complete",
        "category": "none",
        "sdk": "1.0.25",
        "python": "3.13.17",
        "frozen": False,
    } | change
    encoded = json.dumps(data).encode()
    with pytest.raises(ValueError):
        decode_result(struct.pack(">I", len(encoded)) + encoded)


def test_probe_never_hides_a_swallowed_denial(monkeypatch: pytest.MonkeyPatch) -> None:
    guard = CapabilityGuard()
    monkeypatch.setattr(guard, "install", lambda: None)

    def swallowed(*args: Any) -> object:
        with suppress(PermissionError):
            guard.audit("subprocess.Popen", ())
        return object()

    monkeypatch.setattr("sage.sdk_probe.construct_client", swallowed)
    result = probe(guard)
    assert result["status"] == "fail" and result["category"] == "blocked_process"
    assert result["stage"] == "sdk_construct"


def test_guard_entry_points_admit_import_resources_and_deny_other_capabilities(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    resource = tmp_path / "resource.py"
    resource.touch()
    link = tmp_path / "link"
    link.symlink_to(resource)
    guard = CapabilityGuard(roots=(tmp_path,))
    hooks: list[Any] = []
    with monkeypatch.context() as patch:
        patch.setattr(sys, "addaudithook", hooks.append)
        patch.setattr(sys, "path", list(sys.path))
        patch.setattr(sys, "dont_write_bytecode", sys.dont_write_bytecode)
        for name in ("stat", "lstat", "readlink", "access", "open", "read", "write", "getlogin"):
            patch.setattr(os, name, getattr(os, name))
        for name in ("stdout", "stderr", "__stdout__", "__stderr__"):
            patch.setattr(sys, name, getattr(sys, name))
        guard.install()
        assert len(hooks) == 1 and sys.path == list(guard.roots)
        assert os.stat(resource).st_size == 0
        assert os.lstat(resource) and os.access(resource, os.R_OK)
        assert sys.stdout.buffer is sys.stdout
        sys.stdout.flush()
        operations: list[Callable[[], Any]] = [
            lambda: os.stat(resource, dir_fd=3),
            lambda: os.stat("/synthetic-private"),
            lambda: os.readlink(link),
            lambda: os.open(resource, os.O_RDONLY),
            lambda: os.read(0, 1),
            lambda: os.write(1, b"private"),
            os.getlogin,
            lambda: sys.stdout.buffer.write(b"private"),
        ]
        for operation in operations:
            with pytest.raises(PermissionError):
                operation()
    assert guard.denied == "blocked_storage"


@pytest.mark.parametrize(
    ("error", "category"),
    [
        (ImportError(), "dependency_error"),
        (ValueError(), "contract_error"),
        (OSError(), "io_error"),
        (RuntimeError(), "unexpected_error"),
    ],
)
def test_fixed_probe_classifies_constructor_failures_without_exception_content(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    category: str,
) -> None:
    guard = CapabilityGuard()
    monkeypatch.setattr(guard, "install", lambda: None)

    def fail(*args: Any) -> Any:
        raise error

    monkeypatch.setattr("sage.sdk_probe.construct_client", fail)
    result = probe(guard)
    assert result["stage"] == "sdk_construct" and result["category"] == category


def test_probe_mismatch_and_import_denial_stop_before_construction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import builtins

    guard = CapabilityGuard()
    monkeypatch.setattr(guard, "install", lambda: None)
    with monkeypatch.context() as patch:
        patch.setattr("importlib.metadata.version", lambda _: "synthetic-unsupported-version")
        assert probe(guard)["stage"] == "guard"
    original = builtins.__import__

    def importing(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "copilot":
            guard.denied = "blocked_storage"
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", importing)
    monkeypatch.setattr(
        "sage.sdk_probe.construct_client", lambda *_: pytest.fail("must not construct")
    )
    result = probe(guard)
    assert result["stage"] == "sdk_import" and result["category"] == "blocked_storage"


@pytest.mark.parametrize("passed", [True, False])
def test_fixed_writer_emits_only_one_closed_frame(
    monkeypatch: pytest.MonkeyPatch,
    capsysbinary: pytest.CaptureFixture[bytes],
    passed: bool,
) -> None:
    from sage.sdk_probe import sdk_self_check

    result = {
        "schema": 1,
        "status": "pass" if passed else "fail",
        "stage": "complete" if passed else "sdk_import",
        "category": "none" if passed else "dependency_error",
        "sdk": "1.0.25",
        "python": "3.13.17",
        "frozen": False,
    }
    monkeypatch.setattr("sage.sdk_probe.probe", lambda: result)
    assert sdk_self_check() == (0 if passed else 1)
    captured = capsysbinary.readouterr()
    assert decode_result(captured.out) == result and captured.err == b""


def test_probe_cli_dispatch_has_no_service_initialization(monkeypatch: pytest.MonkeyPatch) -> None:
    from sage.__main__ import main

    monkeypatch.setattr(sys, "argv", ["sage", "--sdk-self-check"])
    monkeypatch.setattr("sage.sdk_probe.sdk_self_check", lambda: 0)
    monkeypatch.setattr("sage.__main__._run", lambda *_: pytest.fail("must not initialize"))
    assert main() == 0


@pytest.mark.parametrize(
    ("event", "args", "category"),
    [
        ("socket.connect", (), "blocked_network"),
        ("os.exec", (), "blocked_process"),
        ("ctypes.dlopen", (), "blocked_native"),
        ("import", (), "blocked_native"),
        ("sqlite3.connect", (), "blocked_storage"),
        ("os.mkdir", (), "blocked_storage"),
        ("open", ("/private", None, os.O_CREAT), "blocked_storage"),
    ],
)
def test_audited_capabilities_are_closed(event: str, args: tuple[Any, ...], category: str) -> None:
    guard = CapabilityGuard()
    with pytest.raises(PermissionError):
        guard.audit(event, args)
    assert guard.denied == category


@pytest.mark.parametrize(
    "payload",
    [
        b'{"schema":1,"schema":1}',
        b"[" * 1000 + b"]" * 1000,
        b'{"schema":1,"status":"pass","stage":"sdk_import","category":"none","sdk":"1.0.25","python":"3.13.17","frozen":false}',
        b'{"schema":1,"status":"fail","stage":"complete","category":"io_error","sdk":"1.0.25","python":"3.13.17","frozen":false}',
        b'{"schema":1,"status":"fail","stage":"sdk_import","category":"none","sdk":"1.0.25","python":"3.13.17","frozen":false}',
    ],
)
def test_duplicate_deep_or_inconsistent_probe_results_fail_closed(payload: bytes) -> None:
    with pytest.raises(ValueError):
        decode_result(struct.pack(">I", len(payload)) + payload)
