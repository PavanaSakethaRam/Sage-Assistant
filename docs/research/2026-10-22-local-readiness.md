# Local development readiness

Checked 22 October 2026 after the owner authorized inspection of the open VS Code/Copilot setup. These are metadata observations, not proof of authenticated SDK inference.

| Component | Observed evidence | Consequence |
|---|---|---|
| VS Code | 1.142.0, arm64 | An editor bridge can target this installed version. |
| Copilot editor integration | Bundled `GitHub.copilot-chat` 0.70.0; Copilot chat UI visible | Confirms the editor integration. Login is owner-reported; actual entitlement/model availability was not tested. |
| Embedded editor runtime | `@github/copilot` 1.0.73 with private native/runtime artifacts | This is not a supported substitute for installing Sage's public SDK/runtime. |
| Standalone Copilot | No `copilot` executable on the inspected shell PATH | No standalone runtime readiness established. This does not prove absence elsewhere. |
| Public SDK | Not present in inspected common Node locations or system Python | A supported pinned SDK/runtime must be provisioned during implementation; no private editor-bundle imports. |
| Node/npm | Node 26.10.0, npm 11.19.1 | Modern JS runtime exists; actual product lock/compatibility remains untested. |
| System Python | 3.9.6 | Does not meet the current Copilot Python SDK prerequisite; use a separately provisioned supported Python environment. |
| Codex | Earlier checked CLI 0.163.0 | Installation only; no account, model or sandbox probe performed. |

The initially visible VS Code window used a different remote workspace. After the owner created a new local window and explicitly requested its use, Sage's folder and the implementation plan were opened there. The verified title is `2026-10-22-sage-foundation.md — Sage Assistant`. The folder is in Restricted Mode and Copilot is disabled there by Workspace Trust. No trust setting was changed, no prompt was sent and the SSH workspace was left untouched. Subsequent integration tests must use this local window or a disposable local test workspace, with no inherited remote project context or automation.

Installed uv-managed Python is 3.10.22, in addition to system Python 3.9.6; a supported Python 3.13 environment still needs provisioning. No token/credential file was read, session resumed, package installed or permission changed during inspection.

The public [Copilot Python SDK documentation](https://github.com/github/copilot-sdk/blob/main/python/README.md) specifies Python 3.11+ and a version-matched managed runtime. The inspected public [SDK release v1.0.25](https://github.com/github/copilot-sdk/releases/tag/v1.0.25) is an implementation candidate, not a compatibility result. Check the chosen version's actual contracts before enabling an adapter.

Live readiness requires a deliberately initiated synthetic request through the supported API, with explicit account/destination and no workspace content. A screenshot of an available chat box cannot establish SDK authentication, quota or empty-mode confinement.
