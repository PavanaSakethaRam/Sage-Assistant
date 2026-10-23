# Foundation evidence — 2026-10-23

**Release/foundation acceptance remains incomplete.** These are local macOS arm64 implementation results, not Windows parity, clean-machine certification, authenticated Copilot completion or finished JARVIS/coding/browser demos. The independent Task 10 and final whole-branch reviews remain controller gates.

Host: macOS **27.0.1 (26A434), arm64**. Hardware: **Mac16,7 / Apple M4 Pro**, read with a scoped read-only hardware probe; no serial or device identifier was read. Build Node **26.10.0**, npm **11.19.1**, Electron **45.0.0** (bundled Node **24.22.0**, Chromium **156.0.8078.48**, V8 **15.6.75.19-electron.0**, measured from the pristine locked distribution before fuse changes), Forge **8.0.1**, SDK **1.0.25**, native runtime **1.0.102**, managed gh **2.103.0**. Both project Python environments were recreated/scoped to **CPython 3.13.17**. The clean freezer environment contains only runtime dependencies plus the locked build group; ordinary verification uses all groups.

## Executed checks

| Status | Check | Evidence and limit |
|---|---|---|
| PASS | Final `npm run verify` | All 11 commands exit 0 after final build/scanner changes: 468 Python tests, one explicit live skip; 131 JavaScript tests; five real-host E2E cases; integer coverage, TypeScript, ESLint, mypy, Ruff, formatting and complete security wrapper |
| PASS | Additional explicit tooling types | `mypy src/sage tests scripts/verify_security.py scripts/stage_package.py scripts/provision_package.py scripts/build_core.py scripts/package_manifest.py`: 46 files |
| PASS | Native source recreation | Supported SDK download-runtime route and checksum-pinned gh ZIP provisioning in a disposable build root reproduced all 304 source file paths/sizes/hashes; no native executable/account/model was invoked |
| PASS | Native frozen core | OS-native PyInstaller 6.22.3 / hooks 2026.9 console onedir; 533 modules pass a runtime/stdlib allowlist; migrations, SDK metadata, all 16 runtime dependency metadata sets and tzdata are present |
| PASS | Actual extracted ZIP | 1,138 selected resource entries match staging exactly; full app inventory has 1,956 entries and 14 relative, confined framework symlinks. Core has no symlinks. All 27 Mach-O files include arm64 |
| PASS | ASAR and fuses | Actual ASAR contains expected main/preload/renderer entries and no tested private/fixture/credential patterns. RunAsNode, NODE_OPTIONS and CLI inspector are off; embedded ASAR integrity and ASAR-only loading are on |
| PASS | Actual ASAR enforcement | A disposable copy with a changed ASAR header exits 133 with Electron's integrity-check failure. The delivered ZIP was not mutated |
| PASS | Frozen note/restart | `node scripts/smoke_package.mjs RESOURCES` launches the extracted core using overlapped pipes, owned disposable state and a fresh environment with no PATH/developer Python; saves an exact synthetic note, exits, restarts, reads it and observes local inference unavailable. Zero cloud calls |
| PASS | Production-fuse standalone startup | Final extracted app and frozen core run with the same project-owned `task10-final-ui` userData/root; no default user state, inspector or sandbox weakening was used |
| PASS | Frozen offline TLS readiness | Same identity-context factory: certificate verification/hostname checking enabled, flags 557088, 128 eager CA anchors, readable default CA file/capath; CA/keylog/proxy overrides absent in the allowlisted child environment. This is not a live certificate-chain handshake |
| PASS | Vendor byte/signature integrity | Copilot and gh bytes/modes survive staging, packaging and extraction. All ten selected vendor Mach-O files pass individual strict codesign verification |
| FAIL | Final host/outer signatures | Outer app, main executable and four renamed helpers fail strict signature verification after packaging. Other 22/27 Mach-O files verify. Intermediate ad-hoc repairs are not a valid final outer signature |
| SKIP | Signing/notarization/Gatekeeper release | No owner signing credentials were sought, no signing identity discovery enabled, no notarization or Gatekeeper certification performed. Artifact is local, unsigned/ad-hoc and unreleased |
| SKIP | Windows execution/parity | Workflow source exists; this Mac did not run Windows core, IOCP pipes, helper/Credential Manager, DLL loading, installer, restart or cleanup checks |
| SKIP | Clean-machine macOS | This is the development Mac. System dependencies, OS trust and clean-machine installation remain separate gates |
| SKIP | Main native UI note/restart | Frozen-core persistence and actual standalone startup are proved; final main-window native interaction/restart is blocked because macOS is locked and CUA cannot unlock it |
| SKIP | Actual packaged negative UI cases | Manifest regressions reject missing/changed executables, unexpected native/private files and escaping links. Actual production-window missing/mismatched-core and unavailable credential-store failures are blocked by the locked Mac |
| SKIP | Protected account and live Copilot | CUA reports the Mac is locked and cannot be unlocked automatically; final main native account confirmation/protected-source prerequisites could not be exercised. No account absence is inferred. Zero live model requests; authenticated text/note proposal, quota, cancellation, native token/content persistence and cleanup remain incomplete |
| SKIP | Native redistribution/CVE clearance | Notices and scoped BOMs are retained; repository licensing, complete statically linked interpreter/native notices and redistribution review are unfinished. pip/npm advisories do not certify those binaries |
| SKIP | Historical credential closure | Deleted original `test.py` exposure remains unresolved pending owner rotation/revocation/incident confirmation. No historical credential values were retrieved; current clean scans do not erase history |
| SKIP | Final independent reviews | Controller owns fresh Task 10 review and the final broad review after the scoped implementation commit |

