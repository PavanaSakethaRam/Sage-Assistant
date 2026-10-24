"""Coding contracts reject authority and source shape changes at the boundary."""

import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

import sage.coding_contracts as coding
from sage.coding_contracts import (
    CodeAck,
    CodeContext,
    CodeGrant,
    CodeJobPage,
    CodeJobView,
    CodeModelRequest,
    CodePage,
    CodeReview,
    CodeStart,
    context_hash,
    disclosure_hash,
    parse_code_intent,
    parse_code_proposal,
    parse_code_receipt,
    provider_context,
    recipe_hash,
)
from sage.coding_contracts import (
    TestRecipe as CodingTestRecipe,
)
from sage.contracts import Contract
from sage.protocol import ProtocolError, read_frame
from tests.helpers.coding_fake import (
    BINDING,
    HASH,
    make_context,
    make_file,
    make_proposal,
    make_receipt,
)

CORPUS = Path(__file__).resolve().parents[1] / "fixtures" / "coding-contracts.json"


def test_code_contract_parity() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    for row in corpus["cases"]:
        kind, value, valid = row["kind"], row["value"], row["valid"]

        def parse(kind: str = kind, value: object = value, row: dict[str, object] = row) -> object:
            if kind == "context":
                return CodeContext.model_validate(value)
            if kind == "proposal":
                return parse_code_proposal(value, CodeContext.model_validate(row["context"]))
            if kind == "job_view":
                return CodeJobView.model_validate(value)
            if kind == "receipt":
                return parse_code_receipt(value)
            if kind == "ack":
                return CodeAck.model_validate(value)
            if kind == "recipe":
                return CodingTestRecipe.model_validate(value)
            if kind == "start":
                return CodeStart.model_validate(value)
            if kind == "model_request":
                return CodeModelRequest.model_validate(value)
            if kind == "intent":
                return parse_code_intent(value)
            if kind == "review":
                return CodeReview.model_validate(value)
            if kind == "grant":
                return CodeGrant.model_validate(value)
            if kind == "page":
                return CodePage.model_validate(value)
            if kind == "job_page":
                return CodeJobPage.model_validate(value)
            raise AssertionError(kind)

        if valid:
            assert parse() is not None, row["label"]
        else:
            with pytest.raises((ValidationError, ValueError), match="."):
                parse()


def test_creation_and_replacement_have_only_fixed_outputs() -> None:
    create = CodeContext.model_validate(make_context())
    assert [f.name for f in parse_code_proposal(make_proposal(), create).files] == [
        "index.html",
        "focus.js",
        "focus.test.mjs",
        "README.md",
    ]
    replace = CodeContext.model_validate(
        make_context(mode="replace_focus_file", target="index.html", files=[make_file()])
    )
    assert [
        f.name
        for f in parse_code_proposal(
            make_proposal(files=[{"name": "index.html", "text": "updated\n"}]), replace
        ).files
    ] == ["index.html"]
    for files in [
        make_proposal()["files"][:-1],
        [make_proposal()["files"][0]] * 4,
        [{"name": "../index.html", "text": "x"}] * 4,
        [{"name": "index.html", "text": "x", "command": "rm -rf"}],
    ]:
        with pytest.raises((ValidationError, ValueError)):
            parse_code_proposal(make_proposal(files=files), create)
    with pytest.raises((ValidationError, ValueError)):
        parse_code_proposal(make_proposal(files=[{"name": "focus.js", "text": "x"}]), replace)


@pytest.mark.parametrize(
    "text,valid",
    [
        ("😀" * 32000, True),
        ("😀" * 32001, False),
        ("a\x00b", False),
        ("a\x01b", False),
        ("a\ud800b", False),
        ("\ufeffa", False),
        ("a\r\nb", False),
    ],
    ids=["max-astral", "over-max-astral", "nul", "control", "surrogate", "bom", "crlf"],
)
def test_proposed_file_literal_limits(text: str, valid: bool) -> None:
    context = CodeContext.model_validate(make_context())
    files = make_proposal()["files"]
    files[0] = {"name": "index.html", "text": text}
    if valid:
        assert parse_code_proposal(make_proposal(files=files), context).files[0].text == text
    else:
        with pytest.raises((ValidationError, ValueError)):
            parse_code_proposal(make_proposal(files=files), context)


