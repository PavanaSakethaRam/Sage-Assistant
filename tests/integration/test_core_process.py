"""Actual private stdin/stdout lifecycle with isolated disposable state."""

import asyncio
import json
import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

import pytest

from sage.protocol import encode_frame, read_frame


def test_process_shutdown_releases_resources(tmp_path: Path) -> None:
    async def run() -> None:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "sage",
            "--root",
            str(tmp_path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")},
        )
        assert process.stdin is not None and process.stdout is not None
        for identifier, method, params in [
            ("p", "notes.propose", {"title": "Title", "body": "Body"}),
            ("shutdown", "app.shutdown", {}),
        ]:
            process.stdin.write(
                encode_frame(
                    {
                        "version": 1,
                        "id": identifier,
                        "kind": "request",
                        "method": method,
                        "params": params,
                    }
                )
            )
            await process.stdin.drain()
            response = await asyncio.wait_for(read_frame(process.stdout), 5)
            assert response["id"] == identifier
            assert response["kind"] == "response"
        stdout, stderr = await asyncio.wait_for(process.communicate(), 5)
        assert process.returncode == 0
        assert stdout == b""
        assert b"Traceback" not in stderr
        database = tmp_path / "data" / "sage.sqlite3"
        db = sqlite3.connect(database, timeout=0)
        try:
            db.execute("BEGIN EXCLUSIVE")
            assert db.execute("SELECT count(*) FROM revisions WHERE body='Body'").fetchone()[0] == 1
        finally:
            db.close()
        assert "Body" not in stderr.decode()

    asyncio.run(run())


def test_bad_process_frame_never_prints_content(tmp_path: Path) -> None:
    async def run() -> None:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "sage",
            "--root",
            str(tmp_path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")},
        )
        body = b'{"secret":"SYNTHETIC_SECRET",broken}'
        stdout, stderr = await asyncio.wait_for(
            process.communicate(len(body).to_bytes(4, "big") + body), 5
        )
        assert process.returncode == 0
        assert b"SYNTHETIC_SECRET" not in stdout + stderr
        reader = asyncio.StreamReader()
        reader.feed_data(stdout)
        reader.feed_eof()
        response = await read_frame(reader)
        assert response["kind"] == "error"
        assert response["code"] == "invalid_frame"
        assert json.loads(stdout[4:]) == response

    asyncio.run(run())


def test_entrypoint_real_pipes_and_failure_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import io

    from sage.__main__ import main

    for fails in (False, True):
        root = tmp_path / str(fails)
        if fails:
            root.write_text("blocked", encoding="utf-8")
        source_read, source_write = os.pipe()
        output_read, output_write = os.pipe()
        os.write(
            source_write,
            encode_frame(
                {
                    "version": 1,
                    "id": "shutdown",
                    "kind": "request",
                    "method": "app.shutdown",
                    "params": {},
                }
            ),
        )
        os.close(source_write)
        with (
            os.fdopen(source_read, "rb") as source,
            os.fdopen(output_write, "wb") as sink,
            monkeypatch.context() as patch,
        ):
            patch.setattr(sys, "stdin", io.TextIOWrapper(source))
            patch.setattr(sys, "stdout", io.TextIOWrapper(sink))
            patch.setattr(sys, "argv", ["sage", "--root", str(root)])
            assert main() == (1 if fails else 0)
        with os.fdopen(output_read, "rb") as output:
            frame = output.read()
        if fails:
            assert frame == b""
        else:
            assert json.loads(frame[4:])["result"] == {"status": "shutting_down"}
    logs = capsys.readouterr()
    assert logs.out == ""
    assert logs.err == "core_started\ncore_stopped\nstartup_failed\n"


def test_startup_partial_failure_closes_opened_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from datetime import UTC, datetime

    from sage.__main__ import main
    from sage.storage import Store

    store = Store.open(tmp_path / "data" / "sage.sqlite3")
    with store.transaction() as db:
        stamp = datetime.now(UTC).isoformat(timespec="microseconds")
        db.execute(
            "INSERT INTO tasks (id,status,created_at,updated_at) VALUES (?,?,?,?)",
            ("inference", "reasoning", stamp, stamp),
        )
        db.execute(
            "CREATE TRIGGER deny_interrupt BEFORE UPDATE ON tasks "
            "BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECRET'); END"
        )
    store.close()
    monkeypatch.setattr(sys, "argv", ["sage", "--root", str(tmp_path)])
    assert main() == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "core_stopped\nstartup_failed\n"
    with closing(sqlite3.connect(tmp_path / "data" / "sage.sqlite3", timeout=0)) as check:
        check.execute("BEGIN EXCLUSIVE")
        assert check.execute("SELECT status FROM tasks").fetchone()[0] == "reasoning"


