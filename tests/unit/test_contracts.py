"""Boundary cases catch relaxed validation and altered literal note content."""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from sage.contracts import (
    ActionProposal,
    ActionResult,
    Approval,
    Note,
    NoteContent,
    ProviderDiagnostic,
    ProviderReadiness,
    ReasoningRequest,
    ReasoningResult,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "contracts.json"


@pytest.mark.parametrize(
    "bad",
    [
        {"stage": "raw error", "category": "io_error"},
        {"stage": "sdk_import", "category": "raw error"},
        {"stage": "sdk_import", "category": "io_error", "message": "private"},
    ],
)
def test_provider_diagnostic_is_closed(bad: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ProviderDiagnostic.model_validate(bad)


def examples() -> dict[str, Any]:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


@pytest.mark.parametrize(
    ("title", "body", "valid"),
    [
        ("x" * 200, "x" * 100000, True),
        ("x" * 201, "body", False),
        ("title", "x" * 100001, False),
        ("", "body", False),
        ("title", "", False),
        (" \t", "body", False),
        ("title", " \t\n", False),
        ("😀" * 200, "body", True),
        ("😀" * 201, "body", False),
        ("e\u0301" * 100, "body", True),
        ("e\u0301" * 100 + "x", "body", False),
    ],
    ids=[
        "maximum-title-and-body",
        "title-too-long",
        "body-too-long",
        "empty-title",
        "empty-body",
        "whitespace-title",
        "whitespace-body",
        "maximum-emoji-title",
        "emoji-title-too-long",
        "maximum-combining-title",
        "combining-title-too-long",
    ],
)
def test_note_limits(title: str, body: str, valid: bool) -> None:
    if valid:
        content = NoteContent(title=title, body=body)
        assert (content.title, content.body) == (title, body)
    else:
        with pytest.raises(ValidationError):
            NoteContent(title=title, body=body)


@pytest.mark.parametrize(
    ("title", "body", "valid"),
    [
        ("  Café e\u0301 😀  ", "\tline one\nline two\r\n", True),
        ("literal ${HOME} & <script>", "'; $(echo x)\t**literal**\n", True),
        ("a\x00b", "body", False),
        ("title", "a\x00b", False),
        ("a\tb", "body", False),
        ("a\nb", "body", False),
        ("title", "a\x01b", False),
        ("title", "a\x7fb", False),
        ("title", "a\x85b", False),
        ("title", "a\ud800b", False),
    ],
)
def test_literal_unicode_and_controls(title: str, body: str, valid: bool) -> None:
    if valid:
        content = NoteContent(title=title, body=body)
        assert content.model_dump() == {"title": title, "body": body}
        saved = Note(
            id="note-1",
            title=title,
            body=body,
            created_at=datetime(2026, 10, 22, tzinfo=UTC),
            updated_at=datetime(2026, 10, 22, tzinfo=UTC),
        )
        assert (saved.title, saved.body) == (title, body)
    else:
        with pytest.raises(ValidationError):
            NoteContent(title=title, body=body)


@pytest.mark.parametrize(
    ("user_text", "context", "valid"),
    [
        ("x" * 32000, ["x" * 32000, "😀" * 32000], True),
        ("x" * 32001, [], False),
        ("x", ["x" * 64001], False),
        ("x", ["x" * 32000, "x" * 32001], False),
        ("x\x00", [], False),
        ("x", ["a\x01"], False),
        (" \tx\n", ["a\t\nb"], True),
    ],
)
def test_request_context_limits(user_text: str, context: list[str], valid: bool) -> None:
    payload = {
        **examples()["ReasoningRequest"],
        "user_text": user_text,
        "attached_context": context,
    }
    if valid:
        request = ReasoningRequest.model_validate_json(json.dumps(payload))
        assert request.user_text == user_text
        assert list(request.attached_context) == context
    else:
        with pytest.raises(ValidationError):
            ReasoningRequest.model_validate_json(json.dumps(payload))


MODELS = [
    ProviderReadiness,
    ReasoningRequest,
    ReasoningResult,
    ActionProposal,
    Approval,
    ActionResult,
    Note,
    NoteContent,
]


@pytest.mark.parametrize("model", MODELS)
def test_extra_fields_rejected(model: Any) -> None:
    payload = {**examples()[model.__name__], "approval_override": True}
    with pytest.raises(ValidationError):
        model.model_validate_json(json.dumps(payload))


@pytest.mark.parametrize("model", MODELS)
def test_serialized_contract_examples(model: Any) -> None:
    payload = examples()[model.__name__]
    value = model.model_validate_json(json.dumps(payload))
    assert json.loads(value.model_dump_json()) == payload


@pytest.mark.parametrize(
    ("model", "field", "value"),
    [
        (ProviderReadiness, "status", "online"),
        (ReasoningResult, "status", "done"),
        (ActionResult, "status", "done"),
        (ActionProposal, "tool", "shell.run"),
        (Approval, "tool", "shell.run"),
        (Approval, "decision", "model_approved"),
        (ActionProposal, "revision", "1"),
        (ActionProposal, "revision", 0),
        (ActionProposal, "revision", True),
        (NoteContent, "title", 42),
        (ReasoningRequest, "user_text", 42),
    ],
)
def test_unknown_enums_and_coercion_rejected(model: Any, field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        model.model_validate_json(json.dumps({**examples()[model.__name__], field: value}))


@pytest.mark.parametrize("field", ["id", "revision", "tool", "scope", "approval"])
def test_provider_note_content_cannot_supply_authority(field: str) -> None:
    with pytest.raises(ValidationError):
        ReasoningResult.model_validate_json(
            json.dumps(
                {
                    **examples()["ReasoningResult"],
                    "proposal": {"title": "title", "body": "body", field: "forged"},
                }
            )
        )


@pytest.mark.parametrize("status", ["pending", "approved", "rejected"])
def test_approval_decisions_are_explicit(status: str) -> None:
    payload = {**examples()["Approval"], "decision": status}
    assert Approval.model_validate_json(json.dumps(payload)).decision == status


@pytest.mark.parametrize("value", [-1, True, "1"])
def test_usage_never_coerces_or_invents_tokens(value: object) -> None:
    with pytest.raises(ValidationError):
        ReasoningResult.model_validate_json(
            json.dumps(
                {
                    **examples()["ReasoningResult"],
                    "usage": {"input_tokens": value, "output_tokens": None},
                }
            )
        )


def test_unknown_usage_remains_unknown() -> None:
    result = ReasoningResult.model_validate_json(json.dumps(examples()["ReasoningResult"]))
    assert result.usage is None
    payload = {**examples()["ReasoningResult"], "usage": {"input_tokens": 0, "output_tokens": None}}
    result = ReasoningResult.model_validate_json(json.dumps(payload))
    assert result.usage is not None
    assert result.usage.input_tokens == 0
    assert result.usage.output_tokens is None


@pytest.mark.parametrize("model", MODELS)
def test_contracts_cannot_be_mutated(model: Any) -> None:
    value = model.model_validate_json(json.dumps(examples()[model.__name__]))
    field = next(iter(type(value).model_fields))
    with pytest.raises(ValidationError):
        setattr(value, field, getattr(value, field))


def test_pre_attempt_result_does_not_need_transport_identity() -> None:
    result = ActionResult(status="rejected")
    assert result.task_id is None
    assert result.operation_id is None
    assert result.note_id is None
