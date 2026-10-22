# Sage foundation and controlled provider connection

Date: 22 October 2026. Status: approved by the owner on 22 October 2026; implementation planning may proceed. Scope: delivery slice 1 in [the delivery scope](2026-10-22-sage-delivery-scope.md). The owner approved the architecture direction and requested implementation, strong tests and security validation. This document makes the first deliverable concrete.

## 1. Outcome and scope

A clean desktop launch presents setup, typed interaction, capability readiness and a local task view. Users can create a reviewed local note without an online model. A supported Copilot connection can answer a bounded text request and propose that same note action; it receives no ambient shell, filesystem, browser, calendar or MCP tools. Local state persists across restart. The same domain code and deterministic suite run on macOS and Windows.

This foundation earns the interfaces used by later demos. It does not claim working coding delegation, live voice, browser perception, reminders, calendar writes or every provider. All requested setup choices are represented honestly; only validated integrations are enabled. A selectable disabled option explains its prerequisite/implementation status without collecting credentials it cannot use.

## 2. User flows

### First launch

1. Choose **Local AI only**, **Connect an assistant**, or **Use an API key**. Saved configuration contains preferences and opaque secret references, never raw credentials.
2. The local choice allows typed forms/commands and notes immediately. Model-backed free-form replies require a configured, verified local runtime; otherwise the UI says “Local model not configured”. This is a valid basic mode, not advertised offline AI.
3. The assistant choice lists Copilot, Codex, OpenCode and Claude with readiness states. Copilot is the first connection implemented. Use its supported authentication flow and SDK/runtime interface, never the editor's private credentials or chat history. VS Code sign-in is useful context but is not an SDK readiness check.
4. API-key configuration is enabled only for an implemented provider adapter. Other options remain visible as unavailable; the UI never stores an unusable secret. A direct API adapter and the complete local model/voice path remain required subsequent work in the delivery scope.
5. Show available actions, inference destination and explicit **Test connection**. Discovery/version checks do not perform paid inference. A connection test sends a fixed synthetic short prompt with no project files or personal context and uses bounded output/deadline; show that it uses provider quota before the user initiates it.

### Typed request and local note

Typed interaction can submit text to a ready reasoning backend, or use explicit “New note” controls without one. A response can propose `notes.create` with a title and Markdown body. Display complete proposed content. **Save**, **Cancel** and **Edit** are UI actions; a model response cannot press Save or create approval. Editing creates a new revision and invalidates the old approval.

On Save, revalidate the bound request and authorization, persist the note and successful operation atomically, and return the note ID. Show the saved note and outcome. Note bodies render as untrusted Markdown: raw HTML, images, media embeds and automatic link previews are disabled. Links are restricted to safe schemes and open externally only on an explicit validated user click. Rendering causes no unsolicited network request. Model output cannot navigate the privileged application, load local files or invoke IPC.

### Cancellation, failure and restart

Cancel invalidates unconsumed approval and stops new steps. An in-flight provider request is cancelled where supported; a late response for a cancelled/revised request is discarded. Cancelling a completed note does not delete it. A provider failure leaves typed local controls usable.

On restart, local notes, task outcomes and unresolved approvals remain visible. Unconsumed approvals expire at restart and require a fresh explicit Save. An incomplete inference is marked interrupted and is never silently resubmitted. There are no external-effect retries in this slice.

## 3. Application and data boundaries

### Desktop

Use Electron, React, TypeScript and Vite with packaged local UI. Production renderer: Node integration disabled, context isolation and sandbox enabled, restrictive CSP, navigation/new-window handlers restricted, validated IPC senders and a small preload API. Development tools and remote content never receive the trusted API. Untrusted Markdown cannot load external images, embeds, fonts or previews. Links open only after scheme validation and explicit user interaction through the host.

Electron main supervises one fixed packaged Python executable and brokers OS-protected credential operations. No arbitrary executable path, shell expression, generic file operation or generic IPC passthrough is accepted from a renderer message. Version mismatches and child crashes become visible failures with bounded restart attempts, not restart loops.