def test_total_source_and_explanation_boundaries() -> None:
    context = CodeContext.model_validate(make_context())
    base = make_proposal()["files"]
    # The fixed names are provider-visible metadata and consume their literal lengths.
    names = sum(len(file["name"]) for file in base)
    files = [
        {"name": base[0]["name"], "text": "a" * 32000},
        {"name": base[1]["name"], "text": "b" * (32000 - names)},
        {"name": base[2]["name"], "text": ""},
        {"name": base[3]["name"], "text": ""},
    ]
    assert parse_code_proposal(make_proposal(files=files, explanation="😀" * 2000), context)
    files[1] = {**files[1], "text": files[1]["text"] + "x"}
    with pytest.raises((ValidationError, ValueError)):
        parse_code_proposal(make_proposal(files=files), context)
    with pytest.raises((ValidationError, ValueError)):
        parse_code_proposal(make_proposal(explanation="😀" * 2001), context)


def test_private_context_not_projected() -> None:
    source = make_file(text="user-marker\n")
    context = CodeContext.model_validate(
        make_context(
            mode="replace_focus_file",
            target="index.html",
            files=[source],
            diagnostics=["selected diagnostic"],
        )
    )
    projection = provider_context(context)
    assert [s.model_dump() for s in projection] == [{"name": "index.html", "text": "user-marker\n"}]
    serialized = json.dumps([s.model_dump() for s in projection])
    assert "owner-marker" not in serialized
    assert "root_file_id" not in serialized
    assert "file_id" not in serialized
    assert "document_version" not in serialized
    assert "selected diagnostic" not in serialized


def test_extra_execution_field_is_rejected() -> None:
    with pytest.raises(ValidationError):
        CodeContext.model_validate({**make_context(), "command": "node other.js"})
    with pytest.raises(ValidationError):
        parse_code_receipt({**make_receipt(), "output": "secret"})
    with pytest.raises(ValidationError):
        CodeContext.model_validate(make_context(binding={**BINDING, "job_id": "has space"}))
    with pytest.raises(ValidationError):
        CodeContext.model_validate(make_context(context_hash=HASH.upper()))
    with pytest.raises(ValidationError):
        CodeContext.model_validate(make_context(binding={**BINDING, "revision": True}))


def test_prompt_codepoint_boundary_and_selected_diagnostic_budget() -> None:
    start = {
        "job_id": "job-1",
        "revision": 1,
        "account_generation": 1,
        "user_text": "😀" * 32_000,
        "backend": "copilot",
        "disclosure_hash": HASH,
    }
    assert CodeStart.model_validate(start).user_text == start["user_text"]
    with pytest.raises(ValidationError):
        CodeStart.model_validate({**start, "user_text": "😀" * 32_001})
    file = make_file(text="a" * 32_000)
    context = make_context(mode="replace_focus_file", target="index.html", files=[file])
    metadata = len("replace_focus_file") + len("index.html") * 2
    context["diagnostics"] = ["b" * (64_000 - 32_000 - metadata)]
    assert CodeContext.model_validate(context).diagnostics
    context["diagnostics"] = [context["diagnostics"][0] + "b"]
    with pytest.raises(ValidationError):
        CodeContext.model_validate(context)


def test_disclosure_hash_uses_literal_labeled_canonical_fields() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    for row in corpus["hash_vectors"]:
        view = CodeJobView.model_validate(row["view"])
        assert disclosure_hash(view, row["draft"]) == row["expected"]
    first = corpus["hash_vectors"][0]
    view = CodeJobView.model_validate(first["view"])
    assert disclosure_hash(view, {**first["draft"], "user_text": "changed"}) != first["expected"]


def test_snapshot_hash_covers_private_identity_and_literal_source() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    for row in corpus["context_hash_vectors"]:
        context = CodeContext.model_validate(row["context"])
        assert context_hash(context) == row["expected"]
        assert (
            context_hash(context.model_copy(update={"root_uri": "file:///changed"}))
            != row["expected"]
        )


def test_recipe_hash_uses_fixed_fields_and_constructed_environment() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    for row in corpus["recipe_vectors"]:
        recipe = CodingTestRecipe.model_validate(row["recipe"])
        assert recipe_hash(recipe) == row["expected"]
        if "python_wire" in row:
            wire = recipe.model_dump(mode="json")
            assert wire == row["python_wire"]
            assert recipe_hash(CodingTestRecipe.model_validate(wire)) == row["expected"]
        changed = {**row["recipe"], "environment": {**row["recipe"]["environment"], "TEMP": "/new"}}
        assert recipe_hash(CodingTestRecipe.model_validate(changed)) != row["expected"]