@pytest.mark.parametrize("high_observation", ["completion", "sdk_error", "cleanup_error"])
def test_production_provider_clock_expires_old_review_after_rollback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, high_observation: str
) -> None:
    """Removing startup's shared clock lets provider-only high samples revive Save."""
    import io
    from datetime import UTC, datetime, timedelta
    from typing import Any, Self

    import sage.__main__ as entry
    import sage.providers.copilot as provider_module
    import sage.service as service_module
    from sage.providers.copilot import CopilotReasoner
    from sage.providers.session_store import SessionStore
    from tests.helpers.copilot_fake import FakeSdk

    current = [datetime(2035, 1, 2, tzinfo=UTC)]
    baseline = current[0]

    class WallClock(datetime):
        @classmethod
        def now(cls, tz: Any = None) -> Self:
            return cls.fromtimestamp(current[0].timestamp(), tz)

    class AdvancingSdk(FakeSdk):
        async def send(self, prompt: str, **kwargs: Any) -> Any:
            if high_observation != "cleanup_error":
                current[0] = baseline + timedelta(seconds=20)
            return await super().send(prompt, **kwargs)

        async def stop(self) -> None:
            if high_observation == "cleanup_error":
                current[0] = baseline + timedelta(seconds=20)
                self.stop_error = True
            await super().stop()

    sdk = AdvancingSdk()
    sdk.output = '{"text":"Sage connection check","proposal":null}'
    if high_observation == "sdk_error":
        sdk.error = OSError("synthetic-private-marker")
    native = tmp_path / "native" / "copilot-runtime"
    native.parent.mkdir()
    native.touch()
    (native.parent / "runtime.node").touch()
    (native.parent / ".hostless-runtime-assets-v2").touch()

    class ConfiguredReasoner(CopilotReasoner):
        def __init__(self, sessions: SessionStore, **kwargs: Any) -> None:
            # Supply fake prerequisites only. Startup must supply its clock binding.
            super().__init__(
                sessions,
                runtime_path=native,
                token_source=lambda: "gho_synthetic",
                client_factory=sdk.client,
                **kwargs,
            )

    monkeypatch.setattr(service_module, "datetime", WallClock)
    monkeypatch.setattr(provider_module, "datetime", WallClock)
    monkeypatch.setattr(entry, "CopilotReasoner", ConfiguredReasoner)

    async def run() -> None:
        source_read, source_write = os.pipe()
        output_read, output_write = os.pipe()
        output_transport: asyncio.ReadTransport | None = None
        owned: asyncio.Task[None] | None = None
        with (
            os.fdopen(source_read, "rb") as source,
            os.fdopen(output_write, "wb") as sink,
            os.fdopen(output_read, "rb") as output,
            monkeypatch.context() as patch,
        ):
            patch.setattr(sys, "stdin", io.TextIOWrapper(source))
            patch.setattr(sys, "stdout", io.TextIOWrapper(sink))
            loop = asyncio.get_running_loop()
            reader = asyncio.StreamReader()
            output_transport, _ = await loop.connect_read_pipe(
                lambda: asyncio.StreamReaderProtocol(reader), output
            )
            owned = asyncio.create_task(entry._run(tmp_path))

            async def call(identifier: str, method: str, params: dict[str, Any]) -> Any:
                os.write(
                    source_write,
                    encode_frame(
                        {
                            "version": 1,
                            "id": identifier,
                            "kind": "request",
                            "method": method,
                            "params": params,
                        }
                    ),
                )
                response = await asyncio.wait_for(read_frame(reader), 5)
                assert response["id"] == identifier and response["kind"] == "response"
                return response["result"]

            try:
                await call(
                    "settings",
                    "settings.update",
                    {"ai_mode": "assistant", "reasoning_backend": "copilot"},
                )
                proposal = await call(
                    "propose", "notes.propose", {"title": "old", "body": "old body"}
                )
                connection = await call("check", "connection.test", {})
                expected = {
                    "completion": "ready",
                    "sdk_error": "error",
                    "cleanup_error": "incompatible",
                }
                assert connection["status"] == expected[high_observation]
                assert current[0] == baseline + timedelta(seconds=20)
                current[0] = baseline + timedelta(seconds=10)
                saved = await call(
                    "save",
                    "notes.decide",
                    {"proposal_id": proposal["id"], "revision": 1, "decision": "save"},
                )
                assert saved["status"] == "rejected"
                assert (await call("before", "notes.list", {}))["items"] == []
                revised = await call(
                    "revise",
                    "notes.revise",
                    {
                        "proposal_id": proposal["id"],
                        "revision": 1,
                        "title": "fresh",
                        "body": "fresh body",
                    },
                )
                fresh = await call(
                    "freshsave",
                    "notes.decide",
                    {"proposal_id": revised["id"], "revision": 2, "decision": "save"},
                )
                assert fresh["status"] == "succeeded"
                await call("shutdown", "app.shutdown", {})
                await asyncio.wait_for(owned, 5)
                assert list((tmp_path / "cache" / "copilot-disposable").iterdir()) == []
            finally:
                os.close(source_write)
                if owned is not None and not owned.done():
                    await asyncio.wait_for(owned, 5)
                if output_transport is not None:
                    output_transport.close()
        assert sdk.created == 1 and len(sdk.prompts) == 1
        with closing(sqlite3.connect(tmp_path / "data" / "sage.sqlite3", timeout=0)) as db:
            db.execute("BEGIN EXCLUSIVE")
            assert db.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 1

    asyncio.run(run())
