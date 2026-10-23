"""Explicit private-pipe startup. Importing this module opens nothing."""

import argparse
import asyncio
import os
import sys
from collections.abc import Callable
from pathlib import Path

from sage.logging import diagnostic
from sage.paths import app_paths
from sage.protocol import SelectedAccount
from sage.providers.copilot import CopilotReasoner
from sage.providers.protected_auth import ProtectedSource, identity_context
from sage.providers.session_store import SessionStore
from sage.service import CoreService, run_service
from sage.storage import Store


class WindowsPipe:
    """Own one CRT duplicate while exposing its overlapped OS handle to Proactor.

    The inherited handles must be overlapped (Node stdio=overlapped). Console
    streams and ordinary synchronous Popen pipes are not supported by this path.
    """

    def __init__(self, descriptor: int, handle_of: Callable[[int], int] | None = None) -> None:
        if handle_of is None:
            import msvcrt

            handle_of = msvcrt.get_osfhandle  # type: ignore[attr-defined]
        self.descriptor = os.dup(descriptor)
        self._closed = False
        try:
            os.set_inheritable(self.descriptor, False)
            self._handle = handle_of(self.descriptor)
        except BaseException:
            self.close()
            raise

    def fileno(self) -> int:
        if self._closed:
            raise ValueError("Closed pipe")
        return self._handle

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            os.close(self.descriptor)


async def _run(
    root: Path | None, runtime_path: Path | None = None, gh_path: Path | None = None
) -> None:
    paths = app_paths(root)
    store = Store.open(paths.database)
    service: CoreService | None = None
    transport: asyncio.ReadTransport | None = None
    output_transport: asyncio.WriteTransport | None = None
    owned_pipes: list[WindowsPipe] = []
    try:
        sessions = SessionStore(paths.cache_dir / "copilot-disposable")
        sessions.recover_cleanup()

        def backend(account: SelectedAccount | None) -> CopilotReasoner:
            assert service is not None
            source = (
                ProtectedSource(gh_path, paths.cache_dir / "gh-protected", account.login)
                if gh_path is not None and account is not None
                else None
            )
            return CopilotReasoner(
                sessions,
                runtime_path=runtime_path,
                settings=service.get_settings,
                clock=service.clock,
                token_source=source,
            )

        service = CoreService(store, backend_factory=backend)
        service.backend = backend(None)
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        source = sys.stdin.buffer
        sink = sys.stdout.buffer
        if sys.platform == "win32":
            # Register only duplicates with IOCP; the original stdio owners remain
            # untouched. Each successful construction enters cleanup immediately.
            source_pipe = WindowsPipe(source.fileno())
            owned_pipes.append(source_pipe)
            sink_pipe = WindowsPipe(sink.fileno())
            owned_pipes.append(sink_pipe)
            source = source_pipe  # type: ignore[assignment]
            sink = sink_pipe  # type: ignore[assignment]
        transport, _ = await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), source
        )
        output_protocol = asyncio.StreamReaderProtocol(asyncio.StreamReader())
        output_transport, _ = await loop.connect_write_pipe(lambda: output_protocol, sink)
        writer = asyncio.StreamWriter(output_transport, output_protocol, None, loop)
        diagnostic("core_started")
        await run_service(reader, writer, service)
    finally:
        if transport is not None:
            transport.close()
        if output_transport is not None:
            output_transport.close()
        # Proactor schedules connection_lost/close callbacks on the next turn.
        # Let transports finish before idempotently closing unregistered owners.
        await asyncio.sleep(0)
        for pipe in owned_pipes:
            pipe.close()
        if service is not None:
            await service.aclose()
        else:
            store.close()
        diagnostic("core_stopped")


def self_check() -> None:
    """One fixed offline evidence frame; no service/storage/provider initialization."""
    import importlib.metadata
    import importlib.util
    import json
    import sqlite3
    import ssl
    import struct

    ssl_spec = importlib.util.find_spec("_ssl")
    context = identity_context()
    paths = ssl.get_default_verify_paths()
    data = {
        "schema": 1,
        "python": sys.version,
        "openssl": ssl.OPENSSL_VERSION,
        "sqlite": sqlite3.sqlite_version,
        "sdk": importlib.metadata.version("github-copilot-sdk"),
        "certifi": importlib.metadata.version("certifi"),
        "frozen": bool(getattr(sys, "frozen", False)),
        "ssl_module": ssl_spec.origin if ssl_spec is not None else "unavailable",
        "bundle": str(Path(__file__).resolve().parent),
        "trust": {
            "verify_mode": int(context.verify_mode),
            "check_hostname": context.check_hostname,
            "verify_flags": int(context.verify_flags),
            "store": context.cert_store_stats(),
            "default_paths": paths._asdict(),
            "cafile_exists": bool(paths.cafile and Path(paths.cafile).is_file()),
            "capath_exists": bool(paths.capath and Path(paths.capath).is_dir()),
        },
        "environment_overrides": {
            key: key in os.environ
            for key in (
                "SSL_CERT_FILE",
                "SSL_CERT_DIR",
                "SSLKEYLOGFILE",
                "HTTPS_PROXY",
                "ALL_PROXY",
            )
        },
    }
    encoded = json.dumps(data, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 16384:
        raise ValueError("Self-check frame limit")
    sys.stdout.buffer.write(struct.pack(">I", len(encoded)) + encoded)
    sys.stdout.buffer.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description="Sage private core")
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Trusted isolated application root (not an RPC option)",
    )

    def absolute_path(value: str) -> Path:
        path = Path(value)
        if not path.is_absolute():
            raise argparse.ArgumentTypeError("Runtime path must be absolute")
        return path

    parser.add_argument(
        "--copilot-runtime",
        type=absolute_path,
        default=None,
        help="Fixed trusted deployment runtime (not an RPC option)",
    )
    parser.add_argument(
        "--gh-runtime",
        type=absolute_path,
        default=None,
        help="Fixed managed gh2.103.0 deployment (not an RPC option)",
    )
    parser.add_argument("--self-check", action="store_true", help="Fixed offline package evidence")
    args = parser.parse_args()
    if args.self_check:
        if args.root is not None or args.copilot_runtime is not None or args.gh_runtime is not None:
            parser.error("Self-check accepts no service options")
        self_check()
        return 0
    try:
        asyncio.run(_run(args.root, args.copilot_runtime, args.gh_runtime))
        return 0
    except (Exception, KeyboardInterrupt):
        diagnostic("startup_failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