def test_canonical_utc_parity_across_shared_values() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    parsers: dict[str, Callable[[object], Contract]] = {
        "recipe": CodingTestRecipe.model_validate,
        "model_request": CodeModelRequest.model_validate,
        "job_view": CodeJobView.model_validate,
        "grant": CodeGrant.model_validate,
    }
    for row in corpus["utc_cases"]:
        base = next(
            case["value"]
            for case in corpus["cases"]
            if case["kind"] == row["kind"] and case["valid"]
        )
        candidate = {**base, row["field"]: row["value"]}
        parse = parsers[row["kind"]]
        if row["valid"]:
            parsed = parse(candidate)
            assert parsed.model_dump(mode="json")[row["field"]] == row["value"], row["label"]
        else:
            with pytest.raises((ValidationError, ValueError)):
                parse(candidate)

    recipe = CodingTestRecipe.model_validate(corpus["recipe_vectors"][0]["recipe"])
    internal = recipe.model_copy(
        update={"deadline": datetime(2026, 10, 24, 12, 0, 30, 123456, tzinfo=UTC)}
    )
    assert internal.model_dump(mode="json")["deadline"] == "2026-10-24T12:00:30.123456Z"


def test_escaped_duplicate_names_fail_at_existing_frame_boundary() -> None:
    async def read(body: bytes) -> None:
        reader = asyncio.StreamReader()
        reader.feed_data(len(body).to_bytes(4, "big") + body)
        reader.feed_eof()
        await read_frame(reader)

    for body in [
        b'{"job_id":"a","job_\\u0069d":"b"}',
        b'{"files":[{"name":"index.html","na\\u006de":"focus.js"}]}',
    ]:
        with pytest.raises(ProtocolError):
            asyncio.run(read(body))


def test_job_page_rejects_oversized_serialized_frame() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    view = next(
        row["value"] for row in corpus["cases"] if row["kind"] == "job_view" and row["valid"]
    )
    view["receipts"] = [make_receipt() for _ in range(100)]
    with pytest.raises(ValidationError):
        CodeJobPage.model_validate({"items": [view] * 100, "next_offset": None})


def test_create_values_serialize_without_a_target() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    parsers: list[tuple[str, Callable[[object], Contract]]] = [
        ("context", CodeContext.model_validate),
        ("model_request", CodeModelRequest.model_validate),
        ("job_view", CodeJobView.model_validate),
    ]
    for kind, parser in parsers:
        value = next(
            row["value"] for row in corpus["cases"] if row["kind"] == kind and row["valid"]
        )
        parsed = parser(value)
        serialized = parsed.model_dump(mode="json")
        assert "target" not in serialized
        assert parser(serialized) == parsed


def test_all_public_values_round_trip_through_json_mode_dump() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))

    def parse(row: dict[str, object], value: object) -> Contract:
        kind = row["kind"]
        if kind == "proposal":
            context = CodeContext.model_validate(row["context"])
            return parse_code_proposal(value, context)
        if kind == "receipt":
            return parse_code_receipt(value)
        if kind == "intent":
            return parse_code_intent(value)
        parsers: dict[str, Callable[[object], Contract]] = {
            "context": CodeContext.model_validate,
            "job_view": CodeJobView.model_validate,
            "ack": CodeAck.model_validate,
            "recipe": CodingTestRecipe.model_validate,
            "start": CodeStart.model_validate,
            "model_request": CodeModelRequest.model_validate,
            "review": CodeReview.model_validate,
            "grant": CodeGrant.model_validate,
            "page": CodePage.model_validate,
            "job_page": CodeJobPage.model_validate,
        }
        assert isinstance(kind, str)
        return parsers[kind](value)

    for row in corpus["cases"]:
        if row["valid"]:
            value = parse(row, row["value"])
            assert parse(row, value.model_dump(mode="json")) == value, row["label"]

    values: list[Contract] = [
        coding.CodeBinding.model_validate(BINDING),
        coding.CodeSource.model_validate(make_proposal()["files"][0]),
        coding.CodeFile.model_validate(make_file()),
        coding.CodeDraft.model_validate(
            {
                "job_id": "job-1",
                "revision": 1,
                "account_generation": 1,
                "user_text": "Build Focus",
                "backend": "copilot",
            }
        ),
        coding.CodeHashRecord(
            name="index.html", source_hash=None, proposed_hash=None, observed_hash=None
        ),
        coding.TestFileHash(name="index.html", hash=HASH),
        coding.CodeGrantResult(
            kind="grant",
            grant=CodeGrant.model_validate(
                next(
                    row["value"]
                    for row in corpus["cases"]
                    if row["kind"] == "grant" and row["valid"]
                )
            ),
        ),
        coding.CodeJobResult(
            kind="job",
            job=CodeJobView.model_validate(
                next(
                    row["value"]
                    for row in corpus["cases"]
                    if row["kind"] == "job_view" and row["valid"]
                )
            ),
        ),
        coding.CodeReceiptResult(kind="receipt", receipt=parse_code_receipt(make_receipt())),
    ]
    for value in values:
        assert TypeAdapter(type(value)).validate_python(value.model_dump(mode="json")) == value
