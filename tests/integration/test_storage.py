"""Real SQLite tests: retention, atomic effects and literal saved-note search."""

import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from time import monotonic
from typing import Literal

import pytest

from sage.contracts import Note
from sage.storage import StorageError, Store

NOW = datetime(2035, 1, 2, 12, tzinfo=UTC)
STAMP = "2035-01-02T12:00:00.000000+00:00"
BODY = "  # café e\u0301 😀\n\tLiteral $(touch /tmp/nope); 'quoted'\r\n  "


def seed_note(connection: sqlite3.Connection, note_id: str = "saved") -> None:
    connection.execute(
        "INSERT INTO notes(id,title,body,created_at,updated_at,task_id) VALUES(?,?,?,?,?,?)",
        (note_id, "  café 😀  ", BODY, STAMP, STAMP, "old-task"),
    )


def seed_task(connection: sqlite3.Connection, task_id: str, at: datetime) -> None:
    stamp = at.isoformat(timespec="microseconds")
    connection.execute("INSERT INTO tasks VALUES(?,?,?,?)", (task_id, "review", stamp, stamp))
    connection.execute(
        "INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)",
        ("p-" + task_id, task_id, 1, "notes.create", "notes", "draft", "private-marker", stamp),
    )
    connection.execute(
        "INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "a-" + task_id,
            task_id,
            "p-" + task_id,
            "notes.create",
            "draft",
            "private-marker",
            "a" * 64,
            1,
            "notes",
            "1",
            stamp,
            stamp,
            "pending",
            "boot",
            None,
        ),
    )
    connection.execute(
        "INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)",
        (
            "o-" + task_id,
            task_id,
            "p-" + task_id,
            "a-" + task_id,
            "failed",
            None,
            "safe diagnostic",
            stamp,
            stamp,
        ),
    )


@pytest.fixture
def store(tmp_path: Path) -> Iterator[Store]:
    opened = Store.open(tmp_path / "data" / "sage.sqlite3")
    try:
        yield opened
    finally:
        opened.close()


def test_fresh_store_and_exact_note_restart(tmp_path: Path) -> None:
    path = tmp_path / "sage.sqlite3"
    opened = Store.open(path)
    try:
        assert opened.list_notes() == []
        with opened.transaction() as connection:
            seed_note(connection)
    finally:
        opened.close()
    restarted = Store.open(path)
    try:
        assert restarted.list_notes() == [
            Note(
                id="saved",
                title="  café 😀  ",
                body=BODY,
                created_at=NOW,
                updated_at=NOW,
                task_id="old-task",
            )
        ]
    finally:
        restarted.close()


@pytest.mark.parametrize(
    "query,want",
    [
        ("café", ["saved"]),
        ("quoted", ["saved"]),
        ("café OR missing", []),
        ('" OR 1=1; DROP TABLE notes; --', []),
        ('"', []),
        ("*", []),
        ("", []),
        ("   ", []),
        ("notes:private", []),
        ("café\x00", []),
    ],
)
def test_parameterized_search(store: Store, query: str, want: list[str]) -> None:
    # Interpreting user syntax as SQL/FTS operators would leak extra results or raise.
    with store.transaction() as connection:
        seed_note(connection)
    assert [note.id for note in store.search_notes(query)] == want
    assert [note.id for note in store.list_notes()] == ["saved"]


def test_search_tracks_note_updates_and_deletions(store: Store) -> None:
    with store.transaction() as connection:
        seed_note(connection)
        connection.execute(
            "UPDATE notes SET title=?,body=? WHERE id=?", ("new", "replaced", "saved")
        )
    assert store.search_notes("café") == []
    assert [note.id for note in store.search_notes("replaced")] == ["saved"]
    with store.transaction() as connection:
        connection.execute("DELETE FROM notes WHERE id=?", ("saved",))
    assert store.search_notes("replaced") == []


def test_transaction_rolls_back_note_and_status(store: Store) -> None:
    with pytest.raises(RuntimeError, match="injected"), store.transaction() as connection:
        seed_note(connection)
        seed_task(connection, "task", NOW)
        raise RuntimeError("injected pre-commit failure")
    assert store.list_notes() == []
    with store.transaction() as connection:
        assert connection.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0


