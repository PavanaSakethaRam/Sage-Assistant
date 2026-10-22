"""Protected-source regressions use only synthetic markers and owned subprocesses."""

import asyncio
import hashlib
import os
import signal
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from tests.helpers.copilot_fake import FakeSdk
from tests.unit.test_provider_contract import backend, request


def test_async_acquisition_is_awaited_before_sdk_and_receives_only_id_deadline(
    tmp_path: Path,
) -> None:
    sdk = FakeSdk()
    provider = backend(tmp_path, sdk)
    seen = []

    async def source(identifier: str, deadline: datetime) -> str:
        seen.append((identifier, deadline))
        return "gho_synthetic"

    provider._token_source = source
    result = asyncio.run(provider.reason(request()))
    assert result.status == "completed"
    assert len(seen) == 1 and seen[0][0] == "r1"
    assert sdk.session_options["github_token"] == "gho_synthetic"


def helper(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, code: str) -> Any:
    from sage.providers import protected_auth as auth

    if os.name == "nt":
        pytest.skip("Script-executable owned helper fixture requires POSIX; native Windows gate")
    path = tmp_path / "managed" / "bin" / "gh"
    path.parent.mkdir(parents=True)
    interpreter = tmp_path / "fixture-python"
    interpreter.symlink_to(sys.executable)
    path.write_text(f"#!{interpreter}\n" + code)
    path.chmod(0o700)
    monkeypatch.setitem(
        auth.EXECUTABLE_HASHES, auth.platform_key(), hashlib.sha256(path.read_bytes()).hexdigest()
    )
    monkeypatch.setitem(auth.EXECUTABLE_SIZES, auth.platform_key(), path.stat().st_size)
    return auth.ProtectedSource(path, tmp_path / "owned", "synthetic-user")


def deadline(seconds: float = 2) -> datetime:
    return datetime.now(UTC) + timedelta(seconds=seconds)


def test_token_helper_exact_argv_env_empty_config_and_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = helper(
        tmp_path,
        monkeypatch,
        """import os,sys,pathlib
assert sys.argv[1:]==['auth','token','--hostname','github.com','--user',
 'synthetic-user','--secure-storage','--no-refresh']
assert not any(k in os.environ for k in ['HOME','PATH','GH_TOKEN','GITHUB_TOKEN',
 'HTTPS_PROXY','GH_DEBUG','XDG_CONFIG_HOME'])
assert os.environ['GH_TELEMETRY']=='0'
assert os.environ['GH_PROMPT_DISABLED']=='1'
for k in ['GH_CONFIG_DIR','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME']:
 p=pathlib.Path(os.environ[k]);assert p.is_absolute() and not list(p.iterdir())
print('gho_synthetic')
""",
    )
    seen = []

    async def identity(token: str, login: str, until: datetime) -> bool:
        seen.append((token, login))
        return True

    monkeypatch.setattr(type(source), "_identity", staticmethod(identity))
    monkeypatch.setenv("GH_TOKEN", "synthetic-hostile")
    assert asyncio.run(source("r1", deadline())) == "gho_synthetic"
    assert seen == [("gho_synthetic", "synthetic-user")]
    assert not any(p.is_file() for p in source.root.rglob("*"))


@pytest.mark.parametrize(
    "code",
    [
        "print('ghp_plaintext')",
        "print('gho_synthetic\\nextra')",
        "print('gho_synthetic ')",
        "print('gho_'+'x'*8192)",
        "import sys;sys.stderr.write('x'*16385);print('gho_synthetic')",
        "import sys;print('gho_synthetic');sys.exit(1)",
        "print('')",
    ],
)
def test_private_malformed_overflow_and_error_output_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: Any, code: str
) -> None:
    source = helper(tmp_path, monkeypatch, code)
    assert asyncio.run(source("r1", deadline())) is None
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err == ""


def test_helper_integrity_missing_and_unsafe_owned_config_fail_before_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = helper(tmp_path, monkeypatch, "raise Exception('must not execute')")
    source.executable.write_text("modified")
    assert asyncio.run(source("r1", deadline())) is None
    source.executable.unlink()
    assert asyncio.run(source("r2", deadline())) is None


def test_protected_read_never_accepts_nonempty_or_symlink_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = helper(tmp_path, monkeypatch, "raise Exception('must not execute')")
    config = source.root / "config"
    config.mkdir(parents=True)
    (config / "hosts.yml").write_text("synthetic plaintext fixture")
    assert asyncio.run(source("r1", deadline())) is None
    (config / "hosts.yml").unlink()
    config.rmdir()
    config.symlink_to(tmp_path / "managed", target_is_directory=True)
    assert asyncio.run(source("r2", deadline())) is None


