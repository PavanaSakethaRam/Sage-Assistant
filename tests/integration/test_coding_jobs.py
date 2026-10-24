"""Real durable intent boundaries; a fresh recorded ack is the only effect permission."""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

import pytest

from sage.actions import ActionService
from sage.coding_contracts import (
    CodeContext,
    CodeFileIntent,
    CodeFileReceipt,
    CodeGrant,
    CodeProposal,
    CodeReview,
    CodeStart,
    CodeTestIntent,
    CodeTestReceipt,
    context_hash,
    disclosure_hash,
    literal_hash,
    proposal_hash,
)
from sage.coding_contracts import (
    TestFileHash as CodingTestFileHash,
)
from sage.coding_contracts import TestRecipe as CodingTestRecipe
from sage.coding_jobs import CodingError, CodingJobs
from sage.storage import Store
from tests.helpers.coding_fake import make_context, make_proposal


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2035, 1, 2, 12, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def state(tmp_path: Path) -> Iterator[tuple[Store, Clock, CodingJobs]]:
    store = Store.open(tmp_path / "coding.sqlite")
    clock = Clock()
    actions = ActionService(store, clock, "core-boot")
    jobs = CodingJobs(store, "core-boot", actions.observe_clock)
    try:
        yield store, clock, jobs
    finally:
        store.close()


def context() -> CodeContext:
    value = CodeContext.model_validate(make_context())
    return value.model_copy(update={"context_hash": context_hash(value)})


def disclose(jobs: CodingJobs, captured: CodeContext) -> None:
    jobs.configure_selection(
        backend="copilot", account="test-account", model=None, account_generation=1
    )
    view = jobs.accept_context(captured)
    draft = {
        "job_id": "job-1",
        "revision": 1,
        "account_generation": 1,
        "user_text": "Build tracker",
        "backend": "copilot",
    }
    jobs.begin_proposal(
        CodeStart.model_validate({**draft, "disclosure_hash": disclosure_hash(view, draft)})
    )


def approved(jobs: CodingJobs) -> tuple[CodeGrant, CodeProposal]:
    captured = context()
    disclose(jobs, captured)
    proposal = CodeProposal.model_validate(make_proposal())
    jobs.set_proposal(proposal)
    result = jobs.review(
        CodeReview(
            binding=captured.binding,
            scope="code.create",
            approved_hash=proposal_hash(proposal, captured, "code.create"),
            decision="accept",
        )
    )
    assert result.kind == "grant"
    return result.grant, proposal


def intent(grant: CodeGrant, proposal: CodeProposal, ordinal: int = 0) -> CodeFileIntent:
    file = proposal.files[ordinal]
    return CodeFileIntent(
        binding=grant.binding,
        operation_id=grant.operation_id,
        effect_id=f"effect-{ordinal}",
        scope="code.create",
        ordinal=ordinal,
        expected_hash=literal_hash(file.text),
        target=file.name,
    )


def receipt(value: CodeFileIntent, status: str = "created") -> CodeFileReceipt:
    return CodeFileReceipt.model_validate(
        {
            **value.model_dump(),
            "status": status,
            "observed_hash": value.expected_hash,
            "observed_length": {
                "index.html": 19,
                "focus.js": 27,
                "focus.test.mjs": 34,
                "README.md": 8,
            }[value.target],
        }
    )


