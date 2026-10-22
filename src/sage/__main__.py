"""Explicit private-pipe startup. Importing this module opens nothing."""

import argparse
import asyncio
import sys
from pathlib import Path

from sage.logging import diagnostic
from sage.paths import app_paths
from sage.service import CoreService, run_service
from sage.storage import Store


async def _run(root: Path | None) -> None:
    store = Store.open(app_paths(root).database)
    service: CoreService | None = None
    transport: asyncio.ReadTransport | None = None
    try:
        service = CoreService(store)
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        transport, _ = await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer
        )
        output_protocol = asyncio.StreamReaderProtocol(asyncio.StreamReader())
        output_transport, _ = await loop.connect_write_pipe(
            lambda: output_protocol, sys.stdout.buffer
        )
        writer = asyncio.StreamWriter(output_transport, output_protocol, None, loop)
        diagnostic("core_started")
        await run_service(reader, writer, service)
    finally:
        if transport is not None:
            transport.close()
        if service is not None:
            service.close()
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
    args = parser.parse_args()
    try:
        asyncio.run(_run(args.root))
        return 0
    except (Exception, KeyboardInterrupt):
        diagnostic("startup_failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