The offline frozen probe verifies SDK metadata without importing/starting its client. Frozen authenticated client/session execution remains unproved.

The native account prerequisite must be established through Sage's explicit chooser and native confirmation using the pinned gh protected-source path. Sage does not implement login/refresh. VS Code sign-in is insufficient. Any manual authentication belongs outside Sage with verified OS-protected storage; the ordinary gh login command's plaintext fallback is not a fail-closed bootstrap guarantee. No editor token extraction, token environment/argv/file transport, credential writes, paid retry or real workspace prompt was used.

## Artifact identity and provenance

Final local ZIP: `out/task10-release/make/zip/darwin/arm64/Sage-darwin-arm64-0.1.0.zip` (build output, not tracked), **214,581,793 bytes**; SHA-256 **`2e875ce946bfc7e58866d0f3a765d4afe4cdb416d06cdec79ab50b3c91f8c69e`**. Frozen executable SHA-256 **`61c1ff15af7e74a4c07e8471ab556e0599c81199bcc36413dbf22afb49afb642`**. The extracted final app is local build output under `.runtime/task10-final-artifact/Sage.app`; these local outputs are not distributable release attachments.

Portable reviewed evidence is tracked here:

- [Selected resource inventory](artifacts/macos-arm64-resources.json): every selected file's path/type/size/hash/mode/link.
- [Whole app inventory](artifacts/macos-arm64-app.json): host/framework and external resource coverage after extraction and smoke.
- [Runtime, provenance and signature evidence](artifacts/macos-arm64-evidence.json): exact archive/interpreter/trust metadata and per-native-file status, with machine-specific paths removed.
- [Integer coverage/source hashes](artifacts/foundation-coverage.json) and [sanitized security findings](artifacts/foundation-security.json): complete lower finding/hotspot locations remain visible.

