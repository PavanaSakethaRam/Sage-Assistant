"""Exact authorization decisions must precede every local note effect."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from sage.actions import ActionService
from sage.storage import Store

NOW = datetime(2035, 1, 2, 12, tzinfo=UTC)


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def state(tmp_path: Path) -> Iterator[tuple[Store, Clock, ActionService]]:
    store = Store.open(tmp_path / "notes.sqlite")
    clock = Clock()
    try:
        yield store, clock, ActionService(store, clock, "boot-1")
    finally:
        store.close()


def no_effects(store: Store, statements: list[str]) -> None:
    assert store.list_notes() == []
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM operations").fetchone()[0] == 0
    assert not any(sql.startswith("INSERT INTO notes") for sql in statements)


def trace(store: Store) -> list[str]:
    statements: list[str] = []
    store._connection.set_trace_callback(statements.append)
    return statements


def test_denied_or_changed_request_has_zero_effects(
    state: tuple[Store, Clock, ActionService],
) -> None:
    store, _, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    statements = trace(store)
    assert actions.decide(proposal.id, proposal.revision, "cancel").status == "cancelled"
    assert actions.decide(proposal.id, proposal.revision, "save").status == "cancelled"
    no_effects(store, statements)
    with store.transaction() as db:
        assert tuple(db.execute("SELECT title,body FROM revisions").fetchone()) == (None, None)
        assert tuple(
            db.execute("SELECT arguments_title,arguments_body FROM approvals").fetchone()
        ) == (None, None)
    with pytest.raises(ValueError):
        actions.propose_note("task-1", "Late", "Late provider output")


@pytest.mark.parametrize(
    "table,column,value",
    [
        ("revisions", "title", "Changed"),
        ("revisions", "body", "Changed"),
        ("approvals", "arguments_title", "Changed"),
        ("approvals", "arguments_body", "Changed"),
        ("approvals", "arguments_hash", "0" * 64),
        ("approvals", "task_id", "other"),
        ("approvals", "policy_version", "forged"),
        ("approvals", "boot_id", "forged"),
        ("approvals", "decision", "approved"),
        ("approvals", "consumed_at", "2035-01-02T12:00:00.000000+00:00"),
        ("approvals", "issued_at", "2035-01-02T11:59:59.000000+00:00"),
        ("approvals", "expires_at", "2035-01-02T12:06:00.000000+00:00"),
    ],
)
def test_expired_replayed_or_forged_approval(
    state: tuple[Store, Clock, ActionService], table: str, column: str, value: str
) -> None:
    store, _, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO tasks VALUES ('other','pending',?,?)",
            (NOW.isoformat(timespec="microseconds"),) * 2,
        )
        db.execute(f"UPDATE {table} SET {column}=?", (value,))
    statements = trace(store)
    assert actions.decide(proposal.id, proposal.revision, "save").status == "rejected"
    no_effects(store, statements)


def test_expiry_boundary_and_lease(state: tuple[Store, Clock, ActionService]) -> None:
    store, clock, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    with store.transaction() as db:
        row = db.execute("SELECT issued_at,expires_at FROM approvals").fetchone()
        assert db.execute("SELECT arguments_hash FROM approvals").fetchone()[0] == (
            "da2b36b51e9d73c93dd952628f7b2f579c247afe21b7c0fc3153b9d82306132b"
        )
        assert tuple(row) == (
            "2035-01-02T12:00:00.000000+00:00",
            "2035-01-02T12:05:00.000000+00:00",
        )
    clock.now += timedelta(minutes=5)
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    no_effects(store, statements)
    renewed = actions.revise_note(proposal.id, 1, "Title", "Body")
    clock.now += timedelta(minutes=5, microseconds=-1)
    assert actions.decide(renewed.id, 2, "save").status == "succeeded"


def test_clock_rollback_and_restart_expire(state: tuple[Store, Clock, ActionService]) -> None:
    store, clock, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    clock.now += timedelta(minutes=1)
    actions.propose_note("task-2", "Another", "Body")
    clock.now -= timedelta(seconds=1)
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    clock.now += timedelta(seconds=1)
    assert ActionService(store, clock, "boot-1").decide(proposal.id, 1, "save").status == "rejected"
    fresh = actions.revise_note(proposal.id, 1, "Title", "Body")
    restarted = ActionService(store, clock, "boot-2")
    assert restarted.decide(fresh.id, 2, "save").status == "rejected"
    no_effects(store, statements)
    reviewed = restarted.revise_note(fresh.id, 2, "Title", "Body")
    assert restarted.decide(reviewed.id, 3, "save").status == "succeeded"


def test_edit_invalidates_old_identity(state: tuple[Store, Clock, ActionService]) -> None:
    store, _, actions = state
    old = actions.propose_note("task-1", "Title", "Body")
    current = actions.revise_note(old.id, 1, "Edited", "  e\u0301\r\n\t$(literal)  ")
    assert current.id != old.id
    assert current.revision == 2
    statements = trace(store)
    for identity, revision in [(old.id, 1), (old.id, 2), (current.id, 1), ("forged", 2)]:
        assert actions.decide(identity, revision, "save").status == "rejected"
    no_effects(store, statements)
    result = actions.decide(current.id, 2, "save")
    assert result.status == "succeeded"
    assert store.list_notes()[0].body == "  e\u0301\r\n\t$(literal)  "
    with pytest.raises(ValueError):
        actions.revise_note(old.id, 1, "Late", "Body")


def test_duplicate_save_returns_same_note(state: tuple[Store, Clock, ActionService]) -> None:
    store, clock, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    first = actions.decide(proposal.id, 1, "save")
    clock.now += timedelta(days=1)
    assert actions.decide(proposal.id, 1, "save") == first
    assert ActionService(store, clock, "boot-2").decide(proposal.id, 1, "save") == first
    assert actions.cancel_task("task-1") == first
    assert actions.decide(proposal.id, 1, "cancel") == first
    assert len(store.list_notes()) == 1
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM operations").fetchone()[0] == 1
        db.execute("UPDATE approvals SET arguments_hash=?", ("0" * 64,))
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    assert len(store.list_notes()) == 1


def test_cancel_before_commit(state: tuple[Store, Clock, ActionService]) -> None:
    store, _, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    assert actions.cancel_task("task-1").status == "cancelled"
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "cancelled"
    no_effects(store, statements)
    with pytest.raises(ValueError):
        actions.revise_note(proposal.id, 1, "New", "Body")
    assert actions.cancel_task("unknown").status == "rejected"


@pytest.mark.parametrize(
    "title,body", [("", "Body"), ("Title", "\x00private"), ("T" * 201, "Body")]
)
def test_invalid_content_creates_no_authority(
    state: tuple[Store, Clock, ActionService], title: str, body: str
) -> None:
    store, _, actions = state
    with pytest.raises(ValueError):
        actions.propose_note("task-1", title, body)
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0
    assert store.list_notes() == []


def test_unresolved_operation_cannot_be_reexecuted(
    state: tuple[Store, Clock, ActionService],
) -> None:
    store, _, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    with store.transaction() as db:
        approval_id = db.execute("SELECT id FROM approvals").fetchone()[0]
        db.execute(
            "INSERT INTO operations (id,task_id,proposal_id,approval_id,status,"
            "created_at,updated_at) "
            "VALUES ('unresolved','task-1',?,?,'pending',?,?)",
            (
                proposal.id,
                approval_id,
                NOW.isoformat(timespec="microseconds"),
                NOW.isoformat(timespec="microseconds"),
            ),
        )
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    assert store.list_notes() == []
    assert not any(sql.startswith("INSERT INTO notes") for sql in statements)
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM operations").fetchone()[0] == 1


@pytest.mark.parametrize(
    "table,column,value",
    [
        ("revisions", "scope", "shell"),
        ("revisions", "tool", "shell.run"),
        ("approvals", "scope", "shell"),
        ("approvals", "tool", "shell.run"),
        ("approvals", "issued_at", "invalid"),
        ("approvals", "expires_at", "2035-01-02T12:05:00"),
        ("approvals", "arguments_hash", "invalid"),
    ],
)
def test_corrupt_stored_contract_has_zero_effects(
    state: tuple[Store, Clock, ActionService], table: str, column: str, value: str
) -> None:
    store, _, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    with store.transaction() as db:
        db.execute("PRAGMA ignore_check_constraints=ON")
        db.execute(f"UPDATE {table} SET {column}=?", (value,))
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    no_effects(store, statements)


def test_multiple_or_missing_approval_has_zero_effects(
    state: tuple[Store, Clock, ActionService],
) -> None:
    store, _, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO approvals SELECT 'forged',task_id,proposal_id,tool,arguments_title,"
            "arguments_body,arguments_hash,revision,scope,policy_version,issued_at,expires_at,"
            "decision,boot_id,consumed_at FROM approvals"
        )
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    with store.transaction() as db:
        db.execute("DELETE FROM approvals")
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    no_effects(store, statements)


def test_completed_operation_binding_precedes_recovery(
    state: tuple[Store, Clock, ActionService],
) -> None:
    store, _, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    assert actions.decide(proposal.id, 1, "save").status == "succeeded"
    with store.transaction() as db:
        db.execute("UPDATE notes SET title='Changed'")
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    assert not any(sql.startswith("INSERT INTO notes") for sql in statements)
    assert len(store.list_notes()) == 1


def test_scrubbed_draft_cannot_be_recovered(state: tuple[Store, Clock, ActionService]) -> None:
    store, clock, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    clock.now += timedelta(hours=24)
    store.cleanup(clock.now)
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    with pytest.raises(ValueError):
        actions.revise_note(proposal.id, 1, "Recovered", "Body")
    no_effects(store, statements)


def test_review_request_has_no_approval_object_entrypoint(
    state: tuple[Store, Clock, ActionService],
) -> None:
    store, clock, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    statements = trace(store)
    assert actions.decide(proposal.id, True, "save").status == "rejected"
    assert actions.decide("", 1, "save").status == "rejected"
    assert actions.decide(proposal.id, 1, "approve").status == "rejected"  # type: ignore[arg-type]
    assert actions.decide(proposal, 1, "save").status == "rejected"  # type: ignore[arg-type]
    assert actions.cancel_task("").status == "rejected"
    with pytest.raises(ValueError):
        actions.revise_note(proposal.id, True, "Title", "Body")
    with pytest.raises(ValueError):
        actions.propose_note("", "Title", "Body")
    with pytest.raises(ValueError):
        ActionService(store, clock, "")
    clock.now = datetime(2035, 1, 2, 12)
    with pytest.raises(ValueError):
        actions.decide(proposal.id, 1, "save")
    no_effects(store, statements)


def test_retention_scrubs_transients_but_recovers_committed_outcome(
    state: tuple[Store, Clock, ActionService],
) -> None:
    store, clock, actions = state
    proposal = actions.propose_note("task-1", " Exact e\u0301 ", "Body\r\n\t")
    saved = actions.decide(proposal.id, 1, "save")
    clock.now += timedelta(hours=24)
    store.cleanup(clock.now)
    with store.transaction() as db:
        assert db.execute("SELECT body FROM revisions").fetchone()[0] is None
        assert db.execute("SELECT arguments_body FROM approvals").fetchone()[0] is None
    restarted = ActionService(store, clock, "boot-2")
    statements = trace(store)
    assert restarted.decide(proposal.id, 1, "save") == saved
    assert restarted.cancel_task("task-1") == saved
    assert not any(sql.startswith("INSERT INTO notes") for sql in statements)
    with store.transaction() as db:
        db.execute("UPDATE approvals SET arguments_hash=?", ("0" * 64,))
    assert restarted.decide(proposal.id, 1, "save").status == "rejected"
    assert len(store.list_notes()) == 1


@pytest.mark.parametrize("column,value", [("status", "interrupted"), ("revision", 2)])
def test_retained_stale_state_cannot_execute(
    state: tuple[Store, Clock, ActionService], column: str, value: str | int
) -> None:
    store, _, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    with store.transaction() as db:
        if column == "status":
            db.execute("UPDATE tasks SET status=?", (value,))
        else:
            db.execute(
                "INSERT INTO revisions SELECT 'newer',task_id,2,tool,scope,title,body,created_at "
                "FROM revisions"
            )
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    no_effects(store, statements)


@pytest.mark.parametrize(
    "table,column,value",
    [
        ("revisions", "title", "Changed"),
        ("approvals", "arguments_body", "Changed"),
        ("approvals", "consumed_at", "invalid"),
        ("approvals", "consumed_at", None),
        ("approvals", "consumed_at", "2035-01-02T12:06:00.000000+00:00"),
        ("approvals", "boot_id", ""),
        ("approvals", "policy_version", "forged"),
        ("revisions", "scope", "shell"),
        ("approvals", "tool", "shell.run"),
        ("operations", "status", "pending"),
    ],
)
def test_completed_tamper_cannot_claim_success(
    state: tuple[Store, Clock, ActionService], table: str, column: str, value: str | None
) -> None:
    store, _, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    assert actions.decide(proposal.id, 1, "save").status == "succeeded"
    with store.transaction() as db:
        db.execute("PRAGMA ignore_check_constraints=ON")
        db.execute(f"UPDATE {table} SET {column}=?", (value,))
    statements = trace(store)
    assert actions.decide(proposal.id, 1, "save").status == "rejected"
    assert actions.cancel_task("task-1").status == "rejected"
    assert len(store.list_notes()) == 1
    assert not any(sql.startswith("INSERT INTO notes") for sql in statements)


@pytest.mark.parametrize("invalid_call", ["propose", "revise"])
def test_clock_anomaly_in_rejected_edit_stays_expired(
    state: tuple[Store, Clock, ActionService], invalid_call: str
) -> None:
    store, clock, actions = state
    proposal = actions.propose_note("task-1", "Title", "Body")
    clock.now += timedelta(minutes=1)
    actions.propose_note("task-2", "Title", "Body")
    clock.now -= timedelta(seconds=1)
    with pytest.raises(ValueError):
        if invalid_call == "propose":
            actions.propose_note("task-2", "Title", "Body")
        else:
            actions.revise_note("missing", 1, "Title", "Body")
    clock.now += timedelta(seconds=1)
    restarted = ActionService(store, clock, "boot-1")
    statements = trace(store)
    assert restarted.decide(proposal.id, 1, "save").status == "rejected"
    no_effects(store, statements)


def test_shared_clock_revokes_coding_even_after_failed_transaction_and_catchup(
    state: tuple[Store, Clock, ActionService],
) -> None:
    import sqlite3

    from sage.coding_jobs import CodingError, CodingJobs
    from tests.integration.test_coding_jobs import approved, intent, receipt

    store, clock, actions = state
    jobs = CodingJobs(store, "boot-1", actions.observe_clock)
    grant, proposal = approved(jobs)
    request = intent(grant, proposal)
    jobs.begin(request)
    jobs.observe(receipt(request))
    clock.now += timedelta(seconds=1)
    actions.observe_clock()
    clock.now -= timedelta(microseconds=1)

    def deny_revoke(
        action: int,
        table: str | None,
        column: str | None,
        database: str | None,
        trigger: str | None,
    ) -> int:
        return (
            sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_UPDATE and table == "coding_grants"
            else sqlite3.SQLITE_OK
        )

    store._connection.set_authorizer(deny_revoke)
    with pytest.raises(CodingError):
        jobs.begin(intent(grant, proposal, 1))
    store._connection.set_authorizer(None)
    clock.now += timedelta(microseconds=1)
    with pytest.raises(CodingError):
        jobs.begin(intent(grant, proposal, 1))
    recreated = ActionService(store, clock, "boot-1")
    recreated.observe_clock()
    with store.transaction() as db:
        assert db.execute("SELECT revoked FROM coding_grants").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 1