def test_ordered_creation_records_exactly_four_effects(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    store, _, jobs = state
    grant, proposal = approved(jobs)
    for ordinal in range(4):
        request = intent(grant, proposal, ordinal)
        assert jobs.begin(request).status == "recorded"
        assert jobs.begin(request).status == "duplicate"
        observation = receipt(request)
        assert jobs.observe(observation).status == "recorded"
        assert jobs.observe(observation).status == "duplicate"
    assert jobs.get(grant.binding.job_id).state == "applied_saved"
    assert jobs.finish(grant.binding.job_id).state == "completed"
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 4
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0


def test_cancel_keeps_inflight_observable_and_records_late_receipt(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, clock, jobs = state
    grant, proposal = approved(jobs)
    first = intent(grant, proposal)
    jobs.begin(first)
    cancelled = jobs.cancel(grant.binding.job_id)
    assert cancelled.state == "applying" and cancelled.cancel_requested
    clock.now += timedelta(minutes=6)
    assert jobs.observe(receipt(first)).status == "recorded"
    assert jobs.get(grant.binding.job_id).state == "partial"
    with pytest.raises(CodingError):
        jobs.begin(intent(grant, proposal, 1))


def test_source_expiry_while_review_open(state: tuple[Store, Clock, CodingJobs]) -> None:
    _, clock, jobs = state
    captured = context()
    disclose(jobs, captured)
    clock.now += timedelta(minutes=30, microseconds=-1)
    jobs.set_proposal(CodeProposal.model_validate(make_proposal()))
    assert jobs.get("job-1").state == "review_required"
    clock.now += timedelta(microseconds=1)
    with pytest.raises(CodingError):
        jobs.review(
            CodeReview(
                binding=captured.binding,
                scope="code.create",
                approved_hash=proposal_hash(
                    CodeProposal.model_validate(make_proposal()), captured, "code.create"
                ),
                decision="accept",
            )
        )
    assert jobs.get("job-1").diagnostic == "expired"


def test_missing_observation_and_restart_never_reauthorize(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    store, clock, jobs = state
    grant, proposal = approved(jobs)
    first = intent(grant, proposal)
    jobs.begin(first)
    restarted = CodingJobs(store, "next-boot", clock)
    restarted.interrupt()
    assert restarted.get("job-1").state == "interrupted"
    with pytest.raises(CodingError):
        restarted.begin(intent(grant, proposal, 1))
    assert restarted.observe(receipt(first)).status == "recorded"
    assert restarted.get("job-1").state == "partial"


def test_partial_and_conflicting_receipts_stop_continuations(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, _, jobs = state
    grant, proposal = approved(jobs)
    first = intent(grant, proposal)
    with pytest.raises(CodingError):
        jobs.begin(intent(grant, proposal, 1))
    jobs.begin(first)
    assert jobs.observe(receipt(first, "partial")).status == "recorded"
    assert jobs.get("job-1").state == "partial"
    assert jobs.observe(receipt(first)).status == "conflict"
    with pytest.raises(CodingError):
        jobs.begin(intent(grant, proposal, 1))


def test_private_markers_absent_from_database_backup_and_receipts(
    state: tuple[Store, Clock, CodingJobs], tmp_path: Path
) -> None:
    store, clock, jobs = state
    captured = context()
    captured = CodeContext.model_validate(
        {**captured.model_dump(mode="json"), "diagnostics": ["PRIVATE_DIAGNOSTIC"]}
    )
    captured = captured.model_copy(update={"context_hash": context_hash(captured)})
    disclose(jobs, captured)
    proposal = CodeProposal.model_validate(
        make_proposal(
            explanation="PRIVATE_EXPLANATION",
            files=[{**file, "text": "PRIVATE_SOURCE"} for file in make_proposal()["files"]],
        )
    )
    jobs.set_proposal(proposal)
    assert "PRIVATE_" not in jobs.get("job-1").model_dump_json()
    with closing(sqlite3.connect(tmp_path / "backup.sqlite")) as backup:
        store._connection.backup(backup)
    assert b"PRIVATE_" not in (tmp_path / "backup.sqlite").read_bytes()
    assert "PRIVATE_" not in json.dumps(list(store._connection.iterdump()))
    clock.now += timedelta(days=30)
    jobs.expire()
    assert jobs.list(20, 0).items == ()


def test_locked_database_and_failed_intent_commit_never_dispatch(
    state: tuple[Store, Clock, CodingJobs], tmp_path: Path
) -> None:
    store, _, jobs = state
    grant, proposal = approved(jobs)
    request = intent(grant, proposal)

    # Deny the actual durable-intent write, after grant consumption in the transaction.
    def deny_effect_insert(
        action: int,
        table: str | None,
        column: str | None,
        database: str | None,
        trigger: str | None,
    ) -> int:
        return (
            sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_INSERT and table == "coding_effects"
            else sqlite3.SQLITE_OK
        )

    store._connection.set_authorizer(deny_effect_insert)
    with pytest.raises(CodingError, match="^storage$"):
        jobs.begin(request)
    store._connection.set_authorizer(None)
    with store.transaction() as db:
        assert db.execute("SELECT consumed_at FROM coding_grants").fetchone()[0] is None
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 0
    with closing(sqlite3.connect(tmp_path / "coding.sqlite", isolation_level=None)) as blocker:
        blocker.execute("BEGIN IMMEDIATE")
        with pytest.raises(CodingError, match="^storage$"):
            jobs.begin(request)
        blocker.rollback()
    assert jobs.begin(request).status == "recorded"


def test_creation_requires_exact_observed_byte_length(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, _, jobs = state
    grant, proposal = approved(jobs)
    request = intent(grant, proposal)
    jobs.begin(request)
    with pytest.raises(CodingError):
        jobs.observe(receipt(request).model_copy(update={"observed_length": 0}))
    assert jobs.get("job-1").receipts == ()


def test_one_active_job_and_fresh_explicit_new_identity(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, _, jobs = state
    captured = context()
    jobs.accept_context(captured)
    other = captured.model_copy(
        update={"binding": captured.binding.model_copy(update={"job_id": "job-2"})}
    )
    other = other.model_copy(update={"context_hash": context_hash(other)})
    with pytest.raises(CodingError):
        jobs.accept_context(other)
    jobs.cancel("job-1")
    assert jobs.accept_context(other).binding.job_id == "job-2"
    assert jobs.list(1, 0).next_offset == 1
    assert len(jobs.list(1, 1).items) == 1


def test_reject_clears_source_and_late_proposal_cannot_reopen(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, _, jobs = state
    captured = context()
    disclose(jobs, captured)
    proposal = CodeProposal.model_validate(make_proposal())
    jobs.set_proposal(proposal)
    result = jobs.review(
        CodeReview(
            binding=captured.binding,
            scope="code.create",
            decision="reject",
            approved_hash=proposal_hash(proposal, captured, "code.create"),
        )
    )
    assert result.kind == "job" and result.job.state == "rejected"
    with pytest.raises(CodingError):
        jobs.set_proposal(proposal)


def saved(jobs: CodingJobs) -> CodeGrant:
    grant, proposal = approved(jobs)
    for ordinal in range(4):
        request = intent(grant, proposal, ordinal)
        jobs.begin(request)
        jobs.observe(receipt(request))
    return grant


def recipe(clock: Clock) -> "CodingTestRecipe":
    from sage.coding_contracts import FOCUS_NAMES, TEST_ARGV, recipe_hash

    value = CodingTestRecipe(
        platform="darwin",
        executable="/owned/node",
        executable_identity="node-id",
        executable_hash="a" * 64,
        executable_version="26.12.1",
        argv=TEST_ARGV,
        cwd="/owned/focus",
        root_id="root-1",
        environment={
            "PATH": "",
            "TEMP": "/owned/PRIVATE_TEMP",
            "TMP": "/owned/PRIVATE_TEMP",
            "TMPDIR": "/owned/PRIVATE_TEMP",
        },
        file_hashes=tuple(
            CodingTestFileHash.model_validate({"name": name, "hash": literal_hash(file["text"])})
            for name, file in zip(FOCUS_NAMES, make_proposal()["files"], strict=True)
        ),
        deadline=clock.now + timedelta(seconds=30),
        output_cap=262144,
        timeout_seconds=30,
        recipe_hash="0" * 64,
    )
    return value.model_copy(update={"recipe_hash": recipe_hash(value)})


@pytest.mark.parametrize("conflicting", [False, True])
def test_test_result_waits_for_done_without_regrant_or_source_persistence(
    state: tuple[Store, Clock, CodingJobs],
    conflicting: bool,
) -> None:
    store, clock, jobs = state
    grant = saved(jobs)
    selected = recipe(clock)
    assert jobs.prepare_test(selected).state == "test_review"
    decision = CodeReview(
        binding=grant.binding,
        scope="code.test",
        approved_hash=selected.recipe_hash,
        decision="accept",
    )
    result = jobs.review(decision)
    assert result.kind == "grant"
    request = CodeTestIntent(
        binding=grant.binding,
        operation_id=result.grant.operation_id,
        effect_id="test-effect",
        ordinal=0,
        scope="code.test",
        expected_hash=selected.recipe_hash,
        recipe=selected,
    )
    assert jobs.begin(request).status == "recorded"
    from hashlib import sha256

    environment_hash = sha256(
        json.dumps(selected.environment, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    observed = CodeTestReceipt(
        binding=grant.binding,
        operation_id=request.operation_id,
        effect_id=request.effect_id,
        ordinal=0,
        scope="code.test",
        expected_hash=request.expected_hash,
        status="passed",
        exit_code=0,
        environment_hash=environment_hash,
        executable_hash=selected.executable_hash,
        executable_version=selected.executable_version,
        cancel_requested=False,
        timeout=False,
        overflow=False,
    )
    assert jobs.observe(observed).status == "recorded"
    assert jobs.get("job-1").state == "test_review"
    with pytest.raises(CodingError):
        jobs.review(decision)
    assert "PRIVATE_TEMP" not in json.dumps(list(store._connection.iterdump()))
    if conflicting:
        assert (
            jobs.observe(observed.model_copy(update={"status": "failed", "exit_code": 1})).status
            == "conflict"
        )
    assert jobs.finish("job-1").state == ("needs_reconciliation" if conflicting else "completed")
    with pytest.raises(CodingError):
        jobs.prepare_test(selected)


def test_recipe_has_five_minute_review_independent_of_thirty_second_runtime(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, clock, jobs = state
    grant = saved(jobs)
    from sage.coding_contracts import recipe_hash

    selected = recipe(clock).model_copy(
        update={"deadline": clock.now + timedelta(minutes=5), "timeout_seconds": 30}
    )
    selected = selected.model_copy(update={"recipe_hash": recipe_hash(selected)})
    jobs.prepare_test(selected)
    clock.now += timedelta(minutes=4)
    result = jobs.review(
        CodeReview(
            binding=grant.binding,
            scope="code.test",
            approved_hash=selected.recipe_hash,
            decision="accept",
        )
    )
    assert result.kind == "grant"
    assert result.grant.expires_at == selected.deadline


def test_review_itself_expires_after_five_minutes(state: tuple[Store, Clock, CodingJobs]) -> None:
    _, clock, jobs = state
    captured = context()
    disclose(jobs, captured)
    proposal = CodeProposal.model_validate(make_proposal())
    jobs.set_proposal(proposal)
    clock.now += timedelta(minutes=5)
    with pytest.raises(CodingError):
        jobs.review(
            CodeReview(
                binding=captured.binding,
                scope="code.create",
                decision="accept",
                approved_hash=proposal_hash(proposal, captured, "code.create"),
            )
        )


@pytest.mark.parametrize("finish_before_receipt", [False, True])
def test_late_passed_test_receipt_is_recordable_after_cancel(
    state: tuple[Store, Clock, CodingJobs],
    finish_before_receipt: bool,
) -> None:
    _, clock, jobs = state
    grant = saved(jobs)
    selected = recipe(clock)
    jobs.prepare_test(selected)
    result = jobs.review(
        CodeReview(
            binding=grant.binding,
            scope="code.test",
            approved_hash=selected.recipe_hash,
            decision="accept",
        )
    )
    assert result.kind == "grant"
    request = CodeTestIntent(
        binding=grant.binding,
        operation_id=result.grant.operation_id,
        effect_id="late-test",
        ordinal=0,
        scope="code.test",
        expected_hash=selected.recipe_hash,
        recipe=selected,
    )
    jobs.begin(request)
    jobs.cancel("job-1")
    if finish_before_receipt:
        jobs.finish("job-1")
        captured = context()
        captured = captured.model_copy(
            update={"binding": captured.binding.model_copy(update={"job_id": "new-job"})}
        )
        captured = captured.model_copy(update={"context_hash": context_hash(captured)})
        jobs.accept_context(captured)
    from hashlib import sha256

    environment_hash = sha256(
        json.dumps(selected.environment, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    observation = CodeTestReceipt(
        binding=grant.binding,
        operation_id=request.operation_id,
        effect_id=request.effect_id,
        ordinal=0,
        scope="code.test",
        expected_hash=request.expected_hash,
        status="passed",
        exit_code=0,
        environment_hash=environment_hash,
        executable_hash=selected.executable_hash,
        executable_version=selected.executable_version,
        cancel_requested=False,
        timeout=False,
        overflow=False,
    )
    assert jobs.observe(observation).status == "recorded"
    assert jobs.get("job-1").cancel_requested
    if finish_before_receipt:
        assert jobs.get("new-job").state == "context_ready"
        assert jobs.get("job-1").state == "completed"


def test_conflicting_completed_observation_requires_reconciliation(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, _, jobs = state
    grant, proposal = approved(jobs)
    request = intent(grant, proposal)
    jobs.begin(request)
    jobs.observe(receipt(request))
    assert jobs.observe(receipt(request, "needs_reconciliation")).status == "conflict"
    assert jobs.get("job-1").state == "needs_reconciliation"


def test_old_late_receipt_and_finish_do_not_clear_new_context(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, _, jobs = state
    grant, proposal = approved(jobs)
    first = intent(grant, proposal)
    jobs.begin(first)
    jobs.cancel("job-1")
    jobs.finish("job-1")
    captured = context()
    captured = captured.model_copy(
        update={"binding": captured.binding.model_copy(update={"job_id": "job-2"})}
    )
    captured = captured.model_copy(update={"context_hash": context_hash(captured)})
    view = jobs.accept_context(captured)
    assert jobs.observe(receipt(first)).status == "recorded"
    jobs.cancel("job-1")
    jobs.finish("job-1")
    draft = {
        "job_id": "job-2",
        "revision": 1,
        "account_generation": 1,
        "user_text": "Fresh",
        "backend": "copilot",
    }
    start = CodeStart.model_validate({**draft, "disclosure_hash": disclosure_hash(view, draft)})
    assert jobs.begin_proposal(start).state == "proposing"


@pytest.mark.parametrize("microseconds,allowed", [(0, False), (-1, True)])
def test_fractional_grant_expiry_boundary(
    state: tuple[Store, Clock, CodingJobs], microseconds: int, allowed: bool
) -> None:
    _, clock, jobs = state
    clock.now += timedelta(microseconds=500000)
    grant, proposal = approved(jobs)
    clock.now = grant.expires_at + timedelta(microseconds=microseconds)
    if allowed:
        assert jobs.begin(intent(grant, proposal)).status == "recorded"
    else:
        with pytest.raises(CodingError):
            jobs.begin(intent(grant, proposal))


def test_real_sqlite_full_rolls_back_grant_and_intent(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    store, _, jobs = state
    grant, proposal = approved(jobs)
    with store.transaction() as db:
        db.execute("CREATE TABLE fixture_space(payload BLOB)")
        db.execute(
            "CREATE TRIGGER fixture_full BEFORE INSERT ON coding_effects BEGIN "
            "INSERT INTO fixture_space VALUES(zeroblob(8192)); END"
        )
        pages = db.execute("PRAGMA page_count").fetchone()[0]
        db.execute(f"PRAGMA max_page_count={pages}")
    with pytest.raises(CodingError, match="^storage$"):
        jobs.begin(intent(grant, proposal))
    with store.transaction() as db:
        assert db.execute("SELECT consumed_at FROM coding_grants").fetchone()[0] is None
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 0


@pytest.mark.parametrize(
    "observed_status,cancelled",
    [
        ("applied_saved", False),
        ("applied_unsaved", False),
        ("needs_review", False),
        ("needs_reconciliation", False),
        ("applied_saved", True),
    ],
)
def test_replacement_preserves_selected_baseline_and_requires_replace_scope(
    state: tuple[Store, Clock, CodingJobs],
    observed_status: Literal[
        "applied_saved", "applied_unsaved", "needs_review", "needs_reconciliation"
    ],
    cancelled: bool,
) -> None:
    store, clock, jobs = state
    from tests.helpers.coding_fake import make_file

    old = "owned old source\n"
    captured = CodeContext.model_validate(
        make_context(
            mode="replace_focus_file",
            target="index.html",
            files=[make_file(text=old, text_hash=literal_hash(old), disk_hash=literal_hash(old))],
        )
    )
    captured = captured.model_copy(update={"context_hash": context_hash(captured)})
    disclose(jobs, captured)
    proposal = CodeProposal.model_validate(
        make_proposal(files=[{"name": "index.html", "text": "Changed\n"}])
    )
    view = jobs.set_proposal(proposal)
    assert view.hashes[0].source_hash == literal_hash(old)
    with pytest.raises(CodingError):
        jobs.review(
            CodeReview(
                binding=captured.binding,
                scope="code.create",
                decision="accept",
                approved_hash="a" * 64,
            )
        )
    decision = CodeReview(
        binding=captured.binding,
        scope="code.replace",
        decision="accept",
        approved_hash=proposal_hash(proposal, captured, "code.replace"),
    )
    result = jobs.review(decision)
    assert result.kind == "grant"
    request = CodeFileIntent(
        binding=captured.binding,
        operation_id=result.grant.operation_id,
        effect_id="replace",
        scope="code.replace",
        ordinal=0,
        target="index.html",
        expected_hash=literal_hash("Changed\n"),
    )
    jobs.begin(request)
    if cancelled:
        jobs.cancel(captured.binding.job_id)
    observed = CodeFileReceipt(
        **request.model_dump(),
        status=observed_status,
        observed_hash=request.expected_hash
        if observed_status == "applied_saved"
        else literal_hash(old),
        observed_length=8 if observed_status == "applied_saved" else len(old.encode()),
    )
    jobs.observe(observed)
    view = jobs.get("job-1")
    assert view.state == ("cancelled" if cancelled else observed_status)
    assert view.receipts[0] == observed
    selected = recipe(clock)
    from sage.coding_contracts import recipe_hash

    selected = selected.model_copy(
        update={
            "file_hashes": tuple(
                item.model_copy(update={"hash": request.expected_hash})
                if item.name == "index.html"
                else item
                for item in selected.file_hashes
            )
        }
    )
    selected = selected.model_copy(update={"recipe_hash": recipe_hash(selected)})
    if observed_status == "applied_saved" and not cancelled:
        assert jobs.prepare_test(selected).state == "test_review"
    else:
        with pytest.raises(CodingError):
            jobs.prepare_test(selected)
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0


def test_disabled_local_capture_refuses_proposal_and_bad_hash_is_rejected(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, _, jobs = state
    captured = context()
    with pytest.raises(CodingError):
        jobs.accept_context(captured.model_copy(update={"context_hash": "b" * 64}))
    view = jobs.accept_context(captured)
    assert view.account_generation == 0 and view.account is None
    draft = {
        "job_id": "job-1",
        "revision": 1,
        "account_generation": 0,
        "user_text": "offline",
        "backend": "copilot",
    }
    with pytest.raises(CodingError):
        jobs.begin_proposal(
            CodeStart.model_validate({**draft, "disclosure_hash": disclosure_hash(view, draft)})
        )


def test_finish_unknown_effect_and_pair_revocation_preserve_facts(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, _, jobs = state
    grant, proposal = approved(jobs)
    jobs.begin(intent(grant, proposal))
    jobs.revoke_pair("other-pair")
    assert not jobs.get("job-1").cancel_requested
    jobs.revoke_pair("pair-1")
    assert jobs.get("job-1").state == "applying"
    assert jobs.finish("job-1").state == "needs_reconciliation"


def test_expire_revokes_consumed_operation_and_scrubs_remaining_source(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    store, clock, jobs = state
    grant, proposal = approved(jobs)
    first = intent(grant, proposal)
    jobs.begin(first)
    jobs.observe(receipt(first))
    clock.now += timedelta(minutes=5)
    jobs.expire()
    with store.transaction() as db:
        assert db.execute("SELECT revoked FROM coding_grants").fetchone()[0] == 1
    assert jobs.get("job-1").state == "partial"
    with pytest.raises(CodingError):
        jobs.begin(intent(grant, proposal, 1))


def test_late_result_after_direct_unknown_finish_never_reactivates_old_job(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, _, jobs = state
    grant, proposal = approved(jobs)
    first = intent(grant, proposal)
    jobs.begin(first)
    jobs.finish("job-1")
    captured = context()
    captured = captured.model_copy(
        update={"binding": captured.binding.model_copy(update={"job_id": "next"})}
    )
    captured = captured.model_copy(update={"context_hash": context_hash(captured)})
    jobs.accept_context(captured)
    assert jobs.observe(receipt(first)).status == "recorded"
    assert jobs.get("job-1").state == "partial"
    assert jobs.get("next").state == "context_ready"


def test_expired_unknown_test_result_becomes_reconciliation(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, clock, jobs = state
    grant = saved(jobs)
    selected = recipe(clock)
    jobs.prepare_test(selected)
    result = jobs.review(
        CodeReview(
            binding=grant.binding,
            scope="code.test",
            approved_hash=selected.recipe_hash,
            decision="accept",
        )
    )
    assert result.kind == "grant"
    request = CodeTestIntent(
        binding=grant.binding,
        operation_id=result.grant.operation_id,
        effect_id="unknown-test",
        ordinal=0,
        scope="code.test",
        expected_hash=selected.recipe_hash,
        recipe=selected,
    )
    jobs.begin(request)
    from hashlib import sha256

    environment_hash = sha256(
        json.dumps(selected.environment, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    observed = CodeTestReceipt(
        binding=grant.binding,
        operation_id=request.operation_id,
        effect_id=request.effect_id,
        ordinal=0,
        scope="code.test",
        expected_hash=request.expected_hash,
        status="unknown",
        exit_code=0,
        environment_hash=environment_hash,
        executable_hash=selected.executable_hash,
        executable_version=selected.executable_version,
        cancel_requested=False,
        timeout=False,
        overflow=False,
    )
    jobs.observe(observed)
    clock.now += timedelta(minutes=30)
    assert jobs.get("job-1").state == "needs_reconciliation"


def test_recipe_checks_known_selected_hashes_without_requiring_all_source_bodies(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    _, clock, jobs = state
    from tests.helpers.coding_fake import make_file

    captured = CodeContext.model_validate(
        make_context(
            mode="replace_focus_file",
            target="index.html",
            files=[
                make_file(text="old", text_hash=literal_hash("old"), disk_hash=literal_hash("old")),
                make_file(
                    name="focus.js",
                    text="selected helper",
                    text_hash=literal_hash("selected helper"),
                    disk_hash=literal_hash("selected helper"),
                    file_id="helper",
                ),
            ],
        )
    )
    captured = captured.model_copy(update={"context_hash": context_hash(captured)})
    disclose(jobs, captured)
    proposal = CodeProposal.model_validate(
        make_proposal(files=[{"name": "index.html", "text": "Changed\n"}])
    )
    jobs.set_proposal(proposal)
    result = jobs.review(
        CodeReview(
            binding=captured.binding,
            scope="code.replace",
            decision="accept",
            approved_hash=proposal_hash(proposal, captured, "code.replace"),
        )
    )
    assert result.kind == "grant"
    request = CodeFileIntent(
        binding=captured.binding,
        operation_id=result.grant.operation_id,
        effect_id="replace",
        scope="code.replace",
        ordinal=0,
        target="index.html",
        expected_hash=literal_hash("Changed\n"),
    )
    jobs.begin(request)
    jobs.observe(
        CodeFileReceipt(
            **request.model_dump(),
            status="applied_saved",
            observed_hash=request.expected_hash,
            observed_length=8,
        )
    )
    from sage.coding_contracts import recipe_hash

    selected = recipe(clock)
    files = tuple(
        row.model_copy(update={"hash": request.expected_hash}) if row.name == "index.html" else row
        for row in selected.file_hashes
    )
    selected = selected.model_copy(update={"file_hashes": files})
    selected = selected.model_copy(update={"recipe_hash": recipe_hash(selected)})
    with pytest.raises(CodingError):
        jobs.prepare_test(selected)
    files = tuple(
        row.model_copy(update={"hash": literal_hash("selected helper")})
        if row.name == "focus.js"
        else row
        for row in selected.file_hashes
    )
    selected = selected.model_copy(update={"file_hashes": files})
    selected = selected.model_copy(update={"recipe_hash": recipe_hash(selected)})
    assert jobs.prepare_test(selected).state == "test_review"
    assert jobs.get("job-1").file_count == 2


def test_literal_extension_journal_projection_and_receipt_parity() -> None:
    import hashlib

    from sage.coding_contracts import parse_code_intent, parse_code_receipt

    corpus = json.loads((Path(__file__).parents[1] / "fixtures/coding-contracts.json").read_text())
    for vector in corpus["journal_vectors"]:
        if vector["kind"] == "intent":
            material = CodingJobs._projection(parse_code_intent(vector["input"]))
        else:
            material = parse_code_receipt(vector["input"]).model_dump(mode="json")
        assert json.loads(json.dumps(material)) == vector["projection"], vector["label"]
        encoded = json.dumps(material, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        assert hashlib.sha256(encoded.encode()).hexdigest() == vector["canonical_sha256"]


def test_created_saved_context_remains_for_separate_test_review_without_spawn(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    store, clock, jobs = state
    grant = saved(jobs)
    current = jobs.get(grant.binding.job_id)
    assert current.state == "applied_saved" and len(current.receipts) == 4
    assert jobs.prepare_test(recipe(clock)).state == "test_review"
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 4
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0
