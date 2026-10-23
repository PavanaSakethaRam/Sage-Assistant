# Graph Report - Sage foundation  (2026-10-23)

## Corpus Check

- 55 files · ~34,285 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary

- 565 nodes · 1390 edges · 20 communities (13 shown, 7 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 57 edges (avg confidence: 0.92)
- Semantic host input/output token counters: unmeasured. Prompt placeholders of zero are not cost measurements. No external model job was dispatched.

## Community Hubs (Navigation)

- Desktop Notes and Contracts
- Reviewed Notes and Storage
- Core Service and Protocol
- Trusted Desktop Supervision
- Copilot Session Lifecycle
- Package Gate and Smoke
- Foundation Evidence and Scope
- Protected Credential Acquisition
- Startup and Owned Paths
- Memory Session Filesystem
- Native Source Provisioning
- Resource Inventory and Notices
- Security Verification Gates
- Native Core Build
- Coverage Verification
- Windows Private Pipes

## God Nodes (most connected - your core abstractions)

1. `Contract` - 30 edges
2. `CoreService` - 29 edges
3. `ActionService` - 27 edges
4. `call()` - 26 edges
5. `Store` - 26 edges
6. `message()` - 22 edges
7. `NoteContent` - 22 edges
8. `CopilotReasoner` - 22 edges
9. `parseRequest()` - 19 edges
10. `MemorySessionFs` - 19 edges

## Surprising Connections (you probably didn't know these)

- `main()` --calls--> `platform_key()`  [EXTRACTED]
  scripts/stage_package.py → src/sage/providers/protected_auth.py
- `Passed native UI note and restart check` --conceptually_related_to--> `Implemented reviewed local notes`  [INFERRED]
  docs/validation/foundation-results.md → Readme.md
- `main()` --calls--> `platform_key()`  [EXTRACTED]
  scripts/provision_package.py → src/sage/providers/protected_auth.py
- `_run()` --uses--> `Store`  [INFERRED]
  src/sage/__main__.py → src/sage/storage.py
- `CoreService` --uses--> `ActionService`  [INFERRED]
  src/sage/service.py → src/sage/actions.py

## Import Cycles

- None detected.

## Hyperedges (group relationships)

- **Specified foundation acceptance and reported open evidence gates** — docs_superpowers_specs_2026_10_22_sage_foundation_design_foundation_acceptance, docs_validation_foundation_results_foundation_acceptance_incomplete, docs_validation_foundation_results_outer_signature_failure, docs_validation_foundation_results_live_copilot_skipped [INFERRED 0.85]
- **Reviewed local note authority across specification, security policy, implementation claim and native evidence** — docs_superpowers_specs_2026_10_22_sage_foundation_design_reviewed_note_authority, docs_security_authority_and_trust_path, readme_reviewed_local_notes, docs_validation_foundation_results_native_ui_note_restart [INFERRED 0.85]

## Communities (20 total, 7 thin omitted)

### Community 0 - "Desktop Notes and Contracts"

Cohesion: 0.08
Nodes (66): api, App(), cancelledTask(), cancelTask(), getTask(), purgeCancelledTask(), Conversation(), cancel() (+58 more)

### Community 1 - "Reviewed Notes and Storage"

Cohesion: 0.06
Nodes (16): ActionService, _hash(), _identity(), _proposal(), _stamp(), ActionProposal, ActionResult, Approval (+8 more)

### Community 2 - "Core Service and Protocol"

Cohesion: 0.06
Nodes (36): Settings, _context_text(), Contract, diagnostic(), main(), _run(), backend(), _constant() (+28 more)

### Community 3 - "Trusted Desktop Supervision"

Cohesion: 0.06
Nodes (44): AccountBroker, closed(), defaultGhConfig(), EXECUTABLE_HASHES, EXECUTABLE_SIZES, generation(), metadata(), noSymlinks() (+36 more)

### Community 4 - "Copilot Session Lifecycle"

Cohesion: 0.06
Nodes (15): _literal_text(), _nonblank_body(), _nonblank_title(), ProviderReadiness, ReasoningRequest, ReasoningResult, TokenUsage, ReasoningBackend (+7 more)

### Community 5 - "Package Gate and Smoke"

Cohesion: 0.10
Nodes (13): config, main(), validateArchive(), result, cleanup(), close(), deadline(), fail() (+5 more)

### Community 6 - "Foundation Evidence and Scope"

Cohesion: 0.10
Nodes (23): Local AI only routing, Open security and release gates, Local retention and cleanup, Security architecture and evidence boundaries, Selected Copilot account path, Sage delivery scope, Five planned delivery slices, Specified foundation acceptance criteria (+15 more)

### Community 7 - "Protected Credential Acquisition"

Cohesion: 0.15
Nodes (7): _bounded(), helper_environment(), _identity_body(), ProtectedSource, _reap(), run_helper(), trusted_executable()

### Community 8 - "Startup and Owned Paths"

Cohesion: 0.14
Nodes (4): self_check(), app_paths(), AppPaths, identity_context()

### Community 10 - "Native Source Provisioning"

Cohesion: 0.15
Nodes (4): provision(), fetch(), main(), platform_key()

### Community 11 - "Resource Inventory and Notices"

Cohesion: 0.23
Nodes (7): inventory(), main(), validate_sources(), copy_javascript_notices(), electron_component_versions(), main(), verified_copy()

### Community 12 - "Security Verification Gates"

Cohesion: 0.27
Nodes (7): collect_bandit(), execute(), main(), npm_result(), python_result(), scan(), secret_result()

### Community 14 - "Coverage Verification"

Cohesion: 0.33
Nodes (4): check(), count(), main(), pair()

## Knowledge Gaps

- **30 isolated node(s):** `EXECUTABLE_HASHES`, `EXECUTABLE_SIZES`, `Child`, `SelectionResponse`, `Terminal` (+25 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 158 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions

_Questions this graph is uniquely positioned to answer:_

- **Why does `Store` connect `Reviewed Notes and Storage` to `Startup and Owned Paths`, `Core Service and Protocol`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `CoreService` connect `Core Service and Protocol` to `Startup and Owned Paths`, `Reviewed Notes and Storage`, `Copilot Session Lifecycle`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `MemorySessionFs` connect `Memory Session Filesystem` to `Copilot Session Lifecycle`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Are the 12 inferred relationships involving `CoreService` (e.g. with `ActionService` and `Settings`) actually correct?**
  _`CoreService` has 12 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `ActionService` (e.g. with `ActionProposal` and `ActionResult`) actually correct?**
  _`ActionService` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `Store` (e.g. with `ActionService` and `_run()`) actually correct?**
  _`Store` has 6 INFERRED edges - model-reasoned connections that need verification._
- **What connects `EXECUTABLE_HASHES`, `EXECUTABLE_SIZES`, `Child` to the rest of the system?**
  _30 weakly-connected nodes found - possible documentation gaps or missing edges._
## Snapshot and interpretation

[Exact selected input hashes and provenance](provenance.json), [graph data](graph.json), [full extracted relationships](extraction.json), [interactive graph](graph.html), [health diagnostics](diagnostics.json), [estimated retrieval benchmark](benchmark.json).

The graph uses the ancestor commit and exact file hashes in provenance, including the current tooling working-tree delta. It does not include its own artifact commit or certify native/runtime behavior. The original untracked prototype graph is preserved separately.

The undirected community projection combines parallel relationships; graph.json retains every original edge whose endpoints resolve. Health diagnostics expose any dangling endpoints, self-loops or projected edge collapse. The interactive view uses the pinned Graphify vis-network9.1.6 CDN script with SRI; it was not executed here and is not certified as an offline viewer. Five code files yielded no symbols: desktop/main/index.ts, desktop/renderer/main.tsx and the three Vite config entry files. This extraction limit is retained.

[graphify] MultiDiGraph edge-collapse diagnostic
input: <in-memory>
input_stage: provided JSON (normal graph.json is post-build)
effective_directed: <direct-call>
nodes: 511
unverified_code_nodes: 0
raw_edges: 1462
valid_candidate_edges: 1280
missing_endpoint_edges: 0
dangling_endpoint_edges: 134
external_reference_edges: 48
self_loop_edges: 5
exact_duplicate_edges: 1
directed_unique_endpoint_pairs: 1212
directed_same_endpoint_collapsed_edges: 68
undirected_unique_endpoint_pairs: 1209
undirected_same_endpoint_collapsed_edges: 71
same_endpoint_group_count: 65
relation_variant_groups: 52
source_file_variant_groups: 0
source_location_variant_groups: 8
context_variant_groups: 4
post_build_graph_type: Graph
post_build_edges: 1390
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
  - scripts_smoke_package_launch -> scripts_smoke_package_launch_finish edges=3 relations=['calls', 'contains', 'indirect_call'] locations=['L66', 'L72', 'L75'] contexts=['', 'argument', 'call']
  - src_sage_main_run -> src_sage_main_run_backend edges=3 relations=['calls', 'contains', 'indirect_call'] locations=['L65', 'L80', 'L81'] contexts=['', 'argument', 'call']
  - src_sage_actions_proposal -> src_sage_contracts_actionproposal edges=3 relations=['calls', 'references', 'uses'] locations=['L38', 'L39'] contexts=['', 'call', 'return_type']
  - desktop_main_core_process_decode -> desktop_main_core_process_decode_walk edges=2 relations=['calls', 'contains'] locations=['L57', 'L68'] contexts=['', 'call']
  - desktop_main_ipc -> desktop_shared_external_url_validateexternalurl edges=2 relations=['imports'] locations=['L8'] contexts=['import']
note: normal graph.json is post-build; raw producer loss must be measured earlier.

Explicit health limits: 134 raw dangling-endpoint edges, 48 external-reference edges, 5 self-loops, 1 exact duplicates, and 71 relationships combined by the undirected projection. 1 raw edges have unresolved export endpoints and are omitted from graph.json; extraction.json preserves all 1462 raw edges. These are extraction limitations, not a clean graph-health claim.
The six document hashes and validated semantic fragment are retained unchanged; the tooling AST and exact source snapshot reflect Task10 I1/I2 fixes. No new semantic extraction was performed.
