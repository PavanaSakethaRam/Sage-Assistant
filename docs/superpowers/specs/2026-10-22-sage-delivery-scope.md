# Sage delivery scope

Date: 22 October 2026. Status: written design for owner review. The architecture direction is accepted; this file and the foundation specification are new review artifacts. They do not claim product implementation or passing release checks.

## Outcome

Complete Sage as a Windows/macOS portfolio assistant with a JARVIS north star: responsive conversation, explicit context, useful follow-through and trustworthy local state. The owner selected hybrid operation, requested local AI/subscription/API setup options, and expanded the demonstration to VS Code development, browser LeetCode hints and a personal organizer. The owner has authorized access to the open VS Code/Copilot setup and requested comprehensive testing/security validation.

The existing audited Python prototype is not the release foundation. Its useful integration ideas may be reused after validation. Unsafe messaging, voice-based authorization, unrestricted helper execution and credential-containing samples must not enter the rebuilt release.

## Accepted architectural direction

- Electron/React/TypeScript presentation, sandboxed renderer and a small trusted host.
- Supervised Python core over private framed IPC; typed validated contracts; no exposed general localhost execution API.
- SQLite for application state and FTS5 for approved notes/memory. LangGraph owns cross-app progression before resumable multi-step workflows are introduced.
- Independent reasoning, coding and voice capability selection. Local speech is the baseline; premium cloud voice is optional and separately authorized/billed.
- Supported provider adapters, explicit account/destination, no credential extraction and no hidden online-model fallback.
- Narrow VS Code and browser bridges. A coding worker has an independently enforced tool boundary.

Detailed research remains in [the architecture recommendation](../../research/2026-10-22-jarvis-architecture-research.md) and [the provider/demo report](../../research/2026-10-22-provider-setup-and-demo-research.md).

## Separate delivery slices

| Slice | Concrete outcome | Boundary |
|---|---|---|
| **1. Foundation and controlled provider connection** | Safe desktop/core startup, setup/readiness, local state, typed interaction, reviewed local note, one restricted Copilot connection and deterministic validation | The [foundation spec](2026-10-22-sage-foundation-design.md) is the first implementable design. No arbitrary coding/browser/calendar execution. |
| **2. VS Code development** | Share selected editor/workspace context, delegate one scoped project task, inspect diffs, run approved tests and open the result | Own named sessions; handle human edits/cancellation; no automatic push/publish. |
| **3. Browser practice** | Explicit shared-tab context and progressive LeetCode hints | Chrome/Edge first; read-only practice; no automatic submission; clarify ambiguous context. |
| **4. Personal organizer and continuity** | Cited research, reviewed notes, running-app reminders and one calendar integration; join the demos through durable tasks | One external calendar provider; exact action preview and receipt reconciliation; no promise while the laptop is off. |
| **5. Release completeness** | Local speech/model path, tested Codex/OpenCode/Claude options, packaged Windows/macOS demos and accurate support matrix | Each advertised adapter earns support through common contracts and live checks; unavailable integrations remain visibly unavailable. |

Local-AI policy exists from the foundation. Completing the local model/voice path is part of the release scope, not an optional cancellation of that requirement. The order above describes capability dependencies, not a task-by-task implementation plan. Each independently large subsystem receives its own focused spec and validation criteria.

## Demonstration acceptance

1. **Project development:** Sage handles “build a small focus tracker here”, shows actual changes and test results in VS Code, then completes a follow-up change without overwriting user work.
2. **LeetCode practice:** “help me with this” uses the currently shared problem/code, supplies a conceptual hint first and increases detail only when requested. No answer submission occurs.
3. **Organizer:** save a reviewed learning note, research the next topic with source links, resolve “tomorrow at seven” and create a confirmed reminder/calendar entry with a verified identity/time.
4. **Continuity:** interruption, provider disconnect and app restart produce honest states. Already committed effects are reconciled before any retry.
5. **Configuration:** local AI, supported assistant and API-key paths have clear prerequisites, destination and data controls. A coding subscription does not silently enable cloud speech or unrelated accounts.

## Validation promise

The deliverable is evidence of tested behavior and resolved/triaged security findings. It cannot truthfully promise perfect testing or absence of all vulnerabilities. Every release must identify the exact OS/provider/runtime versions tested and remaining limits. Tests must verify effects and refusal paths, not only response wording.

Deterministic suites run without accounts, devices or paid inference. Signed-in providers, native permissions, packaged OS behavior, real speech and external calendars have separate integration checks. The original audit probes reproduce broken behavior and must not be counted as a passing product suite.

## Explicit limits

No production social sending, unrestricted shell/desktop control, automatic deployments, all-day cloud microphone session, remote execution service or agent swarm is part of this portfolio scope. Future changes require a concrete workflow and enforceable boundary. Potentially exposed historical credentials require owner triage; implementing Sage does not establish their revocation.