def test_retention_boundaries(store: Store, tmp_path: Path) -> None:
    unrelated = tmp_path / "unrelated.txt"
    unrelated.write_text("keep me")
    with store.transaction() as connection:
        seed_note(connection)
        for task_id, age in [
            ("fresh", timedelta(hours=24) - timedelta(microseconds=1)),
            ("expired", timedelta(hours=24)),
            ("metadata-kept", timedelta(days=30) - timedelta(microseconds=1)),
            ("metadata-expired", timedelta(days=30)),
        ]:
            seed_task(connection, task_id, NOW - age)
    store.cleanup(NOW)
    with store.transaction() as connection:
        rows = connection.execute(
            "SELECT task_id,title,body FROM revisions ORDER BY task_id"
        ).fetchall()
        assert [tuple(row) for row in rows] == [
            ("expired", None, None),
            ("fresh", "draft", "private-marker"),
            ("metadata-kept", None, None),
        ]
        assert [
            tuple(row)
            for row in connection.execute(
                "SELECT task_id,arguments_title,arguments_body FROM approvals ORDER BY task_id"
            )
        ] == [
            ("expired", None, None),
            ("fresh", "draft", "private-marker"),
            ("metadata-kept", None, None),
        ]
        assert connection.execute("SELECT count(*) FROM operations").fetchone()[0] == 3
    assert [note.id for note in store.list_notes()] == ["saved"]
    assert unrelated.read_text() == "keep me"


@pytest.mark.parametrize("status", ["cancelled", "rejected"])
def test_cancelled_draft_bodies_removed_immediately(store: Store, status: str) -> None:
    with store.transaction() as connection:
        seed_note(connection)
        seed_task(connection, "task", NOW)
        connection.execute("UPDATE tasks SET status=? WHERE id=?", (status, "task"))
        assert tuple(connection.execute("SELECT title,body FROM revisions").fetchone()) == (
            None,
            None,
        )
        assert tuple(
            connection.execute("SELECT arguments_title,arguments_body FROM approvals").fetchone()
        ) == (None, None)
    assert [note.id for note in store.list_notes()] == ["saved"]


def test_rejected_approval_body_removed_immediately(store: Store) -> None:
    with store.transaction() as connection:
        seed_task(connection, "task", NOW)
        connection.execute("UPDATE approvals SET decision='rejected'")
        assert tuple(connection.execute("SELECT title,body FROM revisions").fetchone()) == (
            None,
            None,
        )
        assert tuple(
            connection.execute("SELECT arguments_title,arguments_body FROM approvals").fetchone()
        ) == (None, None)


def test_startup_cleans_expired_drafts(tmp_path: Path) -> None:
    path = tmp_path / "sage.sqlite3"
    opened = Store.open(path)
    try:
        with opened.transaction() as connection:
            seed_note(connection)
            seed_task(connection, "old", datetime(2000, 1, 1, tzinfo=UTC))
    finally:
        opened.close()
    restarted = Store.open(path)
    try:
        assert [note.id for note in restarted.list_notes()] == ["saved"]
        with restarted.transaction() as connection:
            assert connection.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0
    finally:
        restarted.close()


def test_disk_or_busy_failure_preserves_data(tmp_path: Path) -> None:
    path = tmp_path / "sage.sqlite3"
    opened = Store.open(path)
    competitor = Store.open(path)
    try:
        with opened.transaction() as connection:
            seed_note(connection)
        with opened.transaction() as connection:
            connection.execute("UPDATE notes SET title='locked'")
            started = monotonic()
            with (
                pytest.raises(StorageError, match="transaction"),
                competitor.transaction() as other,
            ):
                other.execute("DELETE FROM notes")
            assert monotonic() - started < 2
        assert competitor.list_notes()[0].title == "locked"
    finally:
        competitor.close()
        opened.close()
    restarted = Store.open(path)
    try:
        assert restarted.list_notes()[0].body == BODY
    finally:
        restarted.close()


def test_commit_io_failure_rolls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class FailingConnection(sqlite3.Connection):
        fail_commit = False

        def commit(self) -> None:
            if self.fail_commit:
                raise sqlite3.OperationalError("injected disk I/O error private-marker")
            super().commit()

    real_connect = sqlite3.connect

    def connect(
        path: Path,
        *,
        timeout: float,
        isolation_level: Literal["DEFERRED", "EXCLUSIVE", "IMMEDIATE"] | None,
    ) -> FailingConnection:
        result = real_connect(
            path, factory=FailingConnection, timeout=timeout, isolation_level=isolation_level
        )
        assert isinstance(result, FailingConnection)
        return result

    monkeypatch.setattr(sqlite3, "connect", connect)
    opened = Store.open(tmp_path / "sage.sqlite3")
    try:
        with opened.transaction() as connection:
            seed_note(connection)
        assert isinstance(connection, FailingConnection)
        failing_connection = connection
        failing_connection.fail_commit = True
        with (
            pytest.raises(StorageError, match="transaction") as error,
            opened.transaction() as connection,
        ):
            connection.execute("DELETE FROM notes")
        assert "private-marker" not in str(error.value)
        failing_connection.fail_commit = False
        assert opened.list_notes()[0].body == BODY
    finally:
        opened.close()


