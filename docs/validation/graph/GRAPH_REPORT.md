# Graph Report - Sage foundation  (2026-10-23)

## Corpus Check

- 61 files · ~40,281 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary

- 658 nodes · 1604 edges · 25 communities (16 shown, 9 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 70 edges (avg confidence: 0.91)
- Semantic host input/output token counters: unmeasured. Schema zero placeholders are not cost measurements; no external model job was dispatched.

## Community Hubs (Navigation)

- Desktop Renderer and Contracts
- Note Actions and Storage
- Desktop Core and Account Boundary
- Core Protocol and Service
- Copilot Reasoning and Configuration
- Foundation Policy and Evidence
- Electron Package Configuration
- Core Startup and Diagnostics
- SDK Capability Guard
- Frozen Package Probes
- Protected Authentication Helper
- Memory Session Filesystem
- Package Inventory and Staging
- Build Tool Provisioning
- Windows ZIP Validation
- Locked Security Verification
- Core Build and Verification
- Coverage Threshold Verification
- Application Paths

## God Nodes (most connected - your core abstractions)

1. `Contract` - 33 edges
2. `CoreService` - 29 edges
3. `ActionService` - 27 edges
4. `call()` - 26 edges
5. `Store` - 26 edges
6. `CopilotReasoner` - 23 edges
7. `message()` - 22 edges
8. `NoteContent` - 22 edges
9. `parseRequest()` - 19 edges
10. `MemorySessionFs` - 19 edges

## Surprising Connections (you probably didn't know these)

- `Hosted Windows support evidence` --semantically_similar_to--> `Hosted platform verification`  [INFERRED] [semantically similar]
  Readme.md → docs/testing.md
- `main()` --calls--> `isolatedChildEnv()`  [EXTRACTED]
  scripts/smoke_package.mjs → desktop/main/child-env.ts
- `main()` --calls--> `platform_key()`  [EXTRACTED]
  scripts/stage_package.py → src/sage/providers/protected_auth.py
- `Earlier artifact passed native UI note and restart check` --conceptually_related_to--> `Implemented reviewed local notes`  [INFERRED]
  docs/validation/foundation-results.md → Readme.md
- `Earlier approved connection Test failed runtime_error` --conceptually_related_to--> `One approved Test failed runtime_error on prior package with stage counts unknown`  [INFERRED]
  Readme.md → docs/validation/foundation-results.md

## Import Cycles

- None detected.

## Hyperedges (group relationships)

- **Specified foundation acceptance and remaining provider, signing and release gaps** — docs_superpowers_specs_2026_10_22_sage_foundation_design_foundation_acceptance, docs_validation_foundation_results_foundation_acceptance_incomplete, docs_validation_foundation_results_outer_signature_failure, docs_validation_foundation_results_failed_native_connection_test, docs_validation_foundation_results_live_copilot_skipped [INFERRED 0.85]
- **Reviewed local note authority across specification, security policy, implementation claim and earlier native evidence** — docs_superpowers_specs_2026_10_22_sage_foundation_design_reviewed_note_authority, docs_security_authority_and_trust_path, readme_reviewed_local_notes, docs_validation_foundation_results_native_ui_note_restart [INFERRED 0.85]
- **Guarded local offline SDK evidence and earlier failed live connection remain separate** — docs_security_guarded_sdk_self_check, docs_testing_guarded_sdk_probe, docs_validation_foundation_results_offline_sdk_probe, docs_validation_foundation_results_failed_native_connection_test [INFERRED 0.85]

## Communities (25 total, 9 thin omitted)

### Community 0 - "Desktop Renderer and Contracts"

Cohesion: 0.08
Nodes (67): api, App(), cancelTask(), getTask(), reconciledTask(), reconcileOutcome(), Conversation(), cancel() (+59 more)

### Community 1 - "Note Actions and Storage"

Cohesion: 0.06
Nodes (16): ActionService, _hash(), _identity(), _proposal(), _stamp(), ActionProposal, ActionResult, Approval (+8 more)

### Community 2 - "Desktop Core and Account Boundary"

Cohesion: 0.06
Nodes (47): blockedWindowsDefaults, isolatedChildEnv(), namedValue(), replace(), AccountBroker, closed(), defaultGhConfig(), EXECUTABLE_HASHES (+39 more)

### Community 3 - "Core Protocol and Service"

Cohesion: 0.06
Nodes (33): Settings, _context_text(), Contract, diagnostic(), _constant(), encode_frame(), Failure, Progress (+25 more)

### Community 4 - "Copilot Reasoning and Configuration"

Cohesion: 0.07
Nodes (21): _literal_text(), _nonblank_body(), _nonblank_title(), ProviderDiagnostic, ProviderReadiness, ReasoningRequest, ReasoningResult, TokenUsage (+13 more)

### Community 5 - "Foundation Policy and Evidence"

Cohesion: 0.07
Nodes (36): Closed provider stage and category diagnostics, Guarded offline SDK self-check boundary, Local AI only routing, Open security and release gates, Local retention and cleanup, Security architecture and evidence boundaries, Selected Copilot account path, Windows child environment policy (+28 more)

### Community 6 - "Electron Package Configuration"

Cohesion: 0.11
Nodes (12): config, canonicalArchiveEntry(), main(), validateArchive(), validateRawArchiveHeader(), result, python, result (+4 more)

### Community 7 - "Core Startup and Diagnostics"

Cohesion: 0.12
Nodes (7): main(), _run(), backend(), self_check(), WindowsPipe, identity_context(), ProtectedSource

### Community 8 - "SDK Capability Guard"

Cohesion: 0.18
Nodes (6): CapabilityGuard, metadata(), checked(), connect(), open_key(), _Silent

### Community 9 - "Frozen Package Probes"

Cohesion: 0.19
Nodes (19): count(), decodeFrame(), check(), invalidFrame(), keys(), nonempty(), runProbe(), sdkCategories (+11 more)

### Community 10 - "Protected Authentication Helper"

Cohesion: 0.16
Nodes (7): _pairs(), _bounded(), helper_environment(), _identity_body(), _reap(), run_helper(), trusted_executable()

### Community 12 - "Package Inventory and Staging"

Cohesion: 0.23
Nodes (7): inventory(), main(), validate_sources(), copy_javascript_notices(), electron_component_versions(), main(), verified_copy()

### Community 13 - "Build Tool Provisioning"

Cohesion: 0.16
Nodes (4): provision(), fetch(), main(), platform_key()

### Community 14 - "Windows ZIP Validation"

Cohesion: 0.19
Nodes (6): check_entry_type(), digest(), main(), Readable, verify(), ZipInventoryError

### Community 15 - "Locked Security Verification"

Cohesion: 0.27
Nodes (7): collect_bandit(), execute(), main(), npm_result(), python_result(), scan(), secret_result()

### Community 17 - "Coverage Threshold Verification"

Cohesion: 0.27
Nodes (5): check(), count(), CoverageThresholdError, main(), pair()

## Knowledge Gaps

- **36 isolated node(s):** `blockedWindowsDefaults`, `EXECUTABLE_HASHES`, `EXECUTABLE_SIZES`, `Child`, `SelectionResponse` (+31 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 182 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions

_Questions this graph is uniquely positioned to answer:_

- **Why does `Store` connect `Note Actions and Storage` to `Core Protocol and Service`, `Core Startup and Diagnostics`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `MemorySessionFs` connect `Memory Session Filesystem` to `Disposable Session Storage`, `Copilot Reasoning and Configuration`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `CapabilityGuard` connect `SDK Capability Guard` to `Copilot Reasoning and Configuration`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Are the 12 inferred relationships involving `CoreService` (e.g. with `ActionService` and `Settings`) actually correct?**
  _`CoreService` has 12 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `ActionService` (e.g. with `ActionProposal` and `ActionResult`) actually correct?**
  _`ActionService` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `Store` (e.g. with `ActionService` and `_run()`) actually correct?**
  _`Store` has 6 INFERRED edges - model-reasoned connections that need verification._
- **What connects `blockedWindowsDefaults`, `EXECUTABLE_HASHES`, `EXECUTABLE_SIZES` to the rest of the system?**
  _36 weakly-connected nodes found - possible documentation gaps or missing edges._
## Snapshot and interpretation

[Input hashes and provenance](provenance.json), [projected graph](graph.json), [raw extraction](extraction.json), [interactive view](graph.html), [health diagnostics](diagnostics.json), and [heuristic benchmark](benchmark.json).

All 61 selected source files match reviewed source commit e4aaccf1639fe8cb31be69338deae21913b0a3a3 exactly; the selected working-tree delta is empty. The graph was generated afterward and excludes its own artifact commit. CI evidence is linked in [hosted foundation CI](../2026-10-23-hosted-foundation-ci.md) and the [local CI record](../artifacts/hosted-ci-2026-10-23.json); runtime CI tested commit 12d813fabf5344eccf32aab929956742efb3eb22. The later source commit changed documentation in this selected corpus.

The undirected community projection combines parallel relationships; graph.json retains original edges with resolved endpoints, while extraction.json preserves all 1686 raw edges, 3 hyperedges, and 4 semantic WHY rationales. The same semantic seat revalidated all six documents and recorded 7 added nodes and 13 added edges; relationships changed. Health limits: 152 dangling-endpoint, 52 external-reference, 6 self-loop, 1 exact-duplicate, and 81 collapsed same-endpoint relationships. 1 raw edges have unresolved export endpoints. These are extraction limits, not a clean health claim.

Six code files yielded no symbols, including the selected PowerShell wrapper, two desktop entry files, and three Vite config entry files. The wrapper was dispatched through the installed PowerShell extractor. The HTML view uses Graphify's vis-network CDN dependency with SRI; its inline JavaScript was syntax checked, but browser execution and offline availability were not tested. The benchmark is a heuristic word/context estimate, not measured model savings. The graph does not establish native, authentication, or security acceptance.

[graphify] MultiDiGraph edge-collapse diagnostic
input: <in-memory>
input_stage: provided JSON (normal graph.json is post-build)
effective_directed: <direct-call>
nodes: 604
unverified_code_nodes: 0
raw_edges: 1686
valid_candidate_edges: 1482
missing_endpoint_edges: 0
dangling_endpoint_edges: 152
external_reference_edges: 52
self_loop_edges: 6
exact_duplicate_edges: 1
directed_unique_endpoint_pairs: 1404
directed_same_endpoint_collapsed_edges: 78
undirected_unique_endpoint_pairs: 1401
undirected_same_endpoint_collapsed_edges: 81
same_endpoint_group_count: 74
relation_variant_groups: 59
source_file_variant_groups: 0
source_location_variant_groups: 8
context_variant_groups: 6
post_build_graph_type: Graph
post_build_edges: 1604
producer_suppression_sites: 12
producer_suppression_examples:
  - L1677 seen_ids arity=unknown
  - L2210 seen_ids arity=unknown
  - L2212 seen_doc_refs arity=unknown
  - L2629 seen_ids arity=unknown
  - L2776 seen_ids arity=unknown
  - L3502 seen_keys arity=unknown
  - L3675 seen_keys arity=unknown
  - L5804 seen_ids arity=unknown
examples:
  - scripts_smoke_package_launch -> scripts_smoke_package_launch_finish edges=3 relations=['calls', 'contains', 'indirect_call'] locations=['L65', 'L71', 'L74'] contexts=['', 'argument', 'call']
  - src_sage_main_run -> src_sage_main_run_backend edges=3 relations=['calls', 'contains', 'indirect_call'] locations=['L66', 'L81', 'L82'] contexts=['', 'argument', 'call']
  - src_sage_actions_proposal -> src_sage_contracts_actionproposal edges=3 relations=['calls', 'references', 'uses'] locations=['L38', 'L39'] contexts=['', 'call', 'return_type']
  - src_sage_providers_copilot_construct_client -> src_sage_providers_copilot_py_any edges=3 relations=['references'] locations=['L49'] contexts=['generic_arg', 'parameter_type', 'return_type']
  - desktop_main_core_process_decode -> desktop_main_core_process_decode_walk edges=2 relations=['calls', 'contains'] locations=['L57', 'L68'] contexts=['', 'call']
note: normal graph.json is post-build; raw producer loss must be measured earlier.
