# Security architecture and evidence boundaries

This document describes the current foundation. Deterministic tests, source inspection, real-host E2E and local macOS package checks are evidence for specific boundaries, not a production release or authenticated-provider certification. The [historical prototype audit baseline is c7943bd](https://github.com/PavanaSakethaRam/Sage-Assistant/tree/c7943bd); old Graphify output does not describe the maintained core.

## Authority and trust path

The trust path is **sandboxed renderer → closed preload → sender-validated Electron main → owned framed Python core → proposal/review → atomic SQLite write**. The model is outside the action authority boundary.

The production window disables Node integration, enables context isolation, sandbox and web security, denies permissions and blocks unsolicited navigation, windows and remote resources. Local built assets and restrictive CSP are required. The sole renderer bridge exposes validated `request` and `onProgress`, never raw IPC, a shell, host paths or a secret getter. Main verifies the exact webContents, current main frame and document URL before accepting a closed request. Development permits only the validated Forge loopback origin, including its scoped HMR/style policy; production keeps its local CSP.

Main starts one fixed owned core with an absolute executable, arguments and application root, fresh environment and no shell. The private pipe uses a four-byte big-endian UTF-8 JSON length, at most 1 MiB, with protocol version, request ID and kind. Malformed frames, duplicate keys/IDs, correlation failures and bounded queue/session limits fail closed. Host-only account selection frames are rejected by public renderer/preload schemas. Restart does not replay work or account selection. Graceful cleanup is bounded; hard crashes and forced-parent descendant containment remain platform gates.

The only action tool is `notes.create`. Model output can propose a title/body and cannot approve or execute it. The review shows the complete literal content alongside safe Markdown. Save consumes the exact argument/revision/scope/policy/boot binding atomically with note insertion and its recorded outcome. Authority expires five minutes after issue and on restart, revision or backward clock anomaly; a failed/stale Save does not renew itself. A retained draft needs a fresh explicit review. Cancel/reject removes draft content and late UI/core results cannot restore the cancelled identity.

Title: nonblank, at most 200 Unicode code points. Markdown body: nonblank, at most 100,000. User text: at most 32,000; explicitly attached context: at most 64,000 total. Controls/NUL and malformed Unicode are rejected while body tabs/newlines are preserved. Markdown does not render raw HTML, remote images/media/previews/fonts or resource elements. A validated HTTP(S) link opens through main only after explicit activation; credentials, controls and unsupported schemes are rejected. Real Chromium click/navigation/egress observations are covered by the owned synthetic E2E; they are not system-wide network capture.

## Local mode and cloud data

Local AI only is the default. It never starts a cloud session or silently falls back. No reviewed local inference runtime is implemented; the UI says unavailable while local note controls work. API-key mode and Codex/OpenCode/Claude adapters are unavailable. Voice administration, raw keystrokes, browser/social sending and screen capture have no maintained execution path.

The Copilot adapter uses public `github-copilot-sdk==1.0.25` with native runtime `1.0.102`, protocol 3. Each request creates one disposable SDK session with `mode="empty"`, no tools, hooks, skills, MCP servers, plugins, custom agents or config/instruction discovery; unexpected permissions are denied. It receives only the current user text and explicitly attached context. Saved notes, task history, editor history, workspace files and prior chat are not attached automatically. The fixed synthetic connection test is a separate explicit user action, discloses the GitHub Copilot cloud destination and may consume quota.

Readiness inspects prerequisites without acquiring credentials or making network/model calls. Metadata availability, candidate selection, protected acquisition, identity verification, a connection test and actual end-to-end live proof are different evidence levels. VS Code login supplies none of the latter proofs.

## Separate selected-account path

The account path is **explicit host action → fixed metadata lookup → native confirmation of one candidate → private host-selected source → protected read → identity verification → one disposable SDK session**. No token crosses desktop/core IPC or enters the renderer. Login/path/host values are not renderer input. Local mode, disconnect, restart and source replacement invalidate selection/readiness and old work; new consent is required after returning to assistant mode. Mode transitions and revocation remain fenced until the core acknowledges cleanup, including when public requests saturate their queue.

The sole metadata invocation is `config get user --host github.com`, using the OS-default gh config path derived by main (macOS HOME/.config/gh; Windows trusted AppData/GitHub CLI). It requires explicit user action. Inherited GH_CONFIG_DIR/XDG_CONFIG_HOME overrides are ignored. Source inspection of the pinned builtin indicates no keyring/network/write operation for that lookup, but gh can parse entire config files containing secrets in its own memory. This has not been traced against a real account and proves no protected credential exists.

Protected acquisition is exactly:

```text
auth token --hostname github.com --user LOGIN --secure-storage --no-refresh
```

This hidden secure/no-refresh compatibility contract is accepted only for **gh 2.103.0, source 7948e8056e45ac3c729b829e0eafe2d0797a95c6** and the exact platform executable SHA-256/size pinned in `src/sage/providers/protected_auth.py` and `desktop/main/copilot-account.ts`. It is a narrow source-gated integration, not a general credential service or stable public CLI promise. Upgrades require renewed source/artifact review and tests; missing, changed, unsupported or symlinked executable/ancestor paths fail closed. No PATH lookup, first-use download, automatic login, refresh, scope/account switching, credential write or editor credential extraction exists.

The helper uses an empty Sage-owned GH_CONFIG_DIR and owned XDG data/state/cache/temp roots; nonempty or symlinked roots fail closed. Helper environments are allowlists, without inherited HOME/PATH/token/proxy/socket/debug settings; reviewed Windows SystemRoot/WINDIR are retained when needed. Output is bounded to 8 KiB stdout/16 KiB stderr and discarded on failure without reflection. Acquisition and identity share the earlier of the request deadline and five seconds. POSIX process-group cleanup covers owned helpers/descendants; Windows direct in-process CredReadW behavior is source-derived and still needs native execution evidence.

Only one bounded ASCII gho/ghu token is accepted. Identity is verified through direct TLS to fixed `api.github.com:443`, `GET /user`, with no proxy, redirects or host/config override, bounded framing/body/deadline, and an exact selected-login/positive-ID match. Only the credential Authorization header goes to that identity endpoint, not caller text/context. The verified token is passed using the public per-session SDK option. Failure becomes static auth_required, with no token cache, refresh or fallback. Actual protected-read/identity/native-confirmation/model evidence is tracked separately in [foundation results](validation/foundation-results.md); deterministic fixtures do not establish it.

Development deployment paths are `.runtime/copilot/1.0.102/prebuilds/PLATFORM-ARCH/copilot-runtime[.exe]` and `.runtime/gh/2.103.0/PLATFORM-ARCH/bin/gh[.exe]`; packaged resources use the corresponding `copilot` and `gh` trees and a frozen `core/sage-core[.exe]`. Only the selected platform tree and required notices are deployed; source archives/checksums and other-platform caches stay outside the app. Only the gh macOS arm64 artifact has been staged and hash-checked; four platform executable pins do not establish four tested platforms. Hash agreement does not establish signature trust, source-to-binary equivalence, vulnerability freedom or redistribution permission.

## Retention, cleanup and diagnostics

The desktop's trusted application root is Electron userData. The core stores `data/sage.sqlite3` below it, plus owned config/cache/temp directories. Standalone core startup uses platformdirs defaults unless a trusted root is supplied by the host/operator. SQLite contains settings, task/status metadata, proposal revisions/approval arguments and saved notes with local full-text indexing. It is not encrypted at rest.

Cancel/reject transactionally NULLs draft/approval content immediately. Cleanup NULLs revision/approval text after 24 hours and deletes task/status metadata after 30 days, cascading associated review/operation metadata. Cleanup runs at startup, relevant reads and every 60 seconds while serving; offline time does not run a background eraser. Saved notes persist across cleanup and no note-deletion UI/API is implemented yet. These are logical retention rules, not secure deletion of SQLite pages, journals, backups, OS memory or user copies.

SDK history uses an 8 MiB bounded RAM filesystem; session store and telemetry are disabled. Owned marked disposable directories contain runtime working state and are removed on normal disposal; startup recovers marked leftover directories without sweeping unrelated files. Cleanup failure makes the provider unavailable. Native content/token persistence and crash cleanup still need live/platform validation; Python immutable strings are not forensically zeroized. Cloud provider retention is outside the local SQLite policy.

Core diagnostics are a closed set of static stderr codes; child stderr is drained/discarded and SDK logging is disabled. Caller text, account/token values, exception payloads and note content are not logged by the maintained diagnostic paths. Redacting scans report locations/rule names only. They are pattern checks and cannot prove absence of every possible secret.

## Open evidence and ownership

| Gate                           | Current evidence / required follow-up                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical credential exposure | Original files are retired; Git history remains. Owner must confirm revocation/rotation and incident scope. Unresolved until that confirmation; no history rewrite or credential mutation performed                                                       |
| Current source/release surface | Release-surface tests inspect maintained imports, locks, a built wheel and desktop bundles; redacted tree/diff scans supplement this                                                                                                                      |
| Deterministic integration      | Complete maintained/trusted integer coverage and owned real-host E2E exist; exact final counts and limits are in foundation results                                                                                 |
| Copilot account/cloud behavior | Public SDK/source/integrity contracts tested with synthetic fixtures; real candidate, protected access, identity, entitlement, quotas, revoked/expired behavior, persistence and UI flow remain Task 10                                                   |
| Native/platform/package        | Local macOS frozen CPython3.13.17/package/fuse/resource evidence is recorded separately; Windows, clean-machine prerequisites and forced-crash containment remain open                               |
| Licensing/provenance           | No repository license decision inferred. Preserve upstream notices/inventory; SDK MIT metadata does not decide separate native Copilot terms. Full notices, native redistribution review and signatures/notarization remain release gates; installers are deferred |
| Portfolio/demo scope           | Full JARVIS/coding/browser/organizer/voice and additional provider slices outstanding; no complete demo claim                                                                                                                                             |

Do not include credentials in issues, logs, fixtures or historical audit excerpts. Report credential findings by location and category, using synthetic markers for scanner tests. File removal and a clean scan do not revoke a credential or remove earlier commits, clones or external copies.


## Package integrity and TLS policy

The core is a native onedir console build so private Windows standard streams remain available; Node owns `windowsHide`. Copilot and gh binaries are sibling resources outside the freezer's library rewrite/sign passes and Electron ASAR. Complete source and deployed inventories are distinct. All vendor hashes must survive packaging and ZIP extraction unchanged. Only maintained source/resources, selected native trees and reviewed notices belong in the package; development tools, private prompts, fixtures and account/session state do not.

Production disables RunAsNode, NODE_OPTIONS and CLI inspector fuses and enables embedded ASAR integrity and ASAR-only loading. ASAR integrity does not cover external core/native/gh resources, which need their own inventory. Neither fuse readback nor intermediate Electron ad-hoc repairs certifies the final outer app signature. Local packaging omits osxSign/osxNotarize entirely; adding an empty signing object would enable identity discovery and potentially rewrite vendor binaries. Signing/notarization/distribution readiness remains incomplete until actual owner-authorized signing and verification, with explicit vendor ownership rules.

The Python identity socket retains `ssl.create_default_context()` platform-default trust, fixed GitHub hostname, certificate verification and hostname checking. The local frozen macOS probe measures PBS/OpenSSL default paths rather than assuming certifi configures stdlib SSL. certifi is independently retained for HTTPX with exact lock/version/PEM provenance. No SSL verification bypass, CA fallback, store union, environment override, proxy restoration or user trust-store mutation is introduced. Other hosts, native SDK/gh trust, and live authenticated TLS need their own evidence.

Python/npm advisories omit much of the bundled interpreter/native supply chain. Retained CPython, Electron/Chromium, SDK/runtime and gh notices plus Python/JavaScript/native BOMs support review; they do not settle the repository's independent license or the native runtime's redistribution conditions. The native BOM explicitly reports remaining license/CVE limits. Historical credential revocation/rotation remains an owner gate even when current-source scans pass.