def test_cleanup_requires_timezone(store: Store) -> None:
    with pytest.raises(ValueError, match="timezone"):
        store.cleanup(datetime(2035, 1, 1))


def test_close_is_idempotent(store: Store) -> None:
    store.close()
    store.close()
    with pytest.raises(StorageError):
        store.list_notes()


def test_old_approval_rejection_preserves_new_revision(store: Store) -> None:
    with store.transaction() as connection:
        seed_task(connection, "task", NOW)
        connection.execute(
            "INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)",
            ("new-proposal", "task", 2, "notes.create", "notes", "new title", "new body", STAMP),
        )
        connection.execute("UPDATE approvals SET decision='rejected' WHERE id='a-task'")
        assert tuple(
            connection.execute(
                "SELECT title,body FROM revisions WHERE id='new-proposal'"
            ).fetchone()
        ) == ("new title", "new body")


def test_cleanup_failure_is_atomic(store: Store) -> None:
    with store.transaction() as connection:
        seed_task(connection, "task", NOW - timedelta(days=31))
        connection.execute("""CREATE TRIGGER inject_cleanup_failure BEFORE DELETE ON tasks BEGIN
            SELECT RAISE(ABORT, 'injected disk failure private-marker'); END""")
    with pytest.raises(StorageError) as error:
        store.cleanup(NOW)
    assert "private-marker" not in str(error.value)
    with store.transaction() as connection:
        assert connection.execute("SELECT body FROM revisions").fetchone()[0] == "private-marker"
        assert (
            connection.execute("SELECT arguments_body FROM approvals").fetchone()[0]
            == "private-marker"
        )


def test_nested_transaction_does_not_commit_outer_effects(store: Store) -> None:
    with pytest.raises(StorageError, match="Nested"), store.transaction() as connection:
        seed_note(connection)
        with store.transaction():
            pytest.fail("nested transaction must not yield")
    assert store.list_notes() == []


def test_search_and_transaction_after_close_fail_safely(store: Store) -> None:
    store.close()
    with pytest.raises(StorageError, match="search"):
        store.search_notes("private-marker")
    with pytest.raises(StorageError, match="transaction"), store.transaction():
        pytest.fail("closed transaction must not yield")


def test_record_columns_preserve_contract_values_on_restart(tmp_path: Path) -> None:
    path = tmp_path / "sage.sqlite3"
    opened = Store.open(path)
    try:
        with opened.transaction() as connection:
            seed_task(connection, "task", NOW)
            connection.execute(
                "INSERT INTO settings VALUES(?,?)",
                (1, '{"ai_mode":"local","reasoning_backend":null}'),
            )
    finally:
        opened.close()
    restarted = Store.open(path)
    try:
        with restarted.transaction() as connection:
            assert tuple(connection.execute("SELECT * FROM tasks").fetchone()) == (
                "task",
                "review",
                STAMP,
                STAMP,
            )
            assert tuple(connection.execute("SELECT * FROM revisions").fetchone()) == (
                "p-task",
                "task",
                1,
                "notes.create",
                "notes",
                "draft",
                "private-marker",
                STAMP,
            )
            assert tuple(connection.execute("SELECT * FROM approvals").fetchone()) == (
                "a-task",
                "task",
                "p-task",
                "notes.create",
                "draft",
                "private-marker",
                "a" * 64,
                1,
                "notes",
                "1",
                STAMP,
                STAMP,
                "pending",
                "boot",
                None,
            )
            assert tuple(connection.execute("SELECT * FROM operations").fetchone()) == (
                "o-task",
                "task",
                "p-task",
                "a-task",
                "failed",
                None,
                "safe diagnostic",
                STAMP,
                STAMP,
            )
            assert connection.execute("SELECT data_json FROM settings").fetchone()[0] == (
                '{"ai_mode":"local","reasoning_backend":null}'
            )
    finally:
        restarted.close()
