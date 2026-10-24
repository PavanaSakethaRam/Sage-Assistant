"""The note, consumed approval and outcome have one SQLite commit boundary."""

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Barrier, Event

import pytest

from sage.actions import ActionService
from sage.storage import Store

NOW = datetime(2035, 1, 2, 12, tzinfo=UTC)


class Crash(BaseException):
    pass


class CrashConnection(sqlite3.Connection):
    crash: str | None = None

    def commit(self) -> None:
        if self.crash == "before":
            raise Crash()
        super().commit()
        if self.crash == "after":
            raise Crash()


def setup(path: Path) -> tuple[Store, ActionService]:
    initial = Store.open(path)
    initial.close()
    connection = sqlite3.connect(path, factory=CrashConnection, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    store = Store(connection)
    return store, ActionService(store, lambda: NOW, "boot-1")


def test_crash_before_commit_leaves_no_note(tmp_path: Path) -> None:
    crash_at_commit(tmp_path, "before")


def test_crash_after_commit_recovers_same_outcome(tmp_path: Path) -> None:
    crash_at_commit(tmp_path, "after")


def crash_at_commit(tmp_path: Path, boundary: str) -> None:
    path = tmp_path / "state.sqlite"
    store, actions = setup(path)
    proposal = actions.propose_note("task-1", " Exact é ", "\tBody\r\n")
    connection = store._connection
    assert isinstance(connection, CrashConnection)
    connection.crash = boundary
    try:
        with pytest.raises(Crash):
            actions.decide(proposal.id, 1, "save")
    finally:
        store.close()
    reopened = Store.open(path)
    try:
        with reopened.transaction() as db:
            assert db.execute("SELECT count(*) FROM notes").fetchone()[0] == (boundary == "after")
            assert db.execute("SELECT count(*) FROM operations").fetchone()[0] == (
                boundary == "after"
            )
            assert (db.execute("SELECT consumed_at FROM approvals").fetchone()[0] is not None) == (
                boundary == "after"
            )
        restarted = ActionService(reopened, lambda: NOW, "boot-2")
        result = restarted.decide(proposal.id, 1, "save")
        assert result.status == ("succeeded" if boundary == "after" else "rejected")
        if boundary == "after":
            assert reopened.list_notes()[0].id == result.note_id
            assert restarted.decide(proposal.id, 1, "save") == result
    finally:
        reopened.close()


def test_concurrent_save_recovers_same_outcome(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite"
    store = Store.open(path)
    proposal = ActionService(store, lambda: NOW, "boot-1").propose_note("task-1", "Title", "Body")
    store.close()
    barrier = Barrier(2)

    def save() -> tuple[str | None, str | None]:
        own = Store.open(path)
        try:
            service = ActionService(own, lambda: NOW, "boot-1")
            barrier.wait(timeout=5)
            result = service.decide(proposal.id, 1, "save")
            assert result.status == "succeeded"
            return result.operation_id, result.note_id
        finally:
            own.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(save) for _ in range(2)]
        results = [future.result(timeout=10) for future in futures]
    assert results[0] == results[1]
    reopened = Store.open(path)
    try:
        assert len(reopened.list_notes()) == 1
        with reopened.transaction() as db:
            assert db.execute("SELECT count(*) FROM operations").fetchone()[0] == 1
    finally:
        reopened.close()


def test_storage_failure_rolls_back_effect_and_redacts_diagnostic(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite"
    store = Store.open(path)
    actions = ActionService(store, lambda: NOW, "boot-1")
    try:
        proposal = actions.propose_note("task-1", "private-title", "private-body")
        with store.transaction() as db:
            db.execute(
                "CREATE TRIGGER fail_operation BEFORE INSERT ON operations "
                "BEGIN SELECT RAISE(ABORT,'private-body'); END"
            )
        result = actions.decide(proposal.id, 1, "save")
        assert result.status == "failed"
        assert result.diagnostic is not None and "private" not in result.diagnostic
        assert store.list_notes() == []
        with store.transaction() as db:
            assert db.execute("SELECT consumed_at FROM approvals").fetchone()[0] is None
            db.execute("DROP TRIGGER fail_operation")
        assert actions.decide(proposal.id, 1, "save").status == "succeeded"
    finally:
        store.close()
    assert actions.cancel_task("task-1").status == "failed"


@pytest.mark.parametrize("winner", ["save", "cancel"])
def test_save_cancel_race_reports_committed_order(tmp_path: Path, winner: str) -> None:
    path = tmp_path / "state.sqlite"
    initial = Store.open(path)
    try:
        proposal = ActionService(initial, lambda: NOW, "boot-1").propose_note(
            "task-1", "Title", "Body"
        )
    finally:
        initial.close()
    ready = Barrier(2)
    locked, attempted, release = Event(), Event(), Event()

    def request(kind: str) -> tuple[str, str | None]:
        own = Store.open(path)
        try:

            def clock() -> datetime:
                if kind == winner:
                    locked.set()
                    assert release.wait(timeout=5)
                return NOW

            service = ActionService(own, clock, "boot-1")
            ready.wait(timeout=5)
            if kind != winner:
                assert locked.wait(timeout=5)
                attempted.set()
            result = (
                service.decide(proposal.id, 1, "save")
                if kind == "save"
                else service.cancel_task("task-1")
            )
            return result.status, result.note_id
        finally:
            own.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(request, kind) for kind in ("save", "cancel")]
        try:
            assert attempted.wait(timeout=5)
        finally:
            release.set()
        results = [future.result(timeout=10) for future in futures]
    reopened = Store.open(path)
    try:
        if winner == "save":
            assert results[0] == results[1]
            assert results[0][0] == "succeeded"
            assert len(reopened.list_notes()) == 1
        else:
            assert results == [("cancelled", None), ("cancelled", None)]
            assert reopened.list_notes() == []
        with reopened.transaction() as db:
            assert db.execute("SELECT count(*) FROM operations").fetchone()[0] == (winner == "save")
    finally:
        reopened.close()
