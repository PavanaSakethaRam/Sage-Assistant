"""Fixed public SDK import/constructor probe; Python capability guard, not an OS sandbox.

Only trusted import-resource reads are admitted. The short-lived process never
starts/stops a client, discovers a runtime, creates a session, or opens a Store.
The guard is for observing accidental constructor/import side effects of pinned
code, not for executing hostile Python or native code.
"""

import importlib.metadata
import json
import os
import stat
import struct
import sys
import sysconfig
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, ValidationError

from sage.contracts import Contract
from sage.providers.copilot import SDK_VERSION, _unique_object, construct_client, failure_category

Category = Literal[
    "none",
    "dependency_error",
    "contract_error",
    "io_error",
    "unexpected_error",
    "blocked_network",
    "blocked_process",
    "blocked_storage",
    "blocked_native",
    "blocked_output",
]


class ProbeResult(Contract):
    schema_version: Literal[1] = Field(alias="schema")
    status: Literal["pass", "fail"]
    stage: Literal["guard", "sdk_import", "sdk_construct", "complete"]
    category: Category
    sdk: Literal["1.0.25", "unavailable"]
    python: Annotated[str, Field(pattern=r"^3\.13\.[0-9]{1,3}$")]
    frozen: bool


class CapabilityGuard:
    """Deny audited capabilities plus unaudited Python metadata/output entry points.

    Trusted roots are computed before installation, never supplied by CLI input.
    A denial latches even when vendor code catches PermissionError. Audit hooks
    cannot be removed; install only in this terminating diagnostic process.
    """

    def __init__(self, *, roots: tuple[Path, ...] | None = None) -> None:
        self.denied: Category | None = None
        paths = roots or (
            (Path(sys._MEIPASS),)  # type: ignore[attr-defined]
            if getattr(sys, "frozen", False)
            else (
                Path(sysconfig.get_path("stdlib")),
                Path(sysconfig.get_path("purelib")),
                Path(sysconfig.get_path("platlib")),
                Path(__file__).resolve().parent,
            )
        )
        self.roots = tuple(os.path.realpath(path) for path in paths)
        # The frozen PYZ importer reopens this exact containing executable for reads.
        # It lives beside _MEIPASS; its directory and neighbors are not admitted.
        self.container = os.path.realpath(sys.executable) if getattr(sys, "frozen", False) else None
        # Captured metadata functions let admission resolve symlinks without recursion.
        self._stat = os.stat
        self._lstat = os.lstat
        self._readlink = os.readlink

    def deny(self, category: Category) -> Any:
        self.denied = self.denied or category
        raise PermissionError("SDK probe capability denied")

    def read(self, path: Any) -> None:
        if not isinstance(path, (str, bytes, os.PathLike)):
            self.deny("blocked_storage")
        name = os.fsdecode(path)
        # Admission is lexical first: realpath would inspect denied locations
        # while resolving them. Canonical trusted roots were fixed before hooks.
        name = os.path.abspath(name)
        root = next(
            (root for root in self.roots if name == root or name.startswith(root + os.sep)), None
        )
        if name == self.container:
            candidates = [name]
        elif root is not None:
            candidates = [root]
            for part in Path(name).relative_to(root).parts:
                candidates.append(os.path.join(candidates[-1], part))
        else:
            self.deny("blocked_storage")
        # Never follow a link, including one pointing back inside the import root.
        # Every metadata query below is already lexically admitted. Missing import
        # candidates remain ordinary not-found results, without probing descendants.
        for candidate in candidates:
            try:
                mode = self._lstat(candidate).st_mode
            except FileNotFoundError:
                break
            if stat.S_ISLNK(mode):
                self.deny("blocked_storage")

    def audit(self, event: str, args: tuple[Any, ...]) -> None:
        if event == "open":
            mode, flags = args[1:3]
            if (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int)
                and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)
            ):
                self.deny("blocked_storage")
            self.read(args[0])
        elif event in {"os.listdir", "os.scandir"}:
            self.read(args[0])
        elif event.startswith("socket."):
            self.deny("blocked_network")
        elif event.startswith(
            ("subprocess.", "os.exec", "os.spawn", "os.posix_spawn")
        ) or event in {
            "os.system",
            "os.fork",
            "os.forkpty",
            "os.kill",
            "os.killpg",
            "os.startfile",
        }:
            self.deny("blocked_process")
        elif event in {"ctypes.dlopen", "ctypes.dlsym", "ctypes.call_function"}:
            self.deny("blocked_native")
        elif event.startswith(("sqlite3.", "winreg.")) or event in {
            "os.remove",
            "os.rename",
            "os.rmdir",
            "os.mkdir",
            "os.link",
            "os.symlink",
            "os.truncate",
            "os.chmod",
            "os.chown",
            "os.utime",
            "os.chdir",
            "os.putenv",
            "os.unsetenv",
            "os.setxattr",
            "os.removexattr",
            "shutil.copyfile",
        }:
            self.deny("blocked_storage")

    def install(self) -> None:
        import ctypes  # noqa: F401 -- trusted stdlib bootstrap before denying native loads

        sys.dont_write_bytecode = True
        # metadata.version searches sys.path, including cwd in an ordinary launch.
        # Only the already-derived trusted import roots belong in this diagnostic.
        sys.path[:] = self.roots
        sys.addaudithook(self.audit)

        # stat/lstat/access/readlink do not emit CPython audit events.
        def metadata(original: Callable[..., Any]) -> Callable[..., Any]:
            def checked(path: Any, *args: Any, **kwargs: Any) -> Any:
                if kwargs.get("dir_fd") is not None:
                    self.deny("blocked_storage")
                self.read(path)
                return original(path, *args, **kwargs)

            return checked

        os.stat = metadata(self._stat)
        os.lstat = metadata(self._lstat)
        os.readlink = metadata(self._readlink)
        os.access = metadata(os.access)
        os.open = lambda *_args, **_kwargs: self.deny("blocked_storage")
        os.read = lambda *_: self.deny("blocked_storage")
        os.write = lambda *_: self.deny("blocked_output")
        os.getlogin = lambda: self.deny("blocked_storage")
        for name in ("stdout", "stderr", "__stdout__", "__stderr__"):
            setattr(sys, name, _Silent(self))


