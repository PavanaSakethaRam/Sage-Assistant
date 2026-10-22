"""Trusted note review leases and atomic local effects; no provider executes here."""

import hashlib
import json
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import uuid4

from pydantic import ValidationError

from sage.contracts import ActionProposal, ActionResult, Approval, NoteContent
from sage.storage import StorageError, Store

_POLICY = "notes-v1"
_LEASE = timedelta(minutes=5)


def _stamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def _hash(content: NoteContent) -> str:
    canonical = json.dumps(
        content.model_dump(), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _identity(proposal_id: str, revision: int) -> bool:
    return (
        type(proposal_id) is str and bool(proposal_id) and type(revision) is int and revision >= 1
    )


def _proposal(row: sqlite3.Row) -> ActionProposal:
    return ActionProposal(
        id=row["id"],
        task_id=row["task_id"],
        tool=row["tool"],
        scope=row["scope"],
        revision=row["revision"],
        arguments=NoteContent(title=row["title"], body=row["body"]),
    )


class ActionService:
    """One explicitly owned service per thread, with a trusted process boot identity.

    Only exact proposal/revision decisions enter this interface. Expired leases
    cannot execute; explicit revision can recover a retained draft after restart.
    SQLite's write transaction orders Save and Cancel: the first commit wins.
    """

    def __init__(self, store: Store, clock: Callable[[], datetime], boot_id: str) -> None:
        if type(boot_id) is not str or not boot_id:
            raise ValueError("A trusted boot identity is required")
        self._store = store
        self._clock = clock
        self._boot_id = boot_id
        self._latest: datetime | None = None

    def _now(self, db: sqlite3.Connection) -> datetime:
        now = self._clock()
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("Actions require a timezone-aware clock")
        now = now.astimezone(UTC)
        if self._latest is not None and now < self._latest:
            # Persist invalidation, so catching up or recreating the service cannot
            # restore a lease. Do not reject/scrub recoverable preview content.
            db.execute(
                "UPDATE approvals SET expires_at=issued_at WHERE boot_id=? AND consumed_at IS NULL",
                (self._boot_id,),
            )
        self._latest = max(now, self._latest) if self._latest is not None else now
        return now

    def _create(
        self,
        db: sqlite3.Connection,
        task_id: str,
        revision: int,
        content: NoteContent,
        now: datetime,
    ) -> ActionProposal:
        proposal = ActionProposal(
            id=uuid4().hex, task_id=task_id, arguments=content, revision=revision
        )
        approval = Approval(
            id=uuid4().hex,
            task_id=task_id,
            proposal_id=proposal.id,
            arguments=content,
            arguments_hash=_hash(content),
            revision=revision,
            policy_version=_POLICY,
            issued_at=now,
            expires_at=now + _LEASE,
            decision="pending",
            boot_id=self._boot_id,
        )
        db.execute(
            "INSERT INTO revisions (id,task_id,revision,tool,scope,title,body,created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                proposal.id,
                task_id,
                revision,
                proposal.tool,
                proposal.scope,
                content.title,
                content.body,
                _stamp(now),
            ),
        )
        db.execute(
            "INSERT INTO approvals (id,task_id,proposal_id,tool,arguments_title,arguments_body,"
            "arguments_hash,revision,scope,policy_version,issued_at,expires_at,decision,boot_id) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                approval.id,
                task_id,
                proposal.id,
                approval.tool,
                content.title,
                content.body,
                approval.arguments_hash,
                revision,
                approval.scope,
                _POLICY,
                _stamp(now),
                _stamp(approval.expires_at),
                "pending",
                self._boot_id,
            ),
        )
        db.execute("UPDATE tasks SET updated_at=? WHERE id=?", (_stamp(now), task_id))
        return proposal

    def propose_note(self, task_id: str, title: str, body: str) -> ActionProposal:
        content = NoteContent(title=title, body=body)
        if type(task_id) is not str or not task_id:
            raise ValueError("A task identity is required")
        with self._store.transaction() as db:
            now = self._now(db)
            task = db.execute("SELECT id FROM tasks WHERE id=?", (task_id,)).fetchone()
            proposal = None
            if task is None:
                db.execute(
                    "INSERT INTO tasks (id,status,created_at,updated_at) VALUES (?,?,?,?)",
                    (task_id, "pending", _stamp(now), _stamp(now)),
                )
                proposal = self._create(db, task_id, 1, content, now)
        # Reject after commit so an observed clock rollback remains invalidated.
        if proposal is None:
            raise ValueError("Task already exists; review its current revision")
        return proposal

    def revise_note(self, proposal_id: str, revision: int, title: str, body: str) -> ActionProposal:
        content = NoteContent(title=title, body=body)
        if not _identity(proposal_id, revision):
            raise ValueError("Invalid proposal identity")
        with self._store.transaction() as db:
            now = self._now(db)
            row = db.execute(
                "SELECT * FROM revisions WHERE id=? AND revision=?", (proposal_id, revision)
            ).fetchone()
            proposal = None
            if row is not None and self._current(db, row) and row["body"] is not None:
                # A revision invalidates every old approval, never another revision.
                db.execute(
                    "UPDATE approvals SET decision='rejected' WHERE proposal_id=? AND revision=?",
                    (proposal_id, revision),
                )
                proposal = self._create(db, row["task_id"], revision + 1, content, now)
        if proposal is None:
            raise ValueError("Proposal cannot be revised")
        return proposal

    @staticmethod
    def _current(db: sqlite3.Connection, row: sqlite3.Row) -> bool:
        task = db.execute("SELECT status FROM tasks WHERE id=?", (row["task_id"],)).fetchone()
        latest = db.execute(
            "SELECT max(revision) FROM revisions WHERE task_id=?", (row["task_id"],)
        ).fetchone()[0]
        return task is not None and task["status"] == "pending" and latest == row["revision"]

    @staticmethod
    def _bound(proposal: ActionProposal, row: sqlite3.Row) -> Approval | None:
        try:
            approval = Approval(
                id=row["id"],
                task_id=row["task_id"],
                proposal_id=row["proposal_id"],
                tool=row["tool"],
                arguments=NoteContent(title=row["arguments_title"], body=row["arguments_body"]),
                arguments_hash=row["arguments_hash"],
                revision=row["revision"],
                scope=row["scope"],
                policy_version=row["policy_version"],
                issued_at=datetime.fromisoformat(row["issued_at"]),
                expires_at=datetime.fromisoformat(row["expires_at"]),
                decision=row["decision"],
                boot_id=row["boot_id"],
            )
        except (ValueError, ValidationError):
            return None
        if (
            approval.task_id != proposal.task_id
            or approval.proposal_id != proposal.id
            or approval.revision != proposal.revision
            or approval.tool != proposal.tool
            or approval.scope != proposal.scope
            or approval.arguments != proposal.arguments
            or approval.arguments_hash != _hash(proposal.arguments)
            or approval.policy_version != _POLICY
        ):
            return None
        return approval

    @staticmethod
    def _completed(
        db: sqlite3.Connection, proposal: sqlite3.Row, approval: sqlite3.Row
    ) -> ActionResult | None:
        """Read committed evidence; scrubbed arguments never regain execution authority."""
        operations = db.execute(
            "SELECT * FROM operations WHERE proposal_id=?", (proposal["id"],)
        ).fetchall()
        if len(operations) != 1:
            return None
        operation = operations[0]
        note = db.execute("SELECT * FROM notes WHERE id=?", (operation["note_id"],)).fetchone()
        task = db.execute("SELECT status FROM tasks WHERE id=?", (proposal["task_id"],)).fetchone()
        if (
            note is None
            or task["status"] != "succeeded"
            or operation["status"] != "succeeded"
            or operation["approval_id"] != approval["id"]
            or not approval["id"]
            or approval["decision"] != "approved"
            or not approval["boot_id"]
            or approval["policy_version"] != _POLICY
            or approval["proposal_id"] != proposal["id"]
            or approval["revision"] != proposal["revision"]
            or any(
                record["task_id"] != proposal["task_id"] for record in (approval, operation, note)
            )
            or any(
                record["tool"] != "notes.create" or record["scope"] != "notes"
                for record in (proposal, approval)
            )
        ):
            return None
        try:
            content = NoteContent(title=note["title"], body=note["body"])
            issued = datetime.fromisoformat(approval["issued_at"])
            expires = datetime.fromisoformat(approval["expires_at"])
            consumed = datetime.fromisoformat(approval["consumed_at"])
            if (
                any(value.utcoffset() is None for value in (issued, expires, consumed))
                or expires - issued != _LEASE
                or not issued <= consumed < expires
                or approval["arguments_hash"] != _hash(content)
            ):
                return None
            # Retained copies must still match literally. Fully scrubbed copies
            # can prove a committed outcome through the saved note and hash only.
            for title, body in (
                (proposal["title"], proposal["body"]),
                (approval["arguments_title"], approval["arguments_body"]),
            ):
                if (title, body) != (None, None) and (title, body) != (content.title, content.body):
                    return None
            return ActionResult(
                task_id=proposal["task_id"],
                operation_id=operation["id"],
                status="succeeded",
                note_id=note["id"],
            )
        except (ValueError, TypeError):
            return None

    def decide(
        self, proposal_id: str, revision: int, decision: Literal["save", "cancel"]
    ) -> ActionResult:
        if not _identity(proposal_id, revision) or decision not in ("save", "cancel"):
            return ActionResult(status="rejected", diagnostic="Invalid review request")
        try:
            with self._store.transaction() as db:
                now = self._now(db)
                return self._decide(db, proposal_id, revision, decision, now)
        except StorageError:
            return ActionResult(status="failed", diagnostic="Could not save review decision")

    def _decide(
        self,
        db: sqlite3.Connection,
        proposal_id: str,
        revision: int,
        decision: Literal["save", "cancel"],
        now: datetime,
    ) -> ActionResult:
        row = db.execute(
            "SELECT * FROM revisions WHERE id=? AND revision=?", (proposal_id, revision)
        ).fetchone()
        rejected = ActionResult(status="rejected", diagnostic="Review is no longer valid")
        if row is None:
            return rejected
        task = db.execute("SELECT status FROM tasks WHERE id=?", (row["task_id"],)).fetchone()
        if task["status"] == "cancelled":
            return ActionResult(task_id=row["task_id"], status="cancelled")
        approvals = db.execute(
            "SELECT * FROM approvals WHERE proposal_id=? AND revision=?", (proposal_id, revision)
        ).fetchall()
        if len(approvals) != 1:
            return rejected
        stored = approvals[0]
        # Binding validation precedes duplicate recovery, including after cleanup.
        completed = self._completed(db, row, stored)
        if completed is not None:
            return completed
        if db.execute("SELECT 1 FROM operations WHERE proposal_id=?", (proposal_id,)).fetchone():
            return rejected
        try:
            proposal = _proposal(row)
        except ValidationError:
            return rejected
        approval = self._bound(proposal, stored)
        if approval is None:
            return rejected
        if not self._current(db, row):
            return rejected
        if decision == "cancel":
            return self._cancel(db, proposal.task_id, now)
        if (
            approval.decision != "pending"
            or stored["consumed_at"] is not None
            or approval.boot_id != self._boot_id
            or approval.expires_at - approval.issued_at != _LEASE
            or not approval.issued_at <= now < approval.expires_at
        ):
            return rejected
        # No independent executor boundary: these three writes share the commit.
        note_id, operation_id = uuid4().hex, uuid4().hex
        stamp = _stamp(now)
        db.execute(
            "INSERT INTO notes (id,title,body,created_at,updated_at,task_id) VALUES (?,?,?,?,?,?)",
            (
                note_id,
                proposal.arguments.title,
                proposal.arguments.body,
                stamp,
                stamp,
                proposal.task_id,
            ),
        )
        db.execute(
            "UPDATE approvals SET decision='approved',consumed_at=? WHERE id=?",
            (stamp, approval.id),
        )
        db.execute(
            "INSERT INTO operations (id,task_id,proposal_id,approval_id,status,note_id,"
            "created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                operation_id,
                proposal.task_id,
                proposal.id,
                approval.id,
                "succeeded",
                note_id,
                stamp,
                stamp,
            ),
        )
        db.execute(
            "UPDATE tasks SET status='succeeded',updated_at=? WHERE id=?", (stamp, proposal.task_id)
        )
        return ActionResult(
            task_id=proposal.task_id, operation_id=operation_id, status="succeeded", note_id=note_id
        )

    @staticmethod
    def _cancel(db: sqlite3.Connection, task_id: str, now: datetime) -> ActionResult:
        db.execute(
            "UPDATE tasks SET status='cancelled',updated_at=? WHERE id=?", (_stamp(now), task_id)
        )
        db.execute(
            "UPDATE approvals SET decision='rejected' WHERE task_id=? AND consumed_at IS NULL",
            (task_id,),
        )
        return ActionResult(task_id=task_id, status="cancelled")

    def cancel_task(self, task_id: str) -> ActionResult:
        if type(task_id) is not str or not task_id:
            return ActionResult(status="rejected")
        try:
            with self._store.transaction() as db:
                now = self._now(db)
                task = db.execute("SELECT status FROM tasks WHERE id=?", (task_id,)).fetchone()
                if task is None:
                    return ActionResult(status="rejected")
                if task["status"] == "succeeded":
                    row = db.execute(
                        "SELECT id,revision FROM revisions WHERE task_id=? "
                        "ORDER BY revision DESC LIMIT 1",
                        (task_id,),
                    ).fetchone()
                    return self._decide(db, row["id"], row["revision"], "cancel", now)
                return self._cancel(db, task_id, now)
        except StorageError:
            return ActionResult(status="failed", diagnostic="Could not cancel task")

    def get_outcome(self, task_id: str) -> ActionResult | None:
        """Read validated committed evidence without attempting a new effect."""
        with self._store.transaction() as db:
            proposal = db.execute(
                "SELECT * FROM revisions WHERE task_id=? ORDER BY revision DESC LIMIT 1",
                (task_id,),
            ).fetchone()
            if proposal is None:
                return None
            approvals = db.execute(
                "SELECT * FROM approvals WHERE proposal_id=? AND revision=?",
                (proposal["id"], proposal["revision"]),
            ).fetchall()
            if len(approvals) != 1:
                return None
            return self._completed(db, proposal, approvals[0])