### Core

Use supported Python 3.13 as the baseline candidate, `asyncio`, Pydantic, SQLite and the supported Copilot Python SDK. Pin resolved compatible versions during implementation. Importing core performs no model load, device capture, platform automation, subprocess launch, network request or database write. Separate explicit startup and shutdown own resources.

Use one modular application. Normal typed functions implement built-in tools. No plugin loader, generic tool registry language, dependency-injection framework or second orchestration engine is required. LangGraph enters before slice 4's restart-resumable cross-app workflow; foundation note transactions do not need graph replay.

### IPC

Private stdin/stdout pipes carry length-prefixed UTF-8 JSON with a 1 MiB maximum frame. Stderr carries redacted diagnostics. Every message includes protocol version, request ID and kind. Define closed schemas for request, response, progress and error. Reject invalid kinds/fields/lengths/versions and uncorrelated responses. Bound outstanding requests, apply deadlines and propagate cancellation; no serialized Python objects or executable expressions.

### Storage

Store runtime data in per-user application data directories, outside the repository. SQLite migrations are versioned and transactional; reject unsupported future schemas rather than truncating/recreating user data. A migration failure preserves the original database and produces a usable diagnostic. Use bounded busy handling for concurrent requests.

Initial domain records: configuration, task/request, action revision, approval, operation attempt/outcome and note. A note includes immutable ID, title/body, timestamps and provenance referencing the task when applicable. No automatic personal-memory extraction or raw transcript archive. Persist only text needed to recover a pending/reviewed note. Rejected/cancelled draft bodies are removed immediately; unreviewed draft bodies expire after 24 hours and are cleaned at startup and while running. Task/status metadata is retained for 30 days; saved notes persist until an explicit user deletion. Ordinary reasoning input/output is session-only unless the user explicitly saves it.

Use SQLite/FTS5 for saved-note search. Notes are data, never privileged instructions. Foundation export/backup is out of scope; do not imply database encryption. API/refresh credentials belong in the OS-protected store, with only opaque references in SQLite.

## 4. Contracts and security invariants

Use closed enums and validated models rather than arbitrary tool names:

| Contract | Required meaning |
|---|---|
| `ProviderReadiness` | `unavailable`, `not_configured`, `auth_required`, `incompatible`, `ready`, or `error`; evidence/version/destination and explanation accompany status |
| `ReasoningRequest` | request/task IDs, bounded user text, explicitly attached context, selected backend/model, deadline and cancellation identity |
| `ReasoningResult` | text and optionally a validated note proposal; usage may be unknown; completion/error/cancellation is explicit |
| `ActionProposal` | fixed tool ID `notes.create`, fully validated title/body, revision and scope; no model-supplied approval |
| `Approval` | opaque random ID bound to task, tool, complete normalized arguments/hash, revision, policy version, expiry and UI decision |
| `ActionResult` | `succeeded`, `failed`, `cancelled`, `rejected`, or `needs_reconciliation`, plus stable operation/note identifiers and safe diagnostics |

The trusted host/core validates UI approval requests against current task state. Approval expires five minutes after issue, on a backward clock anomaly, on revision or on app restart, whichever comes first. Never accept a model/renderer-created approval object as proof of authorization. A renderer is not an arbitrary tool caller; sender validation and request correlation complement explicit user approval but do not defend a compromised trusted host.

**No executor call** occurs after deny, expiry, replay, cancellation, changed content/title/scope, stale revision or incompatible tool/policy version. Consume approval and create the operation record atomically. For the local SQLite note effect, insertion and successful outcome share one transaction; a crash before commit leaves no saved note. Duplicate requests return the existing outcome only after identity validation. Exactly-once external-effect guarantees are not claimed.

Tool input constraints: nonempty title up to 200 Unicode code points and Markdown body up to 100,000; reject NUL and inappropriate control characters while preserving tabs/newlines in the body. Reasoning user text is bounded to 32,000 code points and explicitly attached context to 64,000 total. No caller-supplied filesystem path or executable templates. Explicit forms preserve literal user text. This slice has no free-form transcript-to-command parser or generic shell tool.

