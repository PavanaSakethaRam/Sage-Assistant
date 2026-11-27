# Sage Assistant

Sage is a desktop assistant foundation with typed conversation, explicit setup, and reviewed local Markdown notes. You can create, review, save, search and reopen notes without an AI account. A model can suggest a draft; only a separate human Save can authorize the note write.

This checkout is under development. It does not yet establish a production release, a complete JARVIS demo, Windows/macOS support parity or authenticated provider operation. The original voice and screen automation prototype has been retired.

## Current behavior and support

| Surface                                                         | Current state                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local notes                                                     | Implemented: literal title/body review, revision-bound Save/Cancel, SQLite persistence, search and task history                                                           |
| Local AI only                                                   | Default mode; local notes work. Local inference is unavailable, so this is not offline AI                                                                                 |
| GitHub Copilot                                                  | Pinned SDK adapter and protected-account selection implemented; one approved packaged connection attempt failed runtime_error; authenticated operation remains incomplete |
| Codex, OpenCode, Claude                                         | Unavailable; no adapters implemented                                                                                                                                      |
| API key mode                                                    | Unavailable; no API adapter or key-entry/storage flow                                                                                                                     |
| Desktop                                                         | Sandboxed Electron/React implementation; macOS arm64 host/core/preload and local package evidence; signing and clean-machine gates remain                                 |
| Windows                                                         | Hosted Verify and Package passed on Windows at the tested source; clean-machine and authenticated native-provider verification remain open                                |
| Linux                                                           | Development path candidates exist; no release support claim                                                                                                               |
| Packaging                                                       | Hosted macOS/Windows portable package checks passed at the tested source; release, signing and clean-machine gates remain                                                 |
| Voice, screen, browser, coding, organizer and social automation | Future slices; no maintained execution capability                                                                                                                         |

The earlier local package received one explicitly approved synthetic connection test and returned `runtime_error`; protected-read, identity-request and model-call counts are unknown. Disconnect was acknowledged and the app quit; no retry was performed. The later rebuilt package passes guarded offline SDK import/construction and local note/restart checks, but has no live validation. [Exact snapshots and open gates](docs/validation/foundation-results.md) keep those results separate.

VS Code sign-in does not establish SDK authentication. Account selection is consent to a candidate, not proof of credentials or Copilot readiness. Only a separate explicit connection test attempts a fixed synthetic cloud request and may consume quota. See [security and evidence boundaries](docs/security.md).

## Locked development setup

The maintained Python package is `src/sage`; the desktop is `desktop`. Use Python 3.13 and Node 26.12.1 (the manifest requires >=26.12.1 <27). Final local verification uses isolated CPython 3.13.17. `uv.lock` and `package-lock.json` pin the dependency graphs.

From the repository root, with uv and the stated Node version available, the following POSIX-shell commands keep downloaded Python and caches in the project:

```sh
export UV_CACHE_DIR="$PWD/.cache/uv"
export UV_PYTHON_INSTALL_DIR="$PWD/.runtime/python"
export UV_PYTHON_BIN_DIR="$PWD/.runtime/python-bin"
uv sync --frozen --all-groups --python 3.13.17
npm ci --cache .cache/npm
```

On Windows, set the equivalent environment variables in your shell. Hosted Windows verification and packaging results are in the [2026-10-23 foundation CI record](docs/validation/2026-10-23-hosted-foundation-ci.md); clean-machine validation remains outstanding. `npm ci` uses the repository postinstall script to install Electron into the project cache. Do not install the retired dependency list or run historical launchers.

```sh
# Inspect the maintained private core entrypoint.
uv run --frozen python -m sage --help

# Start the development desktop with local note controls.
npm start

# Build the maintained main, preload and renderer bundles.
npm run build
```

`python -m sage` is a length-prefixed JSON pipe service for the owned desktop host, not an interactive chat prompt. The desktop starts its fixed `.venv` interpreter in isolated mode. Without verified managed native runtime staging, provider controls remain unavailable; notes still work. Explicit build-time provisioning and staging are described in [testing](docs/testing.md). Packaged startup never downloads a runtime or falls back to developer Python. `npm run make` targets portable ZIPs on macOS and Windows. Installers are deferred; no installer lifecycle support or readiness is claimed. A successful package/make does not establish release support, a valid outer signature, notarization, or redistribution clearance.

## Verification

These scripts and direct commands currently exist. Ordinary tests use synthetic fixtures and require no account, paid model call, microphone, screen permission or signed-in browser.

```sh
uv run --frozen pytest tests/security/test_release_surface.py -q
uv run --frozen pytest -q
uv run --frozen ruff check src/sage tests
uv run --frozen ruff format --check src/sage tests
uv run --frozen mypy
npm test
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage
```

The release-surface test builds and inspects a Python wheel and all three desktop bundles; it needs the locked Python development dependencies and `node_modules`. The native Electron smoke may need permission to start a local GUI process in a restricted runner. The complete maintained/trusted coverage gate and real Chromium E2E are implemented; tested-source hosted results are in the [foundation CI record](docs/validation/2026-10-23-hosted-foundation-ci.md), with earlier local results in [foundation results](docs/validation/foundation-results.md). The opt-in live Copilot fixture is separate and does not run during ordinary tests.

Audit both complete maintained dependency graphs, including development/build dependencies:

```sh
uv export --frozen --all-groups --no-emit-project --format requirements-txt --output-file .cache/sage-audit-requirements.txt
PIP_CACHE_DIR="$PWD/.cache/pip" uv run --frozen pip-audit --requirement .cache/sage-audit-requirements.txt --require-hashes --disable-pip --strict --cache-dir .cache/pip-audit --progress-spinner off
npm audit --json --cache .cache/npm
```

Native binary provenance, redistribution rights and platform behavior need separate evidence; dependency audits do not establish them. The [current native advisory triage](docs/validation/2026-10-23-native-advisory-triage.md) records the version gaps and remaining gates. `npm run verify` aggregates deterministic checks and complete dependency/static/redacting scans. See [testing](docs/testing.md) and [foundation results](docs/validation/foundation-results.md).

## Data, history and licensing

Settings, task metadata, retained draft content and saved notes live in the local SQLite store. Cancel/reject clears draft fields immediately; drafts age out after 24 hours and task metadata after 30 days during cleanup. Saved notes persist; no saved-note deletion UI/API is implemented. Storage is not encrypted or a forensic erasure mechanism. Model requests include only the current text and explicitly attached context, never an automatically loaded transcript or workspace. More detail is in [security.md](docs/security.md).

Historical audit material describes the [original prototype at commit c7943bd](https://github.com/PavanaSakethaRam/Sage-Assistant/tree/c7943bd). The original local `graphify-out/` is an untracked historical prototype corpus and is preserved. A separate maintained-source graph is described in the [foundation results](docs/validation/foundation-results.md); its [provenance](docs/validation/graph/provenance.json) records the exact source snapshot. Neither graph certifies runtime behavior. Credentials exposed in repository history require owner triage and confirmation of revocation/rotation. Removing files does not revoke credentials or remove Git history; this work does neither.

No repository license grant is established by this README. Upstream dependency notices and native runtime inventories must be preserved; the SDK's MIT metadata does not settle separate Copilot native runtime terms. Final notices, [component terms/redistribution review](docs/validation/redistribution-evidence.md) and package provenance remain release gates.
