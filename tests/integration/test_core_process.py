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