def test_identity_failure_keyring_disappearance_and_expired_deadline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = helper(tmp_path, monkeypatch, "print('ghu_synthetic')")

    async def mismatch(*_: Any) -> bool:
        return False

    monkeypatch.setattr(type(source), "_identity", staticmethod(mismatch))
    assert asyncio.run(source("r1", deadline())) is None
    assert asyncio.run(source("r2", deadline(-1))) is None
    source.executable.unlink()  # disappearance between selection and use never falls back
    assert asyncio.run(source("r3", deadline())) is None


@pytest.mark.skipif(os.name == "nt", reason="POSIX group fixture; Windows native ownership gate")
def test_timeout_and_cancel_reap_owned_helper_and_stubborn_descendant(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pidfile = tmp_path / "pids"
    source = helper(
        tmp_path,
        monkeypatch,
        f"""import subprocess,sys,os,time,signal
signal.signal(signal.SIGTERM,signal.SIG_IGN)
child_code='import time,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'
p=subprocess.Popen([sys.executable,'-c',child_code])
open({str(pidfile)!r},'w').write(str(os.getpid())+' '+str(p.pid))
time.sleep(60)
""",
    )

    async def run(cancel: bool) -> None:
        pending = asyncio.create_task(source("r1", deadline(1 if not cancel else 3)))
        async with asyncio.timeout(3):
            while not pidfile.exists():
                await asyncio.sleep(0.005)
        pids = list(map(int, pidfile.read_text().split()))
        if cancel:
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
        else:
            assert await pending is None
        for pid in pids:
            with pytest.raises(ProcessLookupError):
                os.kill(pid, 0)

    asyncio.run(run(False))
    pidfile.unlink()
    asyncio.run(run(True))


def test_cancel_during_acquisition_never_creates_sdk(tmp_path: Path) -> None:
    async def run() -> None:
        sdk = FakeSdk()
        provider = backend(tmp_path, sdk)
        entered = asyncio.Event()

        async def source(*_: Any) -> str:
            entered.set()
            await asyncio.Event().wait()
            return "gho_late"

        provider._token_source = source
        pending = asyncio.create_task(provider.reason(request()))
        await entered.wait()
        await provider.cancel("r1")
        assert (await pending).status == "cancelled"
        assert sdk.created == 0

    asyncio.run(run())


@pytest.mark.parametrize(
    ("status", "headers", "body", "expected"),
    [
        ("200 OK", {}, b'{"login":"synthetic-user","id":123,"other":"ignored"}', True),
        ("200 OK", {}, b'{"login":"SYNTHETIC-USER","id":123}', True),
        ("200 OK", {}, b'{"login":"other","id":123}', False),
        ("200 OK", {}, b'{"login":"synthetic-user","id":true}', False),
        ("302 Found", {"Location": "https://evil.invalid"}, b"{}", False),
        ("401 Unauthorized", {}, b"{}", False),
        ("200 OK", {}, b'{"login":"synthetic-user","id":1,"id":2}', False),
        ("200 OK", {"Content-Encoding": "gzip"}, b"{}", False),
        ("200 OK", {}, b"x" * 16385, False),
        ("200 OK", {"X-Oversize": "x" * 8192}, b"{}", False),
    ],
)
def test_fixed_identity_no_redirect_bounds_and_matching_owner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    headers: dict[str, str],
    body: bytes,
    expected: bool,
) -> None:
    source = helper(tmp_path, monkeypatch, "print('gho_synthetic')")
    observed = []

    class Writer:
        def write(self, data: bytes) -> None:
            observed.append(data)

        async def drain(self) -> None:
            pass

        def close(self) -> None:
            observed.append(b"closed")

        async def wait_closed(self) -> None:
            pass

    async def connection(*args: Any, **kwargs: Any) -> tuple[asyncio.StreamReader, Writer]:
        assert args == ("api.github.com", 443)
        assert kwargs["server_hostname"] == "api.github.com"
        assert kwargs["ssl"].check_hostname
        reader = asyncio.StreamReader(limit=8192)
        fields = {"Content-Length": str(len(body)), **headers}
        reader.feed_data(
            (
                "HTTP/1.1 "
                + status
                + "\r\n"
                + "\r\n".join(f"{k}: {v}" for k, v in fields.items())
                + "\r\n\r\n"
            ).encode()
            + body
        )
        reader.feed_eof()
        return reader, Writer()

    monkeypatch.setattr(asyncio, "open_connection", connection)
    assert (asyncio.run(source("r1", deadline())) is not None) == expected
    assert observed[0].startswith(b"GET /user HTTP/1.1\r\nHost: api.github.com\r\n")
    assert b"synthetic-user" not in observed[0]
    assert b"Authorization: Bearer gho_synthetic\r\n" in observed[0]
    assert observed[-1] == b"closed"


