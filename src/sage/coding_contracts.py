"""Closed coding values. Parsing never grants workspace or process authority."""

import hashlib
import json
import re
import unicodedata
from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, AwareDatetime, BeforeValidator, Field, model_validator

from sage.contracts import Contract
from sage.protocol import RpcId

MAX_SAFE_INTEGER = 9_007_199_254_740_991
FocusName = Literal["index.html", "focus.js", "focus.test.mjs", "README.md"]
CodeMode = Literal["create_focus_project", "replace_focus_file"]
CodeScope = Literal["code.create", "code.replace", "code.test"]
CodeState = Literal[
    "context_ready",
    "proposing",
    "review_required",
    "applying",
    "applied_saved",
    "applied_unsaved",
    "needs_review",
    "test_review",
    "testing",
    "completed",
    "rejected",
    "cancelled",
    "failed",
    "partial",
    "interrupted",
    "needs_reconciliation",
]
Hash = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
SafeInt = Annotated[int, Field(strict=True, ge=0, le=MAX_SAFE_INTEGER)]
Revision = Annotated[int, Field(strict=True, ge=1, le=MAX_SAFE_INTEGER)]
SafeDiagnostic = Literal[
    "invalid_context",
    "stale_context",
    "provider_unavailable",
    "provider_error",
    "effect_failed",
    "test_failed",
    "interrupted",
    "expired",
    "reconciliation_required",
]
FileStatus = Literal[
    "created",
    "applied_saved",
    "applied_unsaved",
    "needs_review",
    "partial",
    "needs_reconciliation",
]
TestStatus = Literal[
    "passed",
    "failed",
    "cancelled",
    "changed_during_test",
    "unknown",
    "termination_unconfirmed",
]
TEST_ARGV = ("--test", "--test-isolation=none", "--test-reporter=tap", "focus.test.mjs")
FOCUS_NAMES = ("index.html", "focus.js", "focus.test.mjs", "README.md")


def _literal(value: str) -> str:
    if any(unicodedata.category(char) in {"Cc", "Cs"} and char not in "\t\n\r" for char in value):
        raise ValueError("Unsupported text")
    return value


def _source(value: str) -> str:
    _literal(value)
    if value.startswith("\ufeff") or "\r" in value or len(value) > 32_000:
        raise ValueError("Unsupported source")
    return value


def _prompt(value: str) -> str:
    if len(value) > 32_000:
        raise ValueError("Prompt too long")
    return _literal(value)


def _explanation(value: str) -> str:
    if len(value) > 2_000:
        raise ValueError("Explanation too long")
    return _literal(value)


def _model(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", value):
        raise ValueError("Invalid model")
    return _literal(value)


SourceText = Annotated[str, AfterValidator(_source)]
PromptText = Annotated[str, AfterValidator(_prompt)]
ExplanationText = Annotated[str, AfterValidator(_explanation)]
ModelName = Annotated[str, AfterValidator(_model)]
DiagnosticText = Annotated[str, AfterValidator(_literal)]


def _utc(value: object) -> datetime:
    if isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)", value
    ):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("Expected UTC timestamp")
    offset = value.utcoffset()
    if offset is None or offset.total_seconds() != 0:
        raise ValueError("Expected UTC timestamp")
    return value


UtcDateTime = Annotated[AwareDatetime, BeforeValidator(_utc)]


def _tuple(value: object) -> object:
    return tuple(value) if isinstance(value, list) else value


def _bounded(value: Contract) -> None:
    body = value.model_dump_json().encode("utf-8")
    if len(body) > 1_048_576:
        raise ValueError("Coding frame too large")


