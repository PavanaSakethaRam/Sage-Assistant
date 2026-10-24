# Sage Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved desktop/core foundation with setup, a restricted Copilot text connection, reviewed local notes and measurable security/testing gates.

**Architecture:** Electron/React communicates with one Python core over private framed pipes. The core owns validated proposals, approval state and atomic SQLite note effects; a capability-restricted Copilot adapter supplies text/proposals. Provider runtime storage is isolated and disposable. Later coding/browser/calendar workflows attach to these contracts.

**Tech Stack:** Python 3.13, uv, Pydantic, SQLite/FTS5, supported Copilot Python SDK/runtime; Electron Forge/Vite, React/TypeScript; pytest/Hypothesis/coverage, Vitest/Testing Library, Playwright Electron and PyInstaller.

Forge's Vite integration and Playwright's Electron driver are documented as experimental. Pin compatible versions, keep an instrumented automation build separate from the final production build, and never weaken production protections merely to make the test driver attach. Production-package launch checks are a separate gate. [Forge template](https://www.electronforge.io/templates/vite-+-typescript), [Playwright Electron](https://playwright.dev/docs/api/class-electron).

**Spec:** [Approved foundation design](../specs/2026-10-22-sage-foundation-design.md); [complete delivery scope](../specs/2026-10-22-sage-delivery-scope.md).

## Global Constraints

- Python 3.13 is the supported baseline candidate; resolve compatible versions in isolation and commit exact `uv.lock`/`package-lock.json`. Do not install the original requirements or modify user-wide Python/Node/configuration.
- Production renderer: Node integration disabled, context isolation and sandbox enabled, restrictive CSP, packaged local UI and validated IPC senders.
- Private length-prefixed UTF-8 JSON IPC; 1 MiB maximum frame; protocol version, request ID and kind required; diagnostics on stderr.
- Note title: nonempty, at most 200 Unicode code points; Markdown body: nonempty, at most 100,000. User text: at most 32,000; attached context: at most 64,000 total. Reject NUL/inappropriate controls; preserve body tabs/newlines.
- Approval expires five minutes after issue, on backward clock anomaly, revision or restart. No model-generated approval; consume exact argument/revision/scope/policy binding atomically.
- Cancel/reject draft body removal is immediate; unreviewed drafts expire after 24 hours; task/status metadata after 30 days; saved notes persist until explicit deletion.
- Copilot: `mode="empty"`, no ambient built-ins/hooks/skills/MCP/plugins/subagents; unexpected permissions denied. No editor credential/history extraction or editor-private SDK imports.
- Local-AI mode never starts a cloud session or silently falls back. Missing local inference is visibly unavailable; local note controls remain usable.
- No raw HTML, remote Markdown images/media/previews/fonts or unsolicited renderer requests. External links require validated explicit user interaction.
- Deterministic suites require no real accounts, paid calls, microphone, screen permissions or signed-in browser. Live checks are separate and synthetic.
- Maintained code: at least 80% statements / 75% branches. Trusted domain/policy core: 90% statements / 85% branches, plus every documented critical decision case. Do not exclude dead maintained code to improve metrics.
- Preserve user state/configuration and unrelated editor workspaces. No external push, publication or history rewrite. No release claim without actual Windows/macOS/provider evidence.
- Each task ends with its focused tests, relevant type/lint checks, required dependency/security audits and a scoped local commit. Review the diff; use the established command-scoped Codex identity if user identity remains unset, preserving Git configuration.

## Review Focus

1. Combining marks/astral characters and the exact title/body limits: count Unicode code points consistently in Python and JavaScript; reject out-of-range input without truncating content (Tasks 1, 7).
2. A system clock moving backward during approval: invalidate the decision without changing a saved note (Task 3).
3. Disk full, locked SQLite and failed migration: preserve existing notes and show a recoverable failure (Tasks 2, 9).
4. Provider completion after Cancel/revision: discard it and keep the current draft; never revive approval or save (Tasks 5, 6, 7).
5. Provider crash leaving session files and Markdown tracking pixels: remove only Sage-owned residual content and render with zero unsolicited requests (Tasks 5, 7, 9).

---

## File map

| Files | Responsibility |
|---|---|
| `pyproject.toml`, `uv.lock`, `src/sage/__init__.py` | Maintained importable Python package and locked tooling |
| `src/sage/contracts.py`, `config.py`, `paths.py` | Closed message/domain schemas, routing settings and per-user directories |
| `src/sage/storage.py`, `migrations/001.sql` | SQLite schema/migration/transactions, notes/FTS and retention |
| `src/sage/actions.py` | Proposal revision, approval/cancellation and idempotent local note effect |
| `src/sage/protocol.py`, `service.py`, `__main__.py`, `logging.py` | Framing, closed RPC dispatch, owned lifecycle and safe diagnostics |
| `src/sage/providers/base.py`, `copilot.py`, `session_store.py` | Provider contract, supported restricted SDK adapter and disposable storage |
| `package.json`, `package-lock.json`, `forge.config.ts`, `vite.*.config.ts`, `tsconfig*.json` | Desktop build/development/test configuration |
| `desktop/main/{index,security,core-process,ipc}.ts`, `desktop/preload/index.ts` | Trusted host, fixed child supervision and narrow renderer API |
| `desktop/shared/contracts.ts`, `desktop/renderer/{App,Setup,Conversation,NoteReview,Notes,SafeMarkdown}.tsx`, `desktop/renderer/{main.tsx,styles.css,index.html}` | Typed UI, readiness, explicit review, notes and inert Markdown |
| `tests/{unit,integration,security,fixtures}`, `desktop/tests`, `e2e` | Deterministic, contract, negative-security and real-host tests |
| `scripts/{check_coverage.py,verify_security.py,build_core.py}`, `sage-core.spec` | Evidence gates and per-OS Python packaging |
| `.github/workflows/{verify,package}.yml`, `Readme.md`, `docs/testing.md`, `docs/security.md` | Local/CI commands, measured support matrix and operating limits |

Retire the old `main.py`, `modules/` tree, `requirements.txt`, root `config.json`, `example.py`, credential-containing `test.py` and unused demo images/templates after confirming no maintained code imports them. Git preserves the original audited snapshot; do not move the unsafe executable samples into a second active runtime. Keep audit reports/probes labeled historical.

## Task 1: Importable contracts and safe local mode

**Files:** Create `pyproject.toml`, `uv.lock`, `src/sage/{__init__,contracts,config,paths}.py`, `tests/unit/{test_contracts,test_config,test_imports}.py`, `tests/fixtures/contracts.json`; modify `.gitignore`; remove credential-containing root `test.py` before the first product-source commit.

**Interfaces:** Produce strict Pydantic `Settings`, `ProviderReadiness`, `ReasoningRequest`, `ReasoningResult`, `ActionProposal`, `Approval`, `ActionResult` and `Note`. `Settings.ai_mode` is `local | assistant | api`; `Settings.reasoning_backend` is optional and defaults to `None` for local mode. Define `Settings.validate_reasoning_destination(backend: str, url: str | None) -> None`, `app_paths(root_override: Path | None = None) -> AppPaths`. Fixed tool is `notes.create`; closed statuses match the spec. Proposal/note IDs use `.id`, proposal revisions `.revision`, result note identity `.note_id`; request identity is `.request_id`. IDs/revisions/arguments are generated/validated by trusted code.

- [ ] Remove the credential-containing root `test.py` without copying values anywhere; preserve history and record owner revocation triage as unresolved. Provision project-local Python 3.13 with uv, use task-local caches where sandboxing requires them, resolve only maintained runtime/dev packages and write lockfiles. No SDK initialization/model downloads. Ignore `.venv`, dependency/build output, runtime state, local credentials and test artifacts without hiding maintained source or lockfiles.
- [ ] Write failing parameterized tests named `test_note_limits`, `test_literal_unicode_and_controls`, `test_request_context_limits`, `test_extra_fields_rejected`, `test_local_mode_rejects_cloud_destination` and `test_import_is_inert`. Assertions include 200/201 and 100000/100001 code-point boundaries, emoji/combining marks, preserved tabs/newlines, rejected NUL, unknown tools/statuses and zero network/process/device/file-write calls during import.

  ```python
  assert Settings(ai_mode="local").reasoning_backend is None
  with pytest.raises(ValueError):
      Settings(ai_mode="local").validate_reasoning_destination("copilot", None)
  ```
- [ ] Run `uv run pytest tests/unit/test_contracts.py tests/unit/test_config.py tests/unit/test_imports.py -q`; expect failures for missing package/contracts, then implement only the specified interfaces and rerun to PASS. Use the same serialized examples later for TypeScript contract tests.
- [ ] Run strict Python type/lint checks and the resolved Python vulnerability audit; inspect and commit only Task 1 files. Candidate dependency incompatibility is reported and resolved before locking, not ignored.

## Task 2: Transactional state, note search and retention

**Files:** Create `src/sage/storage.py`, `src/sage/migrations/001.sql`, `tests/integration/test_storage.py`, `tests/integration/test_migrations.py`.

**Interfaces:** Consume Task 1 models. Produce `Store.open(path: Path) -> Store`, `Store.transaction() -> ContextManager[sqlite3.Connection]`, `Store.list_notes() -> list[Note]`, `Store.search_notes(query: str) -> list[Note]`, `Store.cleanup(now: datetime) -> None`, `Store.close() -> None`. Parameterized SQL and FTS input binding are mandatory. Schema holds settings/tasks/revisions/approvals/operations/notes and version metadata.

- [ ] Write failing `test_migration_preserves_notes`, `test_future_schema_refused_without_reset`, `test_failed_migration_rolls_back`, `test_parameterized_search`, `test_retention_boundaries` and `test_disk_or_busy_failure_preserves_data`. Assert cancelled bodies are absent, 24-hour/30-day boundaries and saved-note persistence. Inject failures at transaction boundaries; no real user-data directory.

  ```python
  assert fresh_store.list_notes() == []  # Fixture owns and closes the connection.
  # Fixtures seed a saved note, an expired draft and an old status record.
  store.cleanup(now)
  assert [note.id for note in store.list_notes()] == [saved_note.id]
  ```
- [ ] Run `uv run pytest tests/integration/test_storage.py tests/integration/test_migrations.py -q`; verify RED. Implement explicit startup/migration/cleanup, bounded SQLite busy handling and safe close. Keep application authorization in Task 3.
- [ ] Rerun to PASS, including temporary file-backed SQLite restart tests; compare exact saved content and schema version after failures.
- [ ] Run relevant type/lint/security audits, inspect SQL/diff and commit Task 2.

## Task 3: Exact approval and cancellation boundary

**Files:** Create `src/sage/actions.py`, `tests/security/test_authorization.py`, `tests/integration/test_note_recovery.py`.

**Interfaces:** Consume `Store` and Task 1 contracts. Produce `ActionService(store: Store, clock: Callable[[], datetime], boot_id: str)`, `propose_note(task_id: str, title: str, body: str) -> ActionProposal`, `revise_note(proposal_id: str, revision: int, title: str, body: str) -> ActionProposal`, `decide(proposal_id: str, revision: int, decision: Literal['save','cancel']) -> ActionResult`, `cancel_task(task_id: str) -> ActionResult`. Approval is internal, not a renderer-supplied model. Canonical JSON hashes preserve exact visible title/body.

- [ ] Write `test_denied_or_changed_request_has_zero_effects`, `test_expired_replayed_or_forged_approval`, `test_clock_rollback_and_restart_expire`, `test_duplicate_save_returns_same_note` and `test_cancel_before_commit`. Assert complete binding, a five-minute expiry and zero INSERT/effect calls for rejected inputs. Use transaction barriers/injected clocks, never timing sleeps.

  ```python
  proposal = actions.propose_note("task-1", "Title", "Body")
  actions.cancel_task("task-1")
  assert actions.decide(proposal.id, proposal.revision, "save").status in {"rejected", "cancelled"}
  assert store.list_notes() == []
  ```
- [ ] Write `test_crash_before_commit_leaves_no_note` and `test_crash_after_commit_recovers_same_outcome`; independently reopen SQLite and assert one note/operation after concurrent Save requests.
- [ ] Run `uv run pytest tests/security/test_authorization.py tests/integration/test_note_recovery.py -q` to RED, implement methods and rerun to PASS. Persist successful note and operation in one transaction; cancellation after commit reports the completed effect honestly.
- [ ] Temporarily bypass one approval check, confirm its negative test fails, restore it and record the sensitivity check. Run relevant quality/audit checks, inspect and commit Task 3.

## Task 4: Private protocol and reusable core service

**Files:** Create `src/sage/{protocol,service,__main__,logging}.py`, `tests/unit/test_protocol.py`, `tests/security/test_rpc.py`, `tests/integration/test_core_process.py`.

**Interfaces:** `encode_frame(message: dict[str, object]) -> bytes`; `async read_frame(reader: asyncio.StreamReader) -> dict[str, object]`; `ProtocolError(ValueError)`; `async CoreService.dispatch(message: dict[str, object]) -> dict[str, object]`; `async run_service(reader, writer, service: CoreService) -> None`. Prefix is a four-byte unsigned big-endian byte length. Version 1 permits only `settings.get/update`, `readiness.list`, `reasoning.start/cancel`, `notes.propose/revise/decide/list/search`, `tasks.cancel`, `app.shutdown`. Reasoning slots call the Task 5 contract; no generic method/tool passthrough.

- [ ] Write failing tests for 1 MiB/excess frames, incomplete prefixes/bodies, invalid UTF-8/JSON, duplicate/unknown IDs/kinds, extra fields, unsupported protocol/method, bounded inflight requests and broken pipes. Assert no action invocation for invalid input and no diagnostic bytes on stdout.

  ```python
  reader = asyncio.StreamReader()
  reader.feed_data((1_048_577).to_bytes(4, "big"))
  with pytest.raises(ProtocolError):
      await read_frame(reader)
  ```
- [ ] Add `test_sensitive_markers_absent_from_errors_and_logs` with synthetic provider exceptions/body/credential markers and `test_process_shutdown_releases_resources`. Default output includes safe IDs/status only; no prompt reflection.
- [ ] Run `uv run pytest tests/unit/test_protocol.py tests/security/test_rpc.py tests/integration/test_core_process.py -q` to RED, implement closed dispatch/framing/lifecycle and rerun to PASS. Set request deadlines/correlation and discard cancelled/revised late responses.
- [ ] Run relevant quality/audit checks, inspect and commit Task 4.

## Task 5: Restricted Copilot adapter and session cleanup

**Files:** Create `src/sage/providers/{__init__,base,copilot,session_store}.py`, `tests/unit/test_provider_contract.py`, `tests/security/test_provider_isolation.py`, `tests/integration/test_provider_sessions.py`, `tests/live/test_copilot_smoke.py`; update `pyproject.toml`/`uv.lock`.

**Interfaces:** `ReasoningBackend.readiness() -> ProviderReadiness`, `async reason(request: ReasoningRequest) -> ReasoningResult`, `async cancel(request_id: str) -> None`, `async aclose() -> None`; implement `CopilotReasoner`. `SessionStore.create(request_id: str) -> Path`, `cleanup(request_id: str) -> None`, `recover_cleanup() -> None` operate only inside a fixed Sage-owned disposable root. No dynamic provider/plugin imports.

- [ ] Confirm the public SDK v1.0.25 candidate and its matching managed runtime against official release/docs; pin a compatible released combination. Provision through supported checksum-verified setup, with no first-use silent download. Do not import the installed editor's private runtime. Verify Python 3.13 compatibility before final lock.
- [ ] Write failing `test_empty_mode_and_no_ambient_tools`, `test_unexpected_permissions_denied`, `test_only_attached_context_sent`, `test_no_model_call_from_readiness`, `test_local_mode_never_starts_cloud_client`, `test_auth_quota_timeout_and_malformed_output`, `test_late_cancelled_response_discarded` and `test_usage_unknown_is_not_zero`. Use a fake SDK boundary and explicit negative call assertions; never copy `approve_all` examples.

  ```python
  # fake_sdk records the actual arguments supplied to its client/session boundary.
  await backend.reason(request)
  assert fake_sdk.client_options["mode"] == "empty"
  assert fake_sdk.session_options["available_tools"] == []
  assert fake_sdk.effect_calls == []
  ```

  Installation/editor metadata alone cannot produce `ready`; require a successful explicitly initiated supported connection check and invalidate cached readiness on auth/runtime failure.
- [ ] Add session lifecycle tests for normal completion, cancellation, worker crash, read-only cleanup failure and app restart. Inspect synthetic artifacts only in the Sage-owned test root; assert no unrelated-session deletion and no surviving session text after successful cleanup. Supported storage controls must prevent content landing in ambient client history. If the runtime cannot satisfy this requirement, keep readiness incompatible and report the actual blocker; do not weaken approved retention silently.
- [ ] Run `uv run pytest tests/unit/test_provider_contract.py tests/security/test_provider_isolation.py tests/integration/test_provider_sessions.py -q` to RED, implement the adapter and rerun to PASS. Parse strictly validated note proposals; no proposal handler may save a note. Map errors to closed statuses without private content.
- [ ] Implement `tests/live/test_copilot_smoke.py` as opt-in only (`SAGE_LIVE_COPILOT=1`), one synthetic prompt, no workspace context, no retry, 30-second deadline and bounded output where supported. Inference/quota use occurs only on explicit live-test invocation. Exercise actual auth, empty-mode settings, cancellation and disposable session cleanup; default CI skips with an explicit reason.
- [ ] Run relevant checks/audits, inspect and commit Task 5. Record live checks separately; unavailable authentication is not a successful probe.

## Task 6: Sandboxed desktop host and fixed child supervision

**Files:** Create root desktop build files from the file map; `desktop/main/{index,security,core-process,ipc}.ts`, `desktop/preload/index.ts`, `desktop/shared/contracts.ts`, `desktop/tests/{security,core-process,contracts}.test.ts`.

**Interfaces:** Renderer receives only `window.sage.request(request: CoreRequest): Promise<CoreResponse>` and `window.sage.onProgress(handler): () => void`. Host exposes no raw IPC/secret getter. `startCore(options: { executable: string; dataDir: string }): CoreProcess` takes trusted deployment configuration, never renderer input; `CoreProcess.request` correlates IDs, `cancel` invalidates late work, `close` shuts down owned resources. Mirror Task 1/4 schemas with runtime validation.

- [ ] Lock maintained JS dependencies and write failing tests for disabled Node integration, enabled sandbox/isolation, local-only UI loading, invalid sender/frame/method rejection, 1 MiB boundaries, shared contract fixtures and a renderer attempt to choose an executable. Non-BMP length tests match Python code-point semantics.

  ```typescript
  expect(windowOptions.webPreferences).toMatchObject({
    nodeIntegration: false, contextIsolation: true, sandbox: true,
  });
  ```
- [ ] Add fixed-child lifecycle tests: sanitized environment, no unrelated credentials, wrong protocol, stderr redaction, child exit, bounded restart and late cancelled response. Development uses an explicit trusted project `.venv` executable; production uses only packaged resources.
- [ ] Run `npm run test:unit -- desktop/tests` to RED, implement minimum host/preload/protocol and rerun to PASS. Disable arbitrary navigation/windows and external resource loading. Keep development Vite access explicitly separated from packaged production behavior.
- [ ] Run `npm run typecheck`, lint and JS/Python dependency/security audits; inspect and commit Task 6.

## Task 7: Setup, typed conversation and reviewed notes UI

**Files:** Create `desktop/renderer` files from the map and `desktop/tests/{setup,conversation,note-review,safe-markdown}.test.tsx`.

**Interfaces:** `Setup` reads/saves `Settings` and readiness through the narrow host API. `Conversation` submits `ReasoningRequest` and handles status/cancel; `NoteReview` displays an `ActionProposal` and calls revise/decide with ID/revision only. `Notes` lists/searches saved notes. `SafeMarkdown({ text }: { text: string })` disables HTML/images/embeds/previews, validates links and requires an explicit external-open action through the trusted host.

- [ ] Write failing accessible-role tests for local/assistant/API choices, visible unavailable prerequisites, no collection of unsupported keys, quota disclosure before connection test, local note creation without a model and provider failure leaving note controls usable.
- [ ] Write full-content preview, keyboard Save/Cancel/Edit, Unicode boundaries, stale revision, pending/cancelled/completed states, cancelled late response and exact saved note tests. Never truncate displayed content without an accessible way to inspect all approved text.
- [ ] Add hostile Markdown fixtures: HTML/script, `file:`, `javascript:`, remote image/tracking URL and embedded media. Assert zero resource fetches, no privileged navigation/IPC and explicit validated clicks for allowed links.

  ```typescript
  render(<SafeMarkdown text={'![track](https://example.invalid/pixel)'} />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(outboundRequests).toEqual([]); // Also assert in the real-host E2E fixture.
  ```
- [ ] Run `npm run test:unit -- desktop/tests` to RED, implement the focused components/styles and rerun to PASS. Use a compact accessible conversation/task layout; no elaborate visual system or wake-word animation in the foundation.
- [ ] Run type/lint/security/audit checks, inspect and commit Task 7.

## Task 8: Retire unsafe legacy launch and dependencies

**Files:** Remove the remaining legacy files listed after the file map (`test.py` was already removed in Task 1); modify `Readme.md`, `.gitignore`; create `tests/security/test_release_surface.py`, `docs/security.md`.

**Interfaces:** No new runtime API. The maintained entrypoint is `python -m sage` under the locked environment and the Electron app; no old launcher is advertised or bundled. Historical audit links remain anchored to commit `c7943bd`.

- [ ] Write failing release-surface checks asserting maintained package/bundle imports contain no `modules.*`, old Windows/audio/social-send packages, voice-admin or raw keystroke paths. Ensure old credential sample files cannot ship. Synthetic markers test redacting scans; never embed original secret values.
- [ ] Run `uv run pytest tests/security/test_release_surface.py -q` to RED; remove retired files and current credential values, update instructions/support matrix and rerun to PASS. Preserve the Git history; do not claim credential revocation or rewrite history.
- [ ] Document historical credential triage as unresolved until owner confirmation, no current secret logging, actual session retention and local-mode boundaries. Remove unsupported license/capability claims rather than invent a license decision.
- [ ] Run current-tree/new-diff redacting secret scan, full maintained dependency audits and focused tests; inspect deletion scope and commit Task 8.

## Task 9: Real-host end-to-end and measurable quality gates

**Files:** Create `e2e/{foundation,recovery,security}.spec.ts`, `scripts/check_coverage.py`, `scripts/verify_security.py`, `tests/unit/test_coverage_gate.py`, `.gitleaks.toml`, `.github/workflows/verify.yml`, `docs/testing.md`; modify root test/quality configuration.

**Interfaces:** `check_coverage.py --python coverage.json --javascript coverage-summary.json` validates nonempty artifacts and both language thresholds plus explicit trusted domain/policy files (`contracts.py`, `config.py`, `storage.py`, `actions.py`). `verify_security.py` runs pip-audit on the complete locked Python environment, npm audit including build dependencies, Bandit and ESLint security rules, and redacting Gitleaks current-tree/new-diff scans; it returns nonzero for scan failure/untriaged gate violations and writes redacted machine-readable results. Exclude dependency/build directories from secret scanning, not entire maintained test/source trees. Scanner applicability exceptions require owner acceptance/expiry, never fabricated green status.

- [ ] Write failing coverage-gate tests for below/exact thresholds, missing/empty/malformed reports, uncovered critical-source files and rounding boundaries. Enforce statement and branch percentages separately. Collect all maintained source; exclude only declared generated/vendor/build artifacts.
- [ ] Write actual Electron/preload/Python tests using temporary app-data and a fake provider: launch, create/review/save/edit/cancel note, restart/read content, quota/error state, provider crash, invalid IPC, safe Markdown no-network rendering and cancelled late result. Assert real database/UI state and no forbidden executor calls. Simulate disk-full/locked-db/migration errors and verify recovery without destructive resets.
- [ ] Run `npm run test:e2e` to RED, implement only missing integration wiring and rerun to PASS. Tests disable outbound model requests, run no real SDK authentication and never touch user app-data/editor accounts.
- [ ] Configure Windows/macOS CI jobs: `uv sync --locked`, `npm ci`, Python unit/integration/security with branch coverage, JS unit coverage, type/lint/static checks, real-host E2E and redacting current-tree/new-diff secret/dependency scans. Pin official CI actions to verified immutable release commits during implementation. Provide no repository secrets to PR tests; network installs/scans are separate from deterministic execution.
- [ ] Execute `uv run pytest --cov=sage --cov-branch --cov-report=json`, `npm run test:coverage`, `npm run test:e2e`, `npm run verify`; require all PASS and completed security reports. Demonstrate egress-guard sensitivity as in Task 3. Inspect artifacts/diff and commit Task 9.

## Task 10: Per-platform package and release evidence

**Files:** Create `sage-core.spec`, `scripts/build_core.py`, `.github/workflows/package.yml`; modify `forge.config.ts`, `Readme.md`, `docs/testing.md`, `docs/security.md`; create `docs/validation/foundation-results.md`.

**Interfaces:** `build_core.py --output PATH` produces an OS-native application-directory Python bundle with `python -m sage` semantics. Forge packages that fixed core under application resources; shell/core protocol mismatch fails visibly. Release metadata includes exact versions, dependency/native notices and SBOMs. No automatic updater/publish step.

- [ ] Write package-manifest checks that fail if legacy modules, dev credentials, prompts/private test state, unsupported native libraries or a missing core executable enter the release. Confirm SDK runtime/checksums and required native/session assets are included through a supported packaging path; no runtime download on clean launch.
- [ ] Build separately on Windows/macOS with locked dependencies and the selected compatible PyInstaller/Forge versions. Run the packaged note/restart smoke without developer Python, plus missing/mismatched-core and unavailable credential-store failures. Sign/notarize only with explicitly available owner credentials; otherwise label local artifacts unsigned and keep signing readiness incomplete.
- [ ] Run opt-in Copilot synthetic smoke using the supported account path in a disposable Sage state directory, given the owner's integration authorization. If separate login is required, show the supported flow for the user; never extract the editor's token. Record actual auth/version/empty-mode/cancellation/session-cleanup evidence or the precise failed prerequisite.
- [ ] Record passed/failed/skipped checks, local hardware/OS, dependency scans, coverage and unfinished live/platform gates in `foundation-results.md`. This Mac cannot certify Windows; require Windows runner/clean-machine evidence before a parity claim. Keep unsupported integrations visibly unavailable. Existing Graphify output remains explicitly the original audited corpus until a scoped maintained-source update is generated.
- [ ] Run final `npm run verify` and package checks, independent whole-change code/security review, and address findings with focused regression tests. Inspect the complete diff and commit the foundation. Do not push/publish or declare all three demos complete.

## Self-review and execution handoff

Spec coverage map: sections 1–2 → Tasks 1, 3, 6–7; section 3 → Tasks 2, 4, 6, 10; section 4 → Tasks 1–4, 7, 9; section 5 → Task 5; section 6 → Task 8; sections 7–8 → Tasks 9–10 plus each task's negative cases. The five Review Focus conditions are assigned above. Deferred provider, voice, VS Code, browser and organizer workflows remain in the approved delivery scope.

The plan introduces no generic replay engine or autonomous coding executor. All cross-task interface names are defined above; disposable state is separate from durable notes and provider credentials. A failure to meet SDK storage/restriction contracts is a reported blocker, not permission to silently relax the spec. Exact compatible dependency pins and environment-specific evidence are execution results, not claims made by this plan.

Recommended execution: **Subagent-driven**, because the approval/storage, provider isolation and privileged desktop boundaries each need independent review before dependent work proceeds. The owner must review this plan and select/confirm the execution method before implementation begins, as required by the invoked workflow.