All defaults omit prompt/body/credentials from logs and diagnostics. Error redaction also applies to provider exceptions, subprocess stderr and UI diagnostics. Test synthetic private markers, not real credentials. Model output and retrieved text cannot change routing, approve actions, install tools or authorize new context.

## 5. Copilot and routing

Use a pinned supported SDK/runtime combination. Provision the managed runtime explicitly during approved development/setup, record versions and verify official checksums where supplied. Do not depend on VS Code's private embedded runtime or silently download a runtime on the first demonstration.

Use the SDK's supported user authentication/authorization path. Sage never opens credential stores belonging to VS Code/Copilot to extract tokens. The SDK may manage its own supported account state; Sage reports the effective account through supported metadata, without displaying tokens. Signing into a new account or expanding scopes is visible to the user.

For foundation reasoning, configure `mode="empty"`, an empty built-in tool set and only an explicitly registered note-proposal interface if needed. Prefer schema-constrained proposal output where supported; otherwise strictly validate and reject unparseable output. No ambient skills, hooks, project instructions, plugins, MCP servers, shell, filesystem access or subagents. Unexpected permission requests are denied and reported. Verify the actual pinned runtime contract; documentation alone is insufficient evidence.

Cloud reasoning sends only current text and explicitly attached context. No active-editor harvesting, home-directory scan, current-working-directory upload or existing chat import. A proposal handler returns data to the UI; it cannot save notes directly. Model tokens/quota and voice billing remain separate.

Session-only retention must include the provider runtime. Configure isolated Sage-owned disposable session storage using supported SDK/runtime filesystem and persistence controls; do not write conversation content to another client's default history. Empty mode and `disconnect()` alone do not establish ephemeral storage. End a session using its supported deletion/cleanup semantics, and clean Sage-owned residual session content on orderly exit and next startup after a crash. Scope cleanup to Sage's disposable session artifacts; preserve credentials and unrelated user sessions. Test actual artifact locations and cleanup with synthetic markers. If the pinned runtime cannot meet this contract, mark the connection unavailable until the storage policy is explicitly revised. Cloud-provider retention is disclosed separately; this is not a zero-retention or forensic-erasure claim. [Provider persistence semantics](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence).

**Local AI only** prevents starting cloud SDK sessions and rejects any nonlocal reasoning destination, fallback, cloud embedding or cloud speech path. Loopback model endpoints must refer to a reviewed local runtime/model configuration; a proxy URL labeled local is not evidence of local inference. Foundation may report local inference unavailable rather than weaken the policy. This is an application routing guarantee; full-device network isolation is not claimed. External browsing/calendar are separate future permissions.

Provider deadlines, unavailable auth, quota exhaustion, cancellation and runtime exit all produce honest terminal states. A “done” string is not action evidence. No autonomous coding tool is enabled until the later coding-worker spec defines and tests its separate authority.

## 6. Legacy containment

The rebuilt entrypoint/package must not import or bundle the old automation modules. Remove the committed credential-shaped values from current source without copying them into fixtures/docs/logs. Owner revocation/rotation and any history rewrite are separate, explicit actions; deleting values does not revoke them.

Retire the old live social-send paths, voice-admin authorization, arbitrary delete/input helpers, import-time model/device initialization and placeholder capability claims from the released application. Preserve history/audit evidence without keeping the unsafe sample executable as a supported launcher. Replace obsolete dependency instructions with the resolved maintained environment; old dependencies must not leak into the new lock/bundle.

## 7. Test suite and security gates

Deterministic tests must require no real credentials, microphone, screen access, signed-in browser or model. Tests use temporary application-data directories/databases, injected clocks/IDs and provider/process doubles. They never write real user notes/accounts. Audited defect probes are source evidence; replace/invert their expectations when implementing corrected behavior.

