# Hosted foundation CI — 2026-10-23

At tested source [`12d813fabf5344eccf32aab929956742efb3eb22`](https://github.com/PavanaSakethaRam/Sage-Assistant/commit/12d813fabf5344eccf32aab929956742efb3eb22), [Verify run 39991009260](https://github.com/PavanaSakethaRam/Sage-Assistant/actions/runs/39991009260) and [Package run 39991009240](https://github.com/PavanaSakethaRam/Sage-Assistant/actions/runs/39991009240) both completed **success** on macOS and Windows, attempt 1. Verify's two job logs observed checkout merge `09d47971bd74cbe858ecd0fb1e47a5768681b871`. Its source and merge trees both equal `3ef5f9399b689d2ae75afa54b8149d4fd40d1414`; the merge parents are base `c7943bd4322f18d9201f4213e168e4747f5d0185` and that tested source. The [portable numeric record](artifacts/hosted-ci-2026-10-23.json) preserves job IDs, integer counts, source/workflow hashes and evidence digests.

| Verify host | Python pass/fail/skip | Vitest pass/fail/skip | Node tooling pass/fail/skip | Electron E2E pass/fail/skip |
| ----------- | --------------------: | --------------------: | --------------------------: | --------------------------: |
| macOS       |               587/0/1 |               171/0/1 |                       7/0/0 |                       5/0/0 |
| Windows     |              556/0/32 |              161/0/11 |                       7/0/0 |                       5/0/0 |

All four maintained/trusted integer coverage gates passed on each host. Values below are **covered/total**, not rounded percentages; the required maintained thresholds are 80% statements/75% branches and trusted thresholds are 90%/85%.

| Verify host and scope                 | Statements | Branches |
| ------------------------------------- | ---------: | -------: |
| macOS Python maintained and trusted   |  1948/2025 |  560/606 |
| macOS JavaScript maintained           |  1099/1182 |  696/810 |
| macOS JavaScript trusted              |    757/804 |  496/547 |
| Windows Python maintained and trusted |  1850/2025 |  524/606 |
| Windows JavaScript maintained         |  1098/1182 |  698/810 |
| Windows JavaScript trusted            |    756/804 |  498/547 |

Both Verify jobs reported Node **26.12.1**, npm **11.20.0**, CPython **3.13.17**, mypy across **46** source files, Ruff formatting across **58** files, and passing TypeScript, ESLint and formatting checks. All **11** deterministic commands passed; the additional security collection and sanitized Verify report upload passed. Security collector success retains untriaged lower static findings and does not clear native binary or historical credential gates. Live and platform-specific skips remain in the counts.

Both Package jobs reported Node **26.12.1**, npm **11.20.0**, CPython **3.13.17**, PyInstaller **6.22.3**, hooks-contrib **2026.9** and frozen smoke SDK **1.0.25**. The actual Windows ZIP inventory passed with **1,037 files**; that Windows-only step was skipped on macOS. On **both hosts**, the separate actual app-directory ASAR, production fuse and external resource baseline gate passed. The subsequent joint frozen smoke passed the fixed offline metadata/SDK construction probes **and** local note/restart behavior, reporting `frozen=true`. The closed summary does not report individual OpenSSL, SQLite or CA counts for these jobs. Both Package upload steps were skipped; final artifact count was **0**. These jobs produced an unreleased portable build, not an installer or distributed binary.

The frozen SDK result is a fixed no-input construction check. It did not start an authenticated account/session/model request or establish a full native Copilot reply, proposal, cancellation or protected-store path. The earlier failed local live attempt remains bound to its own package; no current-source inference is claimed. Main-native UI, a real unavailable credential-store case, clean-machine behavior, full Windows/macOS parity, installer/signing/notarization, native vulnerability/component terms, historical credential rotation and release acceptance remain open. Task 10 and foundation acceptance remain incomplete. Full coding, browser, organizer, voice and local inference demonstrations remain future work.

Native payload gates are separate from the development Node 26.12.1 result. At the [timestamped advisory triage](2026-10-23-native-advisory-triage.md), [Electron stable releases](https://releases.electronjs.org/release?channel=stable) still mapped to embedded Node 24.22.0; [Node 24.22.1](https://nodejs.org/en/blog/release/v24.22.1) had appeared in Electron prereleases only. Astral's [20261021 Python release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261021) does not prove a managed payload with the [SQLite 3.53.2 fixes](https://www.sqlite.org/cves.html). SQLite DEFENSIVE is an application mitigation, not a native binary patch.

The older [local foundation snapshots](foundation-results.md), including the 536 Python/160 JavaScript final wave and its exact macOS ZIP hash, remain historical evidence. For the maintained graph's exact source snapshot, read its [provenance](graph/provenance.json) and [report](graph/GRAPH_REPORT.md); graph relationships are not runtime proof.