CPython came from Astral python-build-standalone **20261021**, archive `cpython-3.13.17+20261021-aarch64-apple-darwin-install_only_stripped.tar.gz`, **25,286,365 bytes**, SHA-256 **`8dc60610a82f1e73be7faf964383e02520f95f6e39592a5c37c3809f5a7b798e`**, matching the official release API digest. The installed interpreter executable and Python license match archive bytes. uv 0.13.5 changes the macOS libpython install name, so archive, installed and frozen-library hashes are distinguished; no byte-equivalence claim is made across those transforms. [Pinned uv relocation source](https://github.com/astral-sh/uv/blob/0.13.5/crates/uv-python-managed/src/macos_dylib.rs).

Actual runtime: Clang 23.1.3 CPython build 21 October 2026; **OpenSSL 3.5.9**, **SQLite 3.53.1**. `_ssl` is built into this libpython. The identity socket retains platform-default SSL trust: this host's `/private/etc/ssl/cert.pem` and `/private/etc/ssl/certs`, not an assumed certifi redirect or macOS Keychain enumeration. certifi **2026.10.19** is separately bundled for HTTPX; extracted PEM SHA-256 **`50f79f98dac192b20dbf73f35c56f0b0c557ab267ff5199d1117cc1180b70785`**. Python, gh, Electron and Copilot native trust are distinct. No verification bypass, CA fallback/union or user trust-store change was made.

SDK MIT notice is an unchanged upstream v1.0.25 file, separately supplied because the wheel contains license metadata but no license text; SHA-256 **`2510b446bc1f0cf9702453075d20cd88631e20e5642658edb7325d9c1eb534f7`**. The separate native Copilot license and all retained selected-platform notices/assets remain unchanged. Source archives/checksums and other-platform caches are not deployed. All 88 production JavaScript dependency license texts are retained with full nested lock-relative paths so multiple versions do not collide. Python, production-JavaScript and native component BOMs ship in `Resources/notices`; build-tool pins are identified separately. Their scope/unfinished native legal and CVE coverage is explicit.

## Coverage and security interpretation

| Scope | Statements covered/total | Branches covered/total | Required |
|---|---:|---:|---|
| Python maintained | 1658/1720 | 475/514 | 80% / 75% |
| Python trusted | 1658/1720 | 475/514 | 90% / 85% |
| JavaScript maintained | 1068/1153 | 666/778 | 80% / 75% |
| JavaScript trusted | 732/780 | 482/531 | 90% / 85% |

These are complete application-source group totals from `scripts/coverage-manifest.json`, not per-file promises. No maintained source was excluded. Empty initializers remain inventoried; renderer entry main.tsx remains counted at 0/1 statements. Tooling/tests are outside runtime counters and receive their own regressions/static scans. Native/E2E counters were not merged into ordinary coverage.

The locked Python audit covers **63 selected-host third-party packages**, all groups, with zero advisories. Complete npm lock audit covers **461** resolved entries (89 production, 373 development, 59 optional; categories overlap), zero vulnerabilities. Other-OS markers require that OS's audit. Native binaries and statically linked libraries remain outside these advisory scopes.

Bandit scans **52 Python files**, ignoring nosec suppressions: **682 findings: 673 LOW, nine MEDIUM, zero HIGH**. The nine MEDIUM findings are two checksum-verifying official HTTPS download boundaries, five deliberate test corruption SQL statements, and two synthetic path fixtures. Lower findings remain retained; assertions, fixed argv/owned-path subprocesses and static enum/empty-string credential heuristics are reviewed in context. ESLint security scans **54 files**, retaining **79 heuristic hotspots**: 52 nonliteral filesystem paths, 22 object-key accesses, four identity-comparison timing heuristics and one bounded login regex. They are not all confirmed vulnerabilities and not zero findings. No owner exception or blanket waiver is invented; independent review remains required.

The first aggregate failed closed because Bandit's >50-file progress output contaminated JSON. A real 51-file regression reproduced this; `--quiet` disables informational progress while preserving all metrics and all 51 fixture findings. Scanner-only home/cache roots are now project-owned; no parser prelude stripping or inventory weakening was introduced. The first result is superseded by the final all-pass aggregate, not hidden. Earlier CPython 3.13.16/task evidence is historical. Forge's upstream deprecated build transitives and optional install-script notices remain visible debt, with no untested overrides or global script approvals.

Current-tree Gitleaks and synthetic detection/redaction pass. That aggregate ran before Task 10 commit/staging; its committed range is the earlier `3b953a9..b3080e0`, so it is not Task 10 committed-diff evidence. Exact staged artifacts/current range scans are recorded with the scoped commit. No raw matches, source snippets, values or scanner diagnostics are in the tracked security evidence. Historical credential exposure is separate.

## Corpus and remaining delivery

Original untracked `docs/audit/`, owner research files and `graphify-out/` remain preserved as the original prototype corpus, historically anchored at [c7943bd](https://github.com/PavanaSakethaRam/Sage-Assistant/tree/c7943bd). They were not blindly staged or relabeled as current. The separate maintained-source graph is pending controller semantic extraction. Its deterministic AST snapshot and exact corpus hashes exist as local task evidence; the original graph is not relabeled as current. Generated dependencies, runtimes, caches, state and tests are excluded from the new corpus. Host semantic token counters are unmeasured, not zero-cost evidence.

Voice, screen/VS Code/browser interaction, autonomous coding, organizer/social workflows and additional Codex/OpenCode/Claude/API adapters remain approved future delivery slices. No full demo or finished foundation claim follows from this local package. Task 9's deferred post-launch E2E harness cleanup finding and Task 6's upstream Forge dependency debt remain for final controller triage.

Known Windows source gate: MakerSquirrel is scaffolded, but the current main entry has no Squirrel lifecycle-event guard. Installer readiness is incomplete; the controller must rule on reviewed startup handling versus deferring that installer before any Windows installer claim. No speculative DLL loader reset or native launcher was added.

Additional focused static check: Bandit 1.9.4 scanned `sage-core.spec` separately (the root build configuration is outside directory-recursive targets): one file, zero findings. The final pipeline preserves each native command failure as its own CI step. A nested JavaScript notice collision was reproduced and fixed before the final successful package checks and aggregate; earlier partial artifacts are superseded.

After the final aggregate, a test-only ASAR cleanup change moved its sibling archive removal into `finally`; its focused test, typecheck, ESLint and formatting passed. Application/build source and coverage totals did not change. The sanitized static report refreshes that file and binds findings to current source hashes.
