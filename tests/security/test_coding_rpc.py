"""The parent-only coding lane cannot be manufactured by public methods."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

import pytest

from sage.coding_contracts import CodeContext, context_hash
from sage.protocol import encode_frame, read_frame
from sage.service import CoreService, run_service
from sage.storage import Store
from tests.helpers.coding_fake import make_context
from tests.integration.test_coding_provider import envelope


class Pipe:
    def __init__(self) -> None:
        self.reader = asyncio.StreamReader()

    def write(self, data: bytes) -> None:
        self.reader.feed_data(data)

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.reader.feed_eof()

    async def wait_closed(self) -> None:
        pass


def control(operation: str, params: dict[str, Any], generation: int = 1) -> dict[str, object]:
    return {
        "version": 1,
        "kind": "host_coding",
        "host_boot_id": "c" * 32,
        "generation": generation,
        "id": f"control-{generation}",
        "operation": operation,
        "params": params,
    }


def offer(now: datetime) -> dict[str, Any]:
    context = CodeContext.model_validate(make_context(diagnostics=["PRIVATE_DIAGNOSTIC"]))
    context = context.model_copy(update={"context_hash": context_hash(context)})
    epoch = datetime(1970, 1, 1, tzinfo=UTC)
    ms = (now - epoch) // timedelta(milliseconds=1)
    return {
        "context": context.model_dump(mode="json"),
        "captured_at_ms": ms - 1_799_000,
        "expires_at_ms": ms + 1000,
    }


def test_actual_framed_context_keeps_original_lease_and_status_source_free(tmp_path: Path) -> None:
    async def run() -> None:
        now = datetime(2035, 1, 2, tzinfo=UTC)
        core = CoreService(Store.open(tmp_path / "core.sqlite"), clock=lambda: now)
        reader, output = asyncio.StreamReader(), Pipe()
        running = asyncio.create_task(run_service(reader, output, core))
        value = offer(now)
        reader.feed_data(encode_frame(control("context", value)))
        reply = cast(dict[str, Any], await read_frame(output.reader))
        assert reply["kind"] == "host_coding_reply"
        assert reply["result"]["expires_at"] == "2035-01-02T00:00:01Z"
        reader.feed_data(encode_frame(envelope("coding.get", {"job_id": "job-1"})))
        status = cast(dict[str, Any], await read_frame(output.reader))
        assert status["result"]["state"] == "context_ready"
        assert "PRIVATE_" not in json.dumps(status)
        now += timedelta(seconds=1)
        reader.feed_data(encode_frame(envelope("coding.get", {"job_id": "job-1"}, "expired")))
        assert (
            cast(dict[str, Any], await read_frame(output.reader))["result"]["diagnostic"]
            == "expired"
        )
        reader.feed_eof()
        await running
        await core.aclose()

    asyncio.run(run())


@pytest.mark.parametrize(
    "operation",
    [
        "context",
        "proposal_get",
        "review",
        "intent",
        "observation",
        "revoke_pair",
        "test_prepare",
        "finish",
    ],
)
def test_public_lane_cannot_authorize_private_controls(tmp_path: Path, operation: str) -> None:
    async def run() -> None:
        core = CoreService(Store.open(tmp_path / "core.sqlite"))
        assert (await core.dispatch(control(operation, {})))["kind"] == "error"
        assert (
            await core.dispatch(envelope("coding." + operation, {"command": "PRIVATE_COMMAND"}))
        )["kind"] == "error"
        with core.store.transaction() as db:
            assert db.execute("SELECT count(*) FROM coding_grants").fetchone()[0] == 0
            assert db.execute("SELECT count(*) FROM coding_effects").fetchone()[0] == 0
        await core.aclose()

    asyncio.run(run())


def test_actual_framed_provider_review_and_two_durable_core_acks(tmp_path: Path) -> None:
    from sage.coding_contracts import (
        CodeFileIntent,
        CodeFileReceipt,
        CodeProposal,
        disclosure_hash,
        literal_hash,
        proposal_hash,
    )
    from tests.helpers.coding_fake import DeferredCodingBackend
    from tests.integration.test_coding_provider import enabled_core

    async def run() -> None:
        now = datetime(2035, 1, 2, tzinfo=UTC)
        backend = DeferredCodingBackend()
        core = enabled_core(tmp_path, backend, lambda: now)
        reader, output = asyncio.StreamReader(), Pipe()
        running = asyncio.create_task(run_service(reader, output, core))
        generation = 0

        async def private(operation: str, params: dict[str, Any]) -> dict[str, Any]:
            nonlocal generation
            generation += 1
            reader.feed_data(encode_frame(control(operation, params, generation)))
            return cast(dict[str, Any], await read_frame(output.reader))

        lease = offer(now)
        reply = await private("context", lease)
        view = core.coding.get("job-1")
        draft = {
            "job_id": "job-1",
            "revision": 1,
            "account_generation": 0,
            "user_text": "PRIVATE_PROMPT",
            "backend": "copilot",
        }
        reader.feed_data(
            encode_frame(
                envelope("coding.start", {**draft, "disclosure_hash": disclosure_hash(view, draft)})
            )
        )
        assert (await read_frame(output.reader))["kind"] == "response"
        await backend.entered.wait()
        assert backend.requests[0].deadline == now + timedelta(seconds=1)
        backend.release.set()
        await asyncio.sleep(0)
        result = await private("proposal_get", {"job_id": "job-1"})
        proposal = CodeProposal.model_validate(result["result"])
        context = CodeContext.model_validate(lease["context"])
        grant_reply = await private(
            "review",
            {
                "binding": context.binding.model_dump(),
                "scope": "code.create",
                "approved_hash": proposal_hash(proposal, context, "code.create"),
                "decision": "accept",
            },
        )
        grant = grant_reply["result"]["grant"]
        assert grant["grant_boot_id"] == core.boot_id
        assert grant["binding"]["boot_id"] != core.boot_id
        assert grant_reply["host_boot_id"] == "c" * 32
        assert grant["expires_at"] == reply["result"]["expires_at"]
        first = proposal.files[0]
        intent = CodeFileIntent(
            binding=context.binding,
            operation_id=grant["operation_id"],
            effect_id="effect-1",
            scope="code.create",
            ordinal=0,
            target=first.name,
            expected_hash=literal_hash(first.text),
        )
        ack = await private("intent", intent.model_dump(mode="json"))
        assert ack["result"]["status"] == "recorded"
        observed = CodeFileReceipt(
            **intent.model_dump(),
            status="created",
            observed_hash=intent.expected_hash,
            observed_length=len(first.text.encode()),
        )
        ack = await private("observation", observed.model_dump(mode="json"))
        assert ack["result"]["status"] == "recorded"
        assert "PRIVATE_" not in json.dumps(ack)
        with core.store.transaction() as db:
            assert (
                db.execute(
                    "SELECT count(*) FROM coding_effects WHERE receipt_json IS NOT NULL"
                ).fetchone()[0]
                == 1
            )
            assert "PRIVATE_" not in json.dumps(list(db.iterdump()))
        await private("revoke_pair", {"pair_id": "pair-1"})
        assert core.coding.get("job-1").cancel_requested
        reader.feed_eof()
        await running
        await core.aclose()
        assert backend.closed == 1

    asyncio.run(run())


def test_extra_start_fields_and_note_grants_never_reach_provider(tmp_path: Path) -> None:
    from tests.helpers.coding_fake import DeferredCodingBackend
    from tests.integration.test_coding_provider import capture, enabled_core

    async def run() -> None:
        backend = DeferredCodingBackend()
        core = enabled_core(tmp_path, backend)
        start = capture(core)
        bad = {**start.model_dump(mode="json"), "command": "PRIVATE_COMMAND"}
        assert (await core.dispatch(envelope("coding.start", bad)))["kind"] == "error"
        assert core.coding.get("job-1").state == "context_ready"
        note = {"proposal_id": "note", "revision": 1, "scope": "notes", "decision": "save"}
        assert (await core.coding_control(control("review", note)))["kind"] == "error"
        assert backend.requests == []
        with core.store.transaction() as db:
            assert db.execute("SELECT count(*) FROM coding_grants").fetchone()[0] == 0
        await core.aclose()

    asyncio.run(run())


def test_private_control_owns_boot_generation_and_global_rpc_ids(tmp_path: Path) -> None:
    async def run() -> None:
        core = CoreService(Store.open(tmp_path / "core.sqlite"))
        first = control("revoke_pair", {"pair_id": "pair-1"})
        assert (await core.coding_control(first))["kind"] == "host_coding_reply"
        assert (await core.coding_control(first))["code"] == "duplicate_id"
        replay = {**first, "id": "replay"}
        assert (await core.coding_control(replay))["code"] == "invalid_request"
        other = {**control("revoke_pair", {"pair_id": "pair-1"}, 2), "host_boot_id": "d" * 32}
        assert (await core.coding_control(other))["code"] == "invalid_request"
        assert (await core.dispatch(envelope("coding.readiness", {}, "ready")))[
            "kind"
        ] == "response"
        await core.aclose()

    asyncio.run(run())


def test_original_source_timer_clears_private_slot_without_polling(tmp_path: Path) -> None:
    async def run() -> None:
        core = CoreService(Store.open(tmp_path / "core.sqlite"))
        now = datetime.now(UTC)
        lease = offer(now)
        lease["expires_at_ms"] = lease["captured_at_ms"] + 1_799_100
        reply = await core.coding_control(control("context", lease))
        assert reply["kind"] == "host_coding_reply"
        await asyncio.sleep(0.15)
        assert core.coding._context is None
        assert core.coding._proposal is None
        assert core.coding.get("job-1").diagnostic == "expired"
        await core.aclose()

    asyncio.run(run())


def test_invalid_private_identifier_is_never_echoed_or_raised(tmp_path: Path) -> None:
    async def run() -> None:
        core = CoreService(Store.open(tmp_path / "core.sqlite"))
        malformed = {**control("revoke_pair", {"pair_id": "pair-1"}), "id": "PRIVATE/bad-id"}
        response = await core.coding_control(malformed)
        assert response == {"version": 1, "kind": "error", "id": None, "code": "invalid_request"}
        await core.aclose()

    asyncio.run(run())