def test_cancellation_insensitive_source_cannot_start_sdk_after_cancel(tmp_path: Path) -> None:
    async def run() -> None:
        sdk = FakeSdk()
        provider = backend(tmp_path, sdk)
        entered = asyncio.Event()

        async def source(*_: Any) -> str:
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return "gho_late"
            return "gho_late"

        provider._token_source = source
        pending = asyncio.create_task(provider.reason(request()))
        await entered.wait()
        await provider.cancel("r1")
        assert (await pending).status == "cancelled"
        assert sdk.created == 0

    asyncio.run(run())


@pytest.mark.skipif(os.name == "nt", reason="POSIX startup ownership fixture")
def test_cancel_during_subprocess_startup_still_obtains_and_reaps_owned_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = helper(tmp_path, monkeypatch, "import time;time.sleep(60)")

    async def run() -> None:
        original = asyncio.create_subprocess_exec
        spawned, release = asyncio.Event(), asyncio.Event()
        processes = []

        async def delayed(*args: Any, **kwargs: Any) -> asyncio.subprocess.Process:
            process = await original(*args, **kwargs)
            processes.append(process)
            spawned.set()
            await release.wait()
            return process

        monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed)
        pending = asyncio.create_task(source("r1", deadline()))
        try:
            await spawned.wait()
            pending.cancel()
            await asyncio.sleep(0)
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert processes[0].returncode is not None
            with pytest.raises(ProcessLookupError):
                os.kill(processes[0].pid, 0)
        finally:
            for process in processes:
                if process.returncode is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()

    asyncio.run(run())


@pytest.mark.parametrize(
    ("wire", "expected"),
    [
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n", b"{}"),
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n", None),
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n", None),
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nwat\r\n", None),
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nno", None),
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4001\r\n", None),
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nxno", None),
        (b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\ncontent-length: 1\r\n\r\nx", None),
        (b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", None),
    ],
)
def test_identity_http_chunk_and_framing_limits(wire: bytes, expected: bytes | None) -> None:
    from sage.providers.protected_auth import _identity_body

    async def run() -> None:
        reader = asyncio.StreamReader()
        reader.feed_data(wire)
        reader.feed_eof()
        if expected is None:
            with pytest.raises((ValueError, KeyError, asyncio.IncompleteReadError)):
                await _identity_body(reader)
        else:
            assert await _identity_body(reader) == expected

    asyncio.run(run())


def test_local_and_passive_readiness_never_call_credential_source(tmp_path: Path) -> None:
    sdk = FakeSdk()
    provider = backend(tmp_path, sdk, local=True)

    async def forbidden(*_: Any) -> str:
        raise AssertionError("credential read in local mode")

    provider._token_source = forbidden
    assert provider.readiness().status == "unavailable"
    assert asyncio.run(provider.reason(request())).text == "inference_unavailable"
    assert sdk.created == 0


def test_symlink_parent_and_relative_root_never_create_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sage.providers.protected_auth import helper_environment, trusted_executable

    assert not trusted_executable(Path("gh"))
    with pytest.raises(ValueError):
        helper_environment(Path("relative"))
    target = tmp_path / "target"
    target.mkdir()
    link = tmp_path / "link"
    link.symlink_to(target, target_is_directory=True)
    with pytest.raises(ValueError):
        helper_environment(link / "must-not-create")
    assert list(target.iterdir()) == []
    monkeypatch.setenv("SystemRoot", "synthetic-system-root")
    monkeypatch.setenv("WINDIR", "synthetic-windir")
    env = helper_environment(tmp_path / "owned")
    assert env["SystemRoot"] == "synthetic-system-root" and env["WINDIR"] == "synthetic-windir"


def test_concurrent_acquisitions_have_separate_owned_processes_and_no_staged_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = helper(tmp_path, monkeypatch, "import os;print('gho_'+str(os.getpid()))")
    observed: list[str] = []

    async def identity(token: str, login: str, until: datetime) -> bool:
        observed.append(token)
        return True

    monkeypatch.setattr(type(source), "_identity", staticmethod(identity))

    async def run() -> None:
        tokens = await asyncio.gather(source("one", deadline()), source("two", deadline()))
        assert len(set(tokens)) == 2 and None not in tokens
        assert set(tokens) == set(observed)

    asyncio.run(run())


def test_protected_source_selection_is_immutable_and_rejects_invalid_login(tmp_path: Path) -> None:
    from dataclasses import FrozenInstanceError

    from sage.providers.protected_auth import ProtectedSource

    with pytest.raises(ValueError):
        ProtectedSource(tmp_path / "missing", tmp_path / "owned", "--invalid")
    source = ProtectedSource(tmp_path / "missing", tmp_path / "owned", "synthetic-user")
    with pytest.raises(FrozenInstanceError):
        source.__setattr__("login", "other")
    assert not (tmp_path / "owned").exists()
