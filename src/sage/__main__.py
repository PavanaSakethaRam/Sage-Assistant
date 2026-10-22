"""Explicit private-pipe startup. Importing this module opens nothing."""

import argparse
import asyncio
import os
import sys
from collections.abc import Callable
from pathlib import Path

from sage.logging import diagnostic
from sage.paths import app_paths
from sage.providers.copilot import CopilotReasoner
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


async def _run(root: Path | None, runtime_path: Path | None = None) -> None:
    paths = app_paths(root)
    store = Store.open(paths.database)
    service: CoreService | None = None
    transport: asyncio.ReadTransport | None = None
    output_transport: asyncio.WriteTransport | None = None
    owned_pipes: list[WindowsPipe] = []
    try:
        service = CoreService(store)
        sessions = SessionStore(paths.cache_dir / "copilot-disposable")
        sessions.recover_cleanup()
        service.backend = (
            CopilotReasoner(
                sessions,
                settings=service.get_settings,
                clock=service.clock,
                runtime_path=runtime_path,
            )
            if runtime_path is not None
            else CopilotReasoner(sessions, settings=service.get_settings, clock=service.clock)
        )
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
    args = parser.parse_args()
    try:
        asyncio.run(_run(args.root, args.copilot_runtime))
        return 0
    except (Exception, KeyboardInterrupt):
        diagnostic("startup_failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
