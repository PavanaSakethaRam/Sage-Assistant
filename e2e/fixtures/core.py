"""Test-only composition: real startup/pipes/service/storage and synthetic reasoning."""

import asyncio
import json
import os
import socket
import sqlite3
import sys
from pathlib import Path

import sage.__main__ as entry
import sage.storage as storage
from sage.contracts import NoteContent, ProviderReadiness, ReasoningResult

ROOT = Path(sys.argv[sys.argv.index("--root") + 1])


def event(name):
    with (ROOT / "events.jsonl").open("a") as stream:
        stream.write(json.dumps({"event": name, "pid": os.getpid()}) + "\n")


def no_egress(*args, **kwargs):
    event("forbidden_egress")
    raise AssertionError("deterministic core egress blocked")


class FakeReasoner:
    def __init__(self, *args, **kwargs):
        self.release = asyncio.Event()

    def readiness(self):
        return ProviderReadiness(
            provider="copilot", status="ready", explanation="synthetic fixture"
        )

    async def reason(self, request):
        event("provider_call")
        mode = request.user_text
        if mode == "crash":
            event("crashed")
            os._exit(9)
        if mode == "quota":
            return ReasoningResult(
                request_id=request.request_id, status="error", text="quota_exceeded"
            )
        if mode == "late":
            event("late_started")
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                await self.release.wait()
            event("late_finished")
        if mode == "egress_probe":
            socket.create_connection(("127.0.0.1", 9))
        return ReasoningResult(
            request_id=request.request_id,
            status="completed",
            text="Synthetic response",
            proposal=NoteContent(title="Provider draft", body="Synthetic reviewed body"),
        )

    async def cancel(self, request_id):
        event("cancelled")
        self.release.set()

    async def aclose(self):
        self.release.set()


class FaultConnection(sqlite3.Connection):
    def execute(self, sql, parameters=()):
        if sql.startswith("INSERT INTO notes "):
            event("effect_attempt")
        fault = ROOT / "full.once"
        if fault.exists() and sql.startswith("INSERT INTO notes "):
            fault.unlink()
            event("sqlite_full")
            raise sqlite3.OperationalError("database or disk is full")
        return super().execute(sql, parameters)


original_connect = sqlite3.connect


def connect(*args, **kwargs):
    kwargs["factory"] = FaultConnection
    return original_connect(*args, **kwargs)


sqlite3.connect = connect
original_scripts = storage._migration_scripts


def scripts():
    if (ROOT / "migration.fail").exists():
        event("migration_failed")
        raise sqlite3.OperationalError("synthetic migration failure")
    return original_scripts()


storage._migration_scripts = scripts
entry.CopilotReasoner = FakeReasoner
entry.ProtectedSource = no_egress


# asyncio.run constructs the Windows Proactor self-pipe before running this
# coroutine. Deny application egress as soon as the loop exists, before _run.
original_asyncio_run = asyncio.run


def guarded_run(coroutine):
    async def guarded():
        event("loop_ready")
        socket.socket.connect = no_egress
        socket.socket.connect_ex = no_egress
        socket.create_connection = no_egress
        # Any attempted native helper/process is a test failure.
        sys.addaudithook(
            lambda name, args: (
                no_egress() if name in {"subprocess.Popen", "os.system", "os.posix_spawn"} else None
            )
        )
        return await coroutine

    return original_asyncio_run(guarded())


entry.asyncio.run = guarded_run
event("started")
try:
    raise SystemExit(entry.main())
finally:
    event("stopped")
