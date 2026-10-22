"""Closed data contracts. Valid data does not itself confer action authority."""

import unicodedata
from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field


def _literal_text(value: str, *, multiline: bool) -> str:
    allowed = "\t\n\r" if multiline else ""
    if any(unicodedata.category(char) in {"Cc", "Cs"} and char not in allowed for char in value):
        raise ValueError("Text contains an unsupported control character")
    return value


def _nonblank_title(value: str) -> str:
    _literal_text(value, multiline=False)
    if not value.strip():
        raise ValueError("Title must contain non-whitespace text")
    return value


def _nonblank_body(value: str) -> str:
    _literal_text(value, multiline=True)
    if not value.strip():
        raise ValueError("Body must contain non-whitespace text")
    return value


def _context_text(value: str) -> str:
    return _literal_text(value, multiline=True)


def _context_total(value: tuple[str, ...]) -> tuple[str, ...]:
    if sum(len(part) for part in value) > 64_000:
        raise ValueError("Attached context exceeds 64000 code points")
    return value


class Contract(BaseModel):
    """Immutable strict values with no unexpected fields or coercion."""

    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
    )


Identifier = Annotated[str, Field(min_length=1)]
Backend = Literal["copilot", "local", "api"]
Title = Annotated[str, Field(max_length=200), AfterValidator(_nonblank_title)]
Body = Annotated[str, Field(max_length=100_000), AfterValidator(_nonblank_body)]
ContextText = Annotated[str, AfterValidator(_context_text)]
AttachedContext = Annotated[tuple[ContextText, ...], AfterValidator(_context_total)]
Revision = Annotated[int, Field(ge=1)]
Tool = Literal["notes.create"]
Scope = Literal["notes"]


class NoteContent(Contract):
    """The only note data a provider may propose; trusted code adds identity."""

    title: Title
    body: Body


class ProviderReadiness(Contract):
    provider: Backend
    status: Literal[
        "unavailable", "not_configured", "auth_required", "incompatible", "ready", "error"
    ]
    evidence: tuple[str, ...] = ()
    version: str | None = None
    destination: str | None = None
    explanation: str


class ReasoningRequest(Contract):
    request_id: Identifier
    task_id: Identifier
    user_text: Annotated[ContextText, Field(max_length=32_000)]
    attached_context: AttachedContext = ()
    backend: Backend
    model: str | None = None
    deadline: AwareDatetime
    cancellation_id: Identifier


class TokenUsage(Contract):
    input_tokens: Annotated[int, Field(ge=0)] | None = None
    output_tokens: Annotated[int, Field(ge=0)] | None = None


class ReasoningResult(Contract):
    request_id: Identifier
    status: Literal["completed", "error", "cancelled"]
    text: str = ""
    proposal: NoteContent | None = None
    usage: TokenUsage | None = None


class ActionProposal(Contract):
    id: Identifier
    task_id: Identifier
    tool: Tool = "notes.create"
    arguments: NoteContent
    revision: Revision
    scope: Scope = "notes"


class Approval(Contract):
    """A stored binding; authorization still requires trusted-state verification."""

    id: Identifier
    task_id: Identifier
    proposal_id: Identifier
    tool: Tool = "notes.create"
    arguments: NoteContent
    arguments_hash: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    revision: Revision
    scope: Scope = "notes"
    policy_version: Identifier
    issued_at: AwareDatetime
    expires_at: AwareDatetime
    decision: Literal["pending", "approved", "rejected"]
    boot_id: Identifier


class ActionResult(Contract):
    task_id: Identifier | None = None
    operation_id: Identifier | None = None
    status: Literal["succeeded", "failed", "cancelled", "rejected", "needs_reconciliation"]
    note_id: Identifier | None = None
    diagnostic: str | None = None


class Note(NoteContent):
    id: Identifier
    created_at: AwareDatetime
    updated_at: AwareDatetime
    task_id: Identifier | None = None
