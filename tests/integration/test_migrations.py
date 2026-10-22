"""Schema upgrades are atomic and never reset an existing database."""

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from sage import storage
from sage.storage import SchemaVersionError, StorageError, Store

TITLE = "  e\u0301 😀 'title'  "
BODY = "\t# literal\r\n  preserved  "
STAMP = "2035-01-02T12:00:00.000000+00:00"


def existing_database(path: Path) -> None:
    opened = Store.open(path)
    try:
        with opened.transaction() as connection:
            connection.execute(
                "INSERT INTO notes VALUES(?,?,?,?,?,?)",
                ("saved", TITLE, BODY, STAMP, STAMP, "task"),
            )
    finally:
        opened.close()


def snapshot(path: Path) -> tuple[int, list[tuple[object, ...]]]:
    with closing(sqlite3.connect(path)) as connection:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        notes = connection.execute("SELECT * FROM notes").fetchall()
    return version, notes


def test_migration_preserves_notes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "sage.sqlite3"
    existing_database(path)
    original = snapshot(path)
    monkeypatch.setattr(
        storage,
        "_migration_scripts",
        lambda: (
            storage.INITIAL_MIGRATION.read_text(encoding="utf-8"),
            "CREATE TABLE upgrade_marker (id INTEGER);\nINSERT INTO upgrade_marker VALUES(42);",
        ),
    )
    upgraded = Store.open(path)
    try:
        assert upgraded.list_notes()[0].title == TITLE
        assert upgraded.list_notes()[0].body == BODY
        assert snapshot(path) == (2, original[1])
        with upgraded.transaction() as connection:
            assert connection.execute("SELECT id FROM upgrade_marker").fetchone()[0] == 42
    finally:
        upgraded.close()


def test_future_schema_refused_without_reset(tmp_path: Path) -> None:
    path = tmp_path / "sage.sqlite3"
    existing_database(path)
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("PRAGMA user_version=999")
    original = snapshot(path)
    with pytest.raises(SchemaVersionError, match="newer"):
        Store.open(path)
    assert snapshot(path) == original


def test_failed_migration_rolls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "sage.sqlite3"
    existing_database(path)
    original = snapshot(path)
    monkeypatch.setattr(
        storage,
        "_migration_scripts",
        lambda: (
            storage.INITIAL_MIGRATION.read_text(encoding="utf-8"),
            "CREATE TABLE partial_upgrade (id INTEGER);\nDELETE FROM notes;\nINVALID SQL;",
        ),
    )
    with pytest.raises(StorageError, match="migration"):
        Store.open(path)
    assert snapshot(path) == original
    with closing(sqlite3.connect(path)) as connection:
        assert (
            connection.execute(
                "SELECT name FROM sqlite_master WHERE name='partial_upgrade'"
            ).fetchall()
            == []
        )


def test_open_failure_has_safe_diagnostic(tmp_path: Path) -> None:
    with pytest.raises(StorageError, match="open"):
        Store.open(tmp_path)  # A directory cannot be used as a database.