def _distinct(names: tuple[FocusName, ...]) -> None:
    if len(set(names)) != len(names):
        raise ValueError("Duplicate source name")


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def literal_hash(text: str) -> str:
    """Hash literal UTF-8 bytes; consumers compare with their trusted snapshots."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class CodeBinding(Contract):
    job_id: RpcId
    boot_id: RpcId
    pair_id: RpcId
    window_id: RpcId
    root_id: RpcId
    revision: Revision
    policy_version: Literal["code-v1"]


class CodeSource(Contract):
    name: FocusName
    text: SourceText


class CodeFile(CodeSource):
    text_hash: Hash
    disk_hash: Hash
    document_version: SafeInt
    file_id: RpcId


class CodeContext(Contract):
    binding: CodeBinding
    mode: CodeMode
    root_uri: Annotated[str, Field(min_length=1, max_length=4096), AfterValidator(_literal)]
    root_file_id: RpcId
    files: Annotated[tuple[CodeFile, ...], BeforeValidator(_tuple)]
    diagnostics: Annotated[tuple[DiagnosticText, ...], BeforeValidator(_tuple)] = ()
    context_hash: Hash
    target: FocusName | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def check_snapshot(self) -> Self:
        names = tuple(file.name for file in self.files)
        _distinct(names)
        if len(self.diagnostics) > 64_000:
            raise ValueError("Too many diagnostics")
        if self.mode == "create_focus_project":
            if names or "target" in self.model_fields_set:
                raise ValueError("Create context must be empty")
        elif not 1 <= len(names) <= 4 or self.target not in names:
            raise ValueError("Replacement target must be selected")
        metadata = len(self.mode) + (len(self.target) if self.target else 0)
        if (
            sum(len(file.text) + len(file.name) for file in self.files)
            + sum(len(item) for item in self.diagnostics)
            + metadata
            > 64_000
        ):
            raise ValueError("Selected disclosure exceeds limit")
        _bounded(self)
        return self


def context_hash(context: CodeContext) -> str:
    material = context.model_dump(mode="json", exclude={"context_hash"})
    # The absent create target has a fixed null slot in the canonical hash.
    material["target"] = context.target
    material["lengths"] = {
        "root_uri": len(context.root_uri),
        "files": [{"name": len(file.name), "text": len(file.text)} for file in context.files],
        "diagnostics": [len(item) for item in context.diagnostics],
    }
    return hashlib.sha256(_canonical_json(material)).hexdigest()


class CodeDraft(Contract):
    job_id: RpcId
    revision: Revision
    account_generation: Revision
    user_text: PromptText
    backend: Literal["copilot"]
    model: ModelName | None = None

    @model_validator(mode="after")
    def check_frame(self) -> Self:
        _bounded(self)
        return self


class CodeStart(CodeDraft):
    disclosure_hash: Hash


class CodeModelRequest(CodeStart):
    request_id: RpcId
    deadline: UtcDateTime
    mode: CodeMode
    files: Annotated[tuple[CodeSource, ...], BeforeValidator(_tuple)]
    diagnostics: Annotated[tuple[DiagnosticText, ...], BeforeValidator(_tuple)] = ()
    target: FocusName | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def check_request(self) -> Self:
        names = tuple(file.name for file in self.files)
        _distinct(names)
        if self.mode == "create_focus_project":
            if names or "target" in self.model_fields_set:
                raise ValueError("Invalid create disclosure")
        elif not 1 <= len(names) <= 4 or self.target not in names:
            raise ValueError("Invalid replacement disclosure")
        if (
            len(names) > 4
            or len(self.diagnostics) > 64_000
            or sum(len(file.name) + len(file.text) for file in self.files)
            + sum(len(item) for item in self.diagnostics)
            + len(self.mode)
            + len(self.target or "")
            > 64_000
        ):
            raise ValueError("Model disclosure exceeds limit")
        _bounded(self)
        return self


class CodeProposal(Contract):
    job_id: RpcId
    revision: Revision
    explanation: ExplanationText
    files: Annotated[tuple[CodeSource, ...], BeforeValidator(_tuple)]

    @model_validator(mode="after")
    def check_files(self) -> Self:
        names = tuple(file.name for file in self.files)
        _distinct(names)
        if (
            not 1 <= len(names) <= 4
            or sum(len(file.name) + len(file.text) for file in self.files) > 64_000
        ):
            raise ValueError("Invalid proposed source")
        _bounded(self)
        return self


def parse_code_proposal(value: object, context: CodeContext) -> CodeProposal:
    proposal = CodeProposal.model_validate(value)
    if (proposal.job_id, proposal.revision) != (context.binding.job_id, context.binding.revision):
        raise ValueError("Proposal binding mismatch")
    names = tuple(file.name for file in proposal.files)
    if context.mode == "create_focus_project":
        if len(names) != 4 or set(names) != set(FOCUS_NAMES):
            raise ValueError("Create proposal must contain four fixed files")
    elif names != (context.target,):
        raise ValueError("Replacement proposal must contain the selected target")
    return proposal


def provider_context(context: CodeContext) -> tuple[CodeSource, ...]:
    return tuple(CodeSource(name=file.name, text=file.text) for file in context.files)


class CodeHashRecord(Contract):
    name: FocusName
    source_hash: Hash | None
    proposed_hash: Hash | None
    observed_hash: Hash | None


class CodeReceiptBase(Contract):
    binding: CodeBinding
    operation_id: RpcId
    effect_id: RpcId
    ordinal: SafeInt
    expected_hash: Hash


class CodeFileReceipt(CodeReceiptBase):
    scope: Literal["code.create", "code.replace"]
    target: FocusName
    status: FileStatus
    observed_hash: Hash | None = None
    observed_length: SafeInt | None = None

    @model_validator(mode="after")
    def check_status(self) -> Self:
        allowed = (
            {"created", "partial", "needs_reconciliation"}
            if self.scope == "code.create"
            else {"applied_saved", "applied_unsaved", "needs_review", "needs_reconciliation"}
        )
        if self.status not in allowed:
            raise ValueError("Invalid file effect status")
        return self


class CodeTestReceipt(CodeReceiptBase):
    scope: Literal["code.test"]
    status: TestStatus
    environment_hash: Hash
    executable_hash: Hash
    executable_version: ModelName
    exit_code: (
        Annotated[int, Field(strict=True, ge=-MAX_SAFE_INTEGER, le=MAX_SAFE_INTEGER)] | None
    ) = None
    signal: Annotated[str, Field(max_length=32), AfterValidator(_literal)] | None = None
    cancel_requested: bool
    timeout: bool
    overflow: bool
    output_digest: Hash | None = None


CodeReceipt = Annotated[CodeFileReceipt | CodeTestReceipt, Field(discriminator="scope")]


def parse_code_receipt(value: object) -> CodeFileReceipt | CodeTestReceipt:
    if not isinstance(value, dict):
        raise ValueError("Invalid coding receipt")
    if value.get("scope") == "code.test":
        return CodeTestReceipt.model_validate(value)
    return CodeFileReceipt.model_validate(value)


class CodeJobView(Contract):
    binding: CodeBinding
    mode: CodeMode
    state: CodeState
    destination: Annotated[str, Field(min_length=1, max_length=200), AfterValidator(_literal)]
    account: Annotated[str, Field(min_length=1, max_length=100), AfterValidator(_literal)] | None
    model: ModelName | None
    account_generation: Revision
    context_hash: Hash
    file_count: Annotated[int, Field(strict=True, ge=0, le=4)]
    manifest: Annotated[tuple[FocusName, ...], BeforeValidator(_tuple)]
    hashes: Annotated[tuple[CodeHashRecord, ...], BeforeValidator(_tuple)]
    source_codepoints: SafeInt
    diagnostics_codepoints: SafeInt
    metadata_codepoints: SafeInt
    expires_at: UtcDateTime
    diagnostic: SafeDiagnostic | None
    receipts: Annotated[tuple[CodeReceipt, ...], BeforeValidator(_tuple)]
    target: FocusName | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def check_metadata(self) -> Self:
        if (
            self.file_count != len(self.manifest)
            or len(self.hashes) > 4
            or len(self.receipts) > 100
        ):
            raise ValueError("Invalid manifest count")
        _distinct(self.manifest)
        hash_names = tuple(row.name for row in self.hashes)
        _distinct(hash_names)
        if self.mode == "create_focus_project":
            if self.file_count or "target" in self.model_fields_set:
                raise ValueError("Create view has selected files")
            if self.hashes and (
                set(hash_names) != set(FOCUS_NAMES)
                or any(row.source_hash is not None for row in self.hashes)
            ):
                raise ValueError("Invalid create hash records")
        elif not 1 <= self.file_count <= 4 or self.target not in self.manifest:
            raise ValueError("Replacement view target missing")
        elif hash_names != self.manifest:
            raise ValueError("Invalid replacement hash manifest")
        if self.source_codepoints + self.diagnostics_codepoints + self.metadata_codepoints > 64_000:
            raise ValueError("Disclosure count exceeds limit")
        _bounded(self)
        return self


def disclosure_hash(view: CodeJobView, draft: CodeDraft | dict[str, object]) -> str:
    draft = CodeDraft.model_validate(draft)
    if (draft.job_id, draft.revision, draft.account_generation, draft.model) != (
        view.binding.job_id,
        view.binding.revision,
        view.account_generation,
        view.model,
    ):
        raise ValueError("Disclosure binding mismatch")
    material = {
        "context_hash": view.context_hash,
        "user_text": draft.user_text,
        "revision": draft.revision,
        "backend": draft.backend,
        "model": draft.model,
        "destination": view.destination,
        "account": view.account,
        "account_generation": draft.account_generation,
        "lengths": {
            "context_hash": len(view.context_hash),
            "user_text": len(draft.user_text),
            "destination": len(view.destination),
            "account": len(view.account or ""),
            "model": len(draft.model or ""),
        },
    }
    return hashlib.sha256(_canonical_json(material)).hexdigest()


class CodeGrant(Contract):
    binding: CodeBinding
    grant_boot_id: RpcId
    scope: CodeScope
    operation_id: RpcId
    approved_hash: Hash
    issued_at: UtcDateTime
    expires_at: UtcDateTime
    consumed_at: UtcDateTime | None = None


class TestFileHash(Contract):
    name: FocusName
    hash: Hash


class TestRecipe(Contract):
    platform: Literal["darwin", "win32"]
    executable: Annotated[str, Field(min_length=1, max_length=4096), AfterValidator(_literal)]
    executable_identity: RpcId
    executable_hash: Hash
    executable_version: ModelName
    argv: Annotated[tuple[str, str, str, str], BeforeValidator(_tuple)]
    cwd: Annotated[str, Field(min_length=1, max_length=4096), AfterValidator(_literal)]
    root_id: RpcId
    environment: dict[str, str]
    file_hashes: Annotated[tuple[TestFileHash, ...], BeforeValidator(_tuple)]
    deadline: UtcDateTime
    output_cap: Literal[262144]
    recipe_hash: Hash

    @model_validator(mode="after")
    def check_recipe(self) -> Self:
        if self.argv != TEST_ARGV or tuple(row.name for row in self.file_hashes) != FOCUS_NAMES:
            raise ValueError("Invalid fixed test recipe")
        if not all(
            path.startswith("/")
            if self.platform == "darwin"
            else bool(re.fullmatch(r"[A-Za-z]:\\.+", path))
            for path in (self.executable, self.cwd)
        ):
            raise ValueError("Recipe paths must be absolute")
        if (
            self.environment.get("PATH") != ""
            or not all(
                key
                in {
                    "PATH",
                    "TEMP",
                    "TMP",
                    "TMPDIR",
                    "SystemRoot",
                    "WINDIR",
                    "SystemDrive",
                    "HOME",
                    "HOMEDRIVE",
                    "HOMEPATH",
                    "LOGONSERVER",
                    "USERDOMAIN",
                    "USERNAME",
                    "USERPROFILE",
                }
                for key in self.environment
            )
            or len({key.upper() for key in self.environment}) != len(self.environment)
        ):
            raise ValueError("Invalid environment")
        if any(
            len(value) > 4096 or _literal(value) != value for value in self.environment.values()
        ):
            raise ValueError("Invalid environment value")
        if self.platform == "darwin":
            if any(
                key in self.environment
                for key in (
                    "HOME",
                    "HOMEDRIVE",
                    "HOMEPATH",
                    "LOGONSERVER",
                    "USERDOMAIN",
                    "USERNAME",
                    "USERPROFILE",
                )
            ):
                raise ValueError("Mac environment contains identity")
        else:
            if any(
                self.environment.get(key) != ""
                for key in (
                    "HOME",
                    "HOMEDRIVE",
                    "HOMEPATH",
                    "LOGONSERVER",
                    "USERDOMAIN",
                    "USERNAME",
                    "USERPROFILE",
                )
            ):
                raise ValueError("Windows identity must be blank")
        if any(not self.environment.get(key) for key in ("TEMP", "TMP", "TMPDIR")):
            raise ValueError("Owned temporary path missing")
        _bounded(self)
        return self


def recipe_hash(recipe: TestRecipe) -> str:
    material = recipe.model_dump(mode="json", exclude={"recipe_hash"})
    material["lengths"] = {
        "executable": len(recipe.executable),
        "cwd": len(recipe.cwd),
        "argv": [len(item) for item in recipe.argv],
        "environment": {key: len(value) for key, value in recipe.environment.items()},
    }
    return hashlib.sha256(_canonical_json(material)).hexdigest()


class CodeFileIntent(CodeReceiptBase):
    scope: Literal["code.create", "code.replace"]
    target: FocusName


class CodeTestIntent(CodeReceiptBase):
    scope: Literal["code.test"]
    recipe: TestRecipe


CodeIntent = Annotated[CodeFileIntent | CodeTestIntent, Field(discriminator="scope")]


def parse_code_intent(value: object) -> CodeFileIntent | CodeTestIntent:
    if not isinstance(value, dict):
        raise ValueError("Invalid coding intent")
    if value.get("scope") == "code.test":
        return CodeTestIntent.model_validate(value)
    return CodeFileIntent.model_validate(value)


class CodeReview(Contract):
    binding: CodeBinding
    scope: CodeScope
    approved_hash: Hash
    decision: Literal["accept", "reject"]


class CodeGrantResult(Contract):
    kind: Literal["grant"]
    grant: CodeGrant


class CodeJobResult(Contract):
    kind: Literal["job"]
    job: CodeJobView


class CodeReceiptResult(Contract):
    kind: Literal["receipt"]
    receipt: CodeReceipt


CodeReviewResult = Annotated[
    CodeGrantResult | CodeJobResult | CodeReceiptResult, Field(discriminator="kind")
]


class CodeAck(Contract):
    operation_id: RpcId
    effect_id: RpcId
    status: Literal["recorded", "duplicate", "conflict"]
    recorded_hash: Hash | None = None

    @model_validator(mode="after")
    def check_ack(self) -> Self:
        if (self.recorded_hash is None) != (self.status == "conflict"):
            raise ValueError("Invalid durable acknowledgment")
        return self


class CodePage(Contract):
    limit: Annotated[int, Field(strict=True, ge=1, le=100)] = 20
    offset: Annotated[int, Field(strict=True, ge=0, le=1_000_000)] = 0


class CodeJobPage(Contract):
    items: Annotated[tuple[CodeJobView, ...], BeforeValidator(_tuple)]
    next_offset: Annotated[int, Field(strict=True, ge=0, le=1_000_000)] | None

    @model_validator(mode="after")
    def check_page(self) -> Self:
        if len(self.items) > 100:
            raise ValueError("Page exceeds limit")
        _bounded(self)
        return self