class _Silent:
    def __init__(self, guard: CapabilityGuard) -> None:
        self.guard = guard
        self.buffer = self

    def write(self, value: Any) -> Any:
        return self.guard.deny("blocked_output")

    def flush(self) -> None:
        pass


def probe(guard: CapabilityGuard | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "schema": 1,
        "status": "fail",
        "stage": "guard",
        "category": "unexpected_error",
        "sdk": "unavailable",
        "python": ".".join(map(str, sys.version_info[:3])),
        "frozen": bool(getattr(sys, "frozen", False)),
    }
    guard = guard or CapabilityGuard()
    try:
        if importlib.metadata.version("github-copilot-sdk") != SDK_VERSION:
            result["category"] = "dependency_error"
            return result
        result["sdk"] = SDK_VERSION
        guard.install()
        result["stage"] = "sdk_import"
        from copilot import CopilotClient, RuntimeConnection
        from copilot.generated.rpc import PermissionDecisionReject  # noqa: F401

        if guard.denied is not None:
            guard.deny(guard.denied)
        result["stage"] = "sdk_construct"
        sentinel = (
            r"C:\__sage_sdk_probe__\not-executable"
            if os.name == "nt"
            else "/__sage_sdk_probe__/not-executable"
        )
        construct_client(CopilotClient, RuntimeConnection, sentinel, sentinel)
        result.update(status="pass", stage="complete", category="none")
    except Exception as exc:
        result["category"] = failure_category(exc)
    if guard.denied is not None:
        result.update(status="fail", category=guard.denied)
        if result["stage"] == "complete":
            result["stage"] = "sdk_construct"
    return result


def decode_result(frame: bytes) -> dict[str, Any]:
    if len(frame) < 4 or len(frame) > 16388 or struct.unpack(">I", frame[:4])[0] != len(frame) - 4:
        raise ValueError("Invalid SDK probe frame")
    try:
        value = ProbeResult.model_validate(json.loads(frame[4:], object_pairs_hook=_unique_object))
        if (value.status == "pass" and (value.stage != "complete" or value.category != "none")) or (
            value.status == "fail" and (value.stage == "complete" or value.category == "none")
        ):
            raise ValueError
        return value.model_dump(by_alias=True)
    except (ValidationError, ValueError, RecursionError) as exc:
        raise ValueError("Invalid SDK probe result") from exc


def sdk_self_check() -> int:
    stream = sys.stdout  # Retain wrapper ownership as well as the binary sink.
    sink = stream.buffer
    encoded = json.dumps(probe(), separators=(",", ":")).encode("utf-8")
    frame = struct.pack(">I", len(encoded)) + encoded
    data = decode_result(frame)
    sink.write(frame)
    sink.flush()
    return 0 if data["status"] == "pass" else 1
