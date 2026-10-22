"""Explicitly owned SQLite state; transactions confer no action authority.

Trusted writers use validated contracts, parameterized SQL and UTC timestamps
encoded with ``datetime.astimezone(UTC).isoformat(timespec="microseconds")``.
Draft columns become NULL on retention cleanup; those rows are metadata only.
"""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from importlib.resources import files
from pathlib import Path

from sage.contracts import Note

INITIAL_MIGRATION = files("sage").joinpath("migrations/001.sql")
_BUSY_TIMEOUT_SECONDS = 0.25


class StorageError(RuntimeError):
    """A safe storage diagnostic without SQL, note content or filesystem paths."""


class SchemaVersionError(StorageError):
    """The database requires a newer application; its contents remain untouched."""


def _migration_scripts() -> tuple[str, ...]:
    return (INITIAL_MIGRATION.read_text(encoding="utf-8"),)


def _execute_script(connection: sqlite3.Connection, script: str) -> None:
    # executescript() implicitly commits, so execute complete statements ourselves.
    statement = ""
    for character in script:
        statement += character
        if character == ";" and sqlite3.complete_statement(statement):
            connection.execute(statement)
            statement = ""
    if statement.strip():
        connection.execute(statement)


def _note(row: sqlite3.Row) -> Note:
    return Note(
        id=row["id"],
        title=row["title"],
        body=row["body"],
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
        task_id=row["task_id"],
    )