| Suite | Required cases and evidence |
|---|---|
| Python domain/unit | validation, exact note content, readiness transitions, limits, literal text, safe error contracts and inert imports |
| Authorization/replay | allow/deny, altered title/body/scope, stale revision, expiry, duplicate Save, cancelled task, forged/replayed approval and policy mismatch; all negative cases assert zero effect calls |
| SQLite/recovery | transaction rollback at injected failure points, concurrent Save, crash/restart around commit, migrations/future-version refusal and preserved data |
| Provider contracts | streamed/partial/malformed outputs, unexpected tool/permission requests, auth/quota failure, timeout, late completion, cancellation, worker exit, incompatible versions and isolated provider-session artifact cleanup after normal/crash exits |
| Routing/privacy | local-only cloud rejection and no fallback; synthetic private markers absent from default logs/diagnostics/unrelated requests; context contains only explicitly attached data; untrusted Markdown causes zero unsolicited network requests |
| IPC/process | malformed/oversized/unknown frames, unsupported versions, wrong sender/request correlation, broken pipes, bounded inflight work and controlled child restart |
| UI/component | setup/readiness, keyboard and screen-reader accessible controls, full note preview, edited revision, cancel, honest saved/failed/interrupted states and safe Markdown rendering |
| Desktop end-to-end | actual Electron host/preload/core startup, typed note review/save/cancel, provider fixture flow, restart persistence and invalid IPC rejection |
| Security/static | typecheck/lint, redacting secret scan, maintained locked dependency scans, Python/JS static security rules and an independent diff/security review |
| Platform/package | clean Windows/macOS packaged launch, application data location, credential-store failure handling, missing/mismatched child and usable error paths |

Maintain at least **80% statement / 75% branch** coverage for maintained application code and **90% statement / 85% branch** for the trusted domain/policy core. Exercise every documented approval, replay, routing and cancellation decision regardless of aggregate percentages. Exclude generated/vendor/build code explicitly; remove dead application code rather than hide it with exclusions. Demonstrate sensitivity by temporarily bypassing a critical guard and confirming the relevant negative test fails, then restore the guard before review.

Normal CI uses locked dependencies and offline deterministic tests on Windows/macOS. No secrets are available to pull-request tests. Scan Python and JavaScript dependency graphs including transitives; report tool/network failure as an incomplete scan. No untriaged High/Critical finding or accepted reachable High/Critical defect passes a release. Any exception requires a specific applicability rationale, owner acceptance and expiry; it cannot silently turn a failed scan green.

Secret scanning checks the current tree/new diff and reports historical exposure separately. A current-source clean scan is not a clean-history claim. Do not print detected values. A software bill of materials and exact locked/runtime versions accompany releases.

Live provider checks are an explicitly initiated separate suite with a fixed short synthetic prompt, bounded usage and no workspace data. Verify supported account access, empty-mode restrictions, quota/auth errors and cancellation against the actual SDK/runtime. Do not run such checks inside normal tests. Record skipped live/platform checks and advertise only combinations actually verified.

## 8. Acceptance and handoff

Foundation is complete only when:

1. Clean Windows/macOS development environments run the locked deterministic suite; packaged smoke evidence exists for both before declaring platform support.
2. No old automation or unselected provider/model/device starts at import or application launch.
3. Without a model, users can review/save/cancel a local note and see it after restart.
4. A verified Copilot session can produce text and a reviewed note proposal with no ambient execution tools. If account access is unavailable, the adapter remains incomplete and is reported as such.
5. Every negative authorization/routing case has zero forbidden effects; startup/crash/cancellation states remain usable and truthful.
6. Static/security/dependency checks complete with the stated gates; current credential-containing samples are removed and historical credential triage is recorded separately.
7. README/support matrix describes this foundation accurately and preserves the remaining delivery slices as outstanding work.

This document fixes behavior and verification requirements. File-by-file tasks, dependency pins, command sequencing and execution assignment belong in the implementation plan after written-spec review. No product code or dependencies were changed to write this spec.
