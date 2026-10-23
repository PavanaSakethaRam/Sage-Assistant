"""Fixed protected read. No credential transport, ambient config, refresh or cache."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import re
import signal
import ssl
import sys
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

EXECUTABLE_HASHES = {
    "darwin-arm64": "1ffcdcff76db02ff4f9de0fbf784ed4b6d18e434e89450db314b3f77d0f9443b",
    "darwin-x64": "7d209771083d0c886c0b0b88b0b6c89ed0019c8b4ae4ca40659cd1e91ebf0289",
    "win32-arm64": "99234015564395a1041fd0715cdf8146a467e06f8827446978e3feb9056ba4c3",
    "win32-x64": "8c090d7cb86e4db3cd8b969f832fe4855c2cf486ffdc35b4d2db77e164e847d1",
}
EXECUTABLE_SIZES = {
    "darwin-arm64": 38_914_960,
    "darwin-x64": 42_123_776,
    "win32-arm64": 38_398_264,
    "win32-x64": 41_781_560,
}
LOGIN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", re.ASCII)
TOKEN = re.compile(r"gh[ou]_[A-Za-z0-9]{1,251}", re.ASCII)


def identity_context() -> ssl.SSLContext:
    """Default platform trust for the fixed protected identity socket."""
    return ssl.create_default_context()


def platform_key() -> str:
    machine = platform.machine().lower()
    return f"{sys.platform}-" + {
        "aarch64": "arm64",
        "arm64": "arm64",
        "amd64": "x64",
        "x86_64": "x64",
    }.get(machine, "unsupported")


def trusted_executable(path: Path) -> bool:
    expected = EXECUTABLE_HASHES.get(platform_key())
    if expected is None or not path.is_absolute():
        return False
    try:
        if any(parent.is_symlink() for parent in (path, *path.parents)):
            return False
        with path.open("rb") as source:
            if os.fstat(source.fileno()).st_size != EXECUTABLE_SIZES.get(platform_key()):
                return False
            return hashlib.file_digest(source, "sha256").hexdigest() == expected
    except OSError:
        return False


def helper_environment(root: Path) -> dict[str, str]:
    """Only owned empty directories; never user GH config or home/PATH overrides."""
    if not root.is_absolute() or root.is_symlink():
        raise ValueError("Unavailable helper root")
    if any(parent.is_symlink() for parent in root.parents):
        raise ValueError("Unavailable helper root")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    env = {
        "GH_NO_UPDATE_NOTIFIER": "1",
        "GH_NO_EXTENSION_UPDATE_NOTIFIER": "1",
        "GH_TELEMETRY": "0",
        "GH_PROMPT_DISABLED": "1",
        "LANG": "C.UTF-8",
    }
    for key, name in [
        ("GH_CONFIG_DIR", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_CACHE_HOME", "cache"),
        ("TMPDIR", "tmp"),
    ]:
        path = root / name
        if path.is_symlink():
            raise ValueError("Unavailable helper root")
        path.mkdir(mode=0o700, exist_ok=True)
        if any(path.iterdir()):
            raise ValueError("Unavailable helper root")
        env[key] = str(path)
    env["TMP"] = env["TEMP"] = env["TMPDIR"]
    for key in ("SystemRoot", "WINDIR"):
        if value := os.environ.get(key):
            env[key] = value
    return env


async def _bounded(stream: asyncio.StreamReader, limit: int) -> bytes:
    data = bytearray()
    while chunk := await stream.read(min(4096, limit + 1 - len(data))):
        data.extend(chunk)
        if len(data) > limit:
            raise ValueError("Helper output limit")
    return bytes(data)


async def _reap(process: asyncio.subprocess.Process) -> None:
    # POSIX new-session ownership includes gh's fixed /usr/bin/security child.
    # Windows pinned Get is in-process CredReadW, with no helper descendants.
    def stop(force: bool) -> None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
            elif process.returncode is None:
                process.kill() if force else process.terminate()
        except ProcessLookupError:
            pass

    stop(False)
    await asyncio.sleep(0.05)
    stop(True)  # Also kill lingering group members after an already-exited gh.
    await process.wait()


async def run_helper(
    executable: Path, root: Path, args: tuple[str, ...], deadline: datetime
) -> bytes | None:
    """Trusted fixed invocation, bounded pipe readers, owned process group, no reflection."""
    if deadline.tzinfo is None:
        return None
    remaining = min(5.0, (deadline - datetime.now(UTC)).total_seconds())
    if remaining <= 0 or not trusted_executable(executable):
        return None
    process = None
    workers: list[asyncio.Task[bytes]] = []
    interrupted = False
    try:
        env = helper_environment(root)
        remaining = min(remaining, (deadline - datetime.now(UTC)).total_seconds())
        if remaining <= 0:
            return None
        async with asyncio.timeout(remaining):
            starting = asyncio.create_task(
                asyncio.create_subprocess_exec(
                    str(executable),
                    *args,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                    cwd=root,
                    start_new_session=os.name == "posix",
                    creationflags=0x00000200 if os.name == "nt" else 0,
                )
            )
            try:
                process = await asyncio.shield(starting)
            except asyncio.CancelledError:
                # Cancellation must not lose ownership between OS spawn and pipe setup.
                while not starting.done():
                    with suppress(asyncio.CancelledError):
                        await asyncio.shield(starting)
                process = starting.result()
                raise
            assert process.stdout is not None and process.stderr is not None
            workers = [
                asyncio.create_task(_bounded(process.stdout, 8192)),
                asyncio.create_task(_bounded(process.stderr, 16384)),
            ]
            stdout, _ = await asyncio.gather(*workers)
            code = await process.wait()
            return stdout if code == 0 else None
    except (OSError, ValueError, TimeoutError):
        return None
    finally:
        if process is not None:
            cleanup = asyncio.create_task(_reap(process))
            while not cleanup.done():
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    interrupted = True  # Finish cleanup, then preserve cancellation.
            cleanup.result()
        for task in workers:
            task.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        if interrupted:
            raise asyncio.CancelledError


async def _identity_body(reader: asyncio.StreamReader) -> bytes:
    header = await reader.readuntil(b"\r\n\r\n")
    if len(header) > 8192:
        raise ValueError("Identity response limit")
    lines = header.split(b"\r\n")
    if lines[0] != b"HTTP/1.1 200 OK" and lines[0] != b"HTTP/1.0 200 OK":
        raise ValueError("Identity rejected")  # No redirect, retry, proxy or endpoint override.
    fields: dict[bytes, bytes] = {}
    for line in lines[1:-2]:
        name, value = line.split(b":", 1)
        name = name.lower()
        if name in fields:
            raise ValueError("Identity response invalid")
        fields[name] = value.strip()
    if fields.get(b"content-encoding", b"identity") != b"identity":
        raise ValueError("Identity response invalid")
    if b"transfer-encoding" in fields:
        if fields[b"transfer-encoding"] != b"chunked" or b"content-length" in fields:
            raise ValueError("Identity response invalid")
        data = bytearray()
        while True:
            size_line = await reader.readuntil(b"\r\n")
            if len(size_line) > 16 or not re.fullmatch(rb"[0-9a-fA-F]+\r\n", size_line):
                raise ValueError("Identity response invalid")
            size = int(size_line, 16)
            if size == 0:
                if await reader.readexactly(2) != b"\r\n":
                    raise ValueError("Identity response invalid")
                return bytes(data)
            if size + len(data) > 16384:
                raise ValueError("Identity response limit")
            data.extend(await reader.readexactly(size))
            if await reader.readexactly(2) != b"\r\n":
                raise ValueError("Identity response invalid")
    length = int(fields[b"content-length"])
    if not 0 < length <= 16384:
        raise ValueError("Identity response limit")
    return await reader.readexactly(length)


@dataclass(frozen=True)
class ProtectedSource:
    """Immutable selected login, fresh protected credential for each disposable session."""

    executable: Path
    root: Path
    login: str

    def __post_init__(self) -> None:
        if not LOGIN.fullmatch(self.login):
            raise ValueError("Invalid selected account")

    async def __call__(self, request_id: str, deadline: datetime) -> str | None:
        token = None
        if deadline.tzinfo is None:
            return None
        deadline = min(deadline, datetime.now(UTC) + timedelta(seconds=5))
        try:
            raw = await run_helper(
                self.executable,
                self.root,
                (
                    "auth",
                    "token",
                    "--hostname",
                    "github.com",
                    "--user",
                    self.login,
                    "--secure-storage",
                    "--no-refresh",
                ),
                deadline,
            )
            if raw is None:
                return None
            token = raw.removesuffix(b"\n").decode("ascii")
            raw = None
            if not TOKEN.fullmatch(token) or not await self._identity(token, self.login, deadline):
                return None
            return token
        except (
            OSError,
            ValueError,
            KeyError,
            RecursionError,
            TimeoutError,
            asyncio.IncompleteReadError,
            asyncio.LimitOverrunError,
        ):
            return None
        finally:
            token = None

    async def _identity(self, token: str, login: str, deadline: datetime) -> bool:
        writer = None
        remaining = min(5.0, (deadline - datetime.now(UTC)).total_seconds())
        if remaining <= 0:
            return False
        try:
            async with asyncio.timeout(remaining):
                reader, writer = await asyncio.open_connection(
                    "api.github.com",
                    443,
                    ssl=identity_context(),
                    server_hostname="api.github.com",
                    limit=8192,
                )
                writer.write(
                    (
                        "GET /user HTTP/1.1\r\nHost: api.github.com\r\nUser-Agent: Sage\r\n"
                        "Accept: application/vnd.github+json\r\n"
                        "X-GitHub-Api-Version: 2022-11-28\r\n"
                        "Accept-Encoding: identity\r\nConnection: close\r\n"
                        "Authorization: Bearer " + token + "\r\n\r\n"
                    ).encode("ascii")
                )
                await writer.drain()
                body = await _identity_body(reader)
                from sage.protocol import _pairs

                account = json.loads(body, object_pairs_hook=_pairs)
                return (
                    isinstance(account, dict)
                    and isinstance(account.get("login"), str)
                    and account["login"].lower() == login.lower()
                    and type(account.get("id")) is int
                    and account["id"] > 0
                )
        finally:
            if writer is not None:
                writer.close()
                with suppress(OSError, TimeoutError):
                    await asyncio.wait_for(writer.wait_closed(), 0.5)