class Store:
    """Own one thread-confined connection; callers must explicitly close it."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def open(cls, path: Path) -> "Store":
        """Create/migrate state and run retention only at explicit startup."""
        connection: sqlite3.Connection | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(path, timeout=_BUSY_TIMEOUT_SECONDS, isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            store = cls(connection)
            store._migrate()
            store.cleanup(datetime.now(UTC))
            return store
        except BaseException as error:
            if connection is not None:
                connection.close()
            if isinstance(error, (sqlite3.Error, OSError)):
                raise StorageError("Could not open application storage") from None
            raise

    def _migrate(self) -> None:
        try:
            scripts = _migration_scripts()
            with self.transaction() as connection:
                version: int = connection.execute("PRAGMA user_version").fetchone()[0]
                if version > len(scripts):
                    raise SchemaVersionError("Database schema is newer than this application")
                for index in range(version, len(scripts)):
                    _execute_script(connection, scripts[index])
                    # Index comes only from trusted packaged migration enumeration.
                    connection.execute(f"PRAGMA user_version={index + 1}")
        except (sqlite3.Error, OSError, StorageError) as error:
            if isinstance(error, SchemaVersionError):
                raise
            raise StorageError("Application storage migration failed") from None

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Bound lock waits, commit atomically, and roll back failed effects."""
        connection = self._connection
        try:
            if connection.in_transaction:
                raise StorageError("Nested storage transactions are unsupported")
            connection.execute("BEGIN IMMEDIATE")
        except sqlite3.Error:
            raise StorageError("Could not start storage transaction") from None
        try:
            yield connection
            connection.commit()
        except BaseException as error:
            try:
                connection.rollback()
            except sqlite3.Error:
                # A failed rollback makes this connection unsafe to reuse.
                connection.close()
            if isinstance(error, sqlite3.Error):
                raise StorageError("Storage transaction failed") from None
            raise

    def list_notes(self) -> list[Note]:
        """Read saved content without normalization, in stable creation order."""
        try:
            return [
                _note(row)
                for row in self._connection.execute("SELECT * FROM notes ORDER BY created_at, id")
            ]
        except sqlite3.Error:
            raise StorageError("Could not read saved notes") from None

    def search_notes(self, query: str) -> list[Note]:
        """Treat all input as a literal FTS phrase, never SQL/FTS operators."""
        if not query.strip() or "\x00" in query:
            return []
        phrase = '"' + query.replace('"', '""') + '"'
        try:
            return [
                _note(row)
                for row in self._connection.execute(
                    "SELECT notes.* FROM notes JOIN notes_fts ON notes.rowid=notes_fts.rowid "
                    "WHERE notes_fts MATCH ? ORDER BY notes.created_at, notes.id",
                    (phrase,),
                )
            ]
        except sqlite3.Error:
            raise StorageError("Could not search saved notes") from None

    def cleanup(self, now: datetime) -> None:
        """Scrub expired drafts and age metadata; never delete saved notes/files."""
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("Retention cleanup requires a timezone-aware clock")
        clock = now.astimezone(UTC)
        draft_cutoff = (clock - timedelta(hours=24)).isoformat(timespec="microseconds")
        metadata_cutoff = (clock - timedelta(days=30)).isoformat(timespec="microseconds")
        with self.transaction() as connection:
            connection.execute(
                "UPDATE revisions SET title=NULL, body=NULL WHERE created_at<=?", (draft_cutoff,)
            )
            connection.execute(
                "UPDATE approvals SET arguments_title=NULL, arguments_body=NULL "
                "WHERE issued_at<=? OR proposal_id IN "
                "(SELECT id FROM revisions WHERE body IS NULL)",
                (draft_cutoff,),
            )
            connection.execute("DELETE FROM tasks WHERE updated_at<=?", (metadata_cutoff,))

    def close(self) -> None:
        """Release the connection; repeated shutdown is harmless."""
        self._connection.close()

    def get_note(self, note_id: str) -> Note | None:
        with self.transaction() as db:
            row = db.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
            return _note(row) if row is not None else None

    def note_summaries(
        self, limit: int, offset: int, query: str | None = None
    ) -> list[dict[str, object]]:
        """Select bounded metadata only; never load all saved bodies for a page."""
        if type(limit) is not int or not 1 <= limit <= 101 or type(offset) is not int or offset < 0:
            raise ValueError("Invalid page")
        with self.transaction() as db:
            if query is None:
                rows = db.execute(
                    "SELECT id,title,created_at,updated_at,task_id FROM notes "
                    "ORDER BY created_at,id LIMIT ? OFFSET ?",
                    (limit, offset),
                )
            elif not query.strip() or "\x00" in query:
                return []
            else:
                phrase = '"' + query.replace('"', '""') + '"'
                rows = db.execute(
                    "SELECT notes.id,notes.title,notes.created_at,notes.updated_at,notes.task_id "
                    "FROM notes JOIN notes_fts ON notes.rowid=notes_fts.rowid "
                    "WHERE notes_fts MATCH ? ORDER BY notes.created_at,notes.id LIMIT ? OFFSET ?",
                    (phrase, limit, offset),
                )
            return [dict(row) for row in rows]

    def task_summaries(self, limit: int, offset: int) -> list[dict[str, object]]:
        if type(limit) is not int or not 1 <= limit <= 101 or type(offset) is not int or offset < 0:
            raise ValueError("Invalid page")
        with self.transaction() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT id,status,created_at,updated_at FROM tasks ORDER BY created_at,id "
                    "LIMIT ? OFFSET ?",
                    (limit, offset),
                )
            ]

    def task_detail(self, task_id: str) -> dict[str, object] | None:
        """Current retained preview only; approvals never leave the trusted domain."""
        from sage.contracts import ActionProposal, NoteContent

        with self.transaction() as db:
            task = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if task is None:
                return None
            detail: dict[str, object] = dict(task)
            row = db.execute(
                "SELECT * FROM revisions WHERE task_id=? ORDER BY revision DESC LIMIT 1",
                (task_id,),
            ).fetchone()
            detail["proposal"] = None
            detail["review_required"] = False
            if task["status"] == "pending" and row is not None and row["body"] is not None:
                proposal = ActionProposal(
                    id=row["id"],
                    task_id=row["task_id"],
                    revision=row["revision"],
                    tool=row["tool"],
                    scope=row["scope"],
                    arguments=NoteContent(title=row["title"], body=row["body"]),
                )
                detail["proposal"] = proposal.model_dump(mode="json")
                detail["review_required"] = True
            return detail

    def interrupt_inference(self, now: datetime) -> None:
        """Mark only actual in-flight inference; never replay or change note tasks."""
        if now.utcoffset() is None:
            raise ValueError("Aware clock required")
        with self.transaction() as db:
            db.execute(
                "UPDATE tasks SET status='interrupted',updated_at=? WHERE status='reasoning'",
                (now.astimezone(UTC).isoformat(timespec="microseconds"),),
            )
