"""Changed bindings, leases and replay never produce fresh effect permission."""

from datetime import timedelta

import pytest

from sage.coding_jobs import CodingError, CodingJobs
from sage.storage import Store
from tests.integration.test_coding_jobs import Clock, approved, intent, receipt
from tests.integration.test_coding_jobs import state as state


@pytest.mark.parametrize(
    "field,value",
    [
        ("boot_id", "wrong"),
        ("pair_id", "wrong"),
        ("window_id", "wrong"),
        ("root_id", "wrong"),
        ("job_id", "wrong"),
        ("revision", 2),
    ],
)
def test_changed_binding_has_zero_effects(
    state: tuple[Store, Clock, CodingJobs], field: str, value: str | int
) -> None:
    store, _, jobs = state
    grant, proposal = approved(jobs)
    request = intent(grant, proposal)
    request = request.model_copy(
        update={"binding": request.binding.model_copy(update={field: value})}
    )
    with pytest.raises(CodingError):
        jobs.begin(request)
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 0


def test_expired_or_replayed_coding_grant_has_zero_effects(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    store, clock, jobs = state
    grant, proposal = approved(jobs)
    clock.now += timedelta(minutes=5)
    with pytest.raises(CodingError):
        jobs.begin(intent(grant, proposal))
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 0


def test_clock_rollback_revokes_consumed_continuation_after_catchup(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    store, clock, jobs = state
    grant, proposal = approved(jobs)
    first = intent(grant, proposal)
    jobs.begin(first)
    jobs.observe(receipt(first))
    clock.now += timedelta(seconds=1, microseconds=1)
    jobs.get("job-1")
    clock.now -= timedelta(microseconds=1)
    jobs.get("job-1")
    clock.now += timedelta(microseconds=1)
    with pytest.raises(CodingError):
        jobs.begin(intent(grant, proposal, 1))
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 1


@pytest.mark.parametrize(
    "change",
    [
        {"model": "changed-model"},
        {"account": "changed-account"},
        {"account_generation": 2},
        {"backend": "none", "account": None, "account_generation": 0},
    ],
)
def test_changed_selection_revokes_pending_and_consumed_grant(
    state: tuple[Store, Clock, CodingJobs], change: dict[str, object]
) -> None:
    store, _, jobs = state
    grant, proposal = approved(jobs)
    request = intent(grant, proposal)
    jobs.begin(request)
    selection = {
        "backend": "copilot",
        "account": "test-account",
        "model": None,
        "account_generation": 1,
        **change,
    }
    jobs.configure_selection(**selection)  # type: ignore[arg-type]
    assert jobs.get("job-1").cancel_requested
    assert jobs.observe(receipt(request)).status == "recorded"
    with pytest.raises(CodingError):
        jobs.begin(intent(grant, proposal, 1))
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 1


def test_changed_hash_scope_operation_and_duplicate_cannot_dispatch(
    state: tuple[Store, Clock, CodingJobs],
) -> None:
    store, _, jobs = state
    grant, proposal = approved(jobs)
    request = intent(grant, proposal)
    changes_list: list[dict[str, object]] = [
        {"expected_hash": "b" * 64},
        {"scope": "code.replace"},
        {"operation_id": "note-approval"},
        {"ordinal": 1},
        {"target": "focus.js"},
    ]
    for changes in changes_list:
        with pytest.raises(CodingError):
            jobs.begin(request.model_copy(update=changes))
    assert jobs.begin(request).status == "recorded"
    assert jobs.begin(request).status == "duplicate"
    assert jobs.begin(request.model_copy(update={"expected_hash": "b" * 64})).status == "conflict"
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 1
