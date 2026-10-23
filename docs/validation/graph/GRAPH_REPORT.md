# Graph Report - Sage foundation  (2026-10-23)

## Corpus Check

- 56 files · ~36,198 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary

- 600 nodes · 1476 edges · 21 communities (13 shown, 8 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 63 edges (avg confidence: 0.91)
- Semantic host input/output token counters: unmeasured. Prompt placeholders of zero are not cost measurements. No external model job was dispatched.

## Community Hubs (Navigation)

- Renderer and strict shared wire contracts
- Pinned SDK provider and reasoning records
- Revision-bound notes and SQLite integrity
- Core routing and bounded private protocol
- Native host, account selection and IPC
- Foundation documents and evidence limits
- Portable packaging and bounded smoke
- Explicit startup, identity trust and Windows pipes
- Pinned resource staging and notices
- Protected authentication and identity requests
- Bounded RAM session filesystem
- Fixed SDK capability guard
- Verified tooling/native provisioning
- Complete security report collection
- Native freezer and aggregate commands
- Owned application paths
- Disposable session directory cleanup

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

- `main()` --calls--> `platform_key()`  [EXTRACTED]
  scripts/stage_package.py → src/sage/providers/protected_auth.py
- `Earlier artifact passed native UI note and restart check` --conceptually_related_to--> `Implemented reviewed local notes`  [INFERRED]
  docs/validation/foundation-results.md → Readme.md
- `Earlier approved connection Test failed runtime_error` --conceptually_related_to--> `One approved Test failed runtime_error on prior package with stage counts unknown`  [INFERRED]
  Readme.md → docs/validation/foundation-results.md
- `main()` --calls--> `platform_key()`  [EXTRACTED]
  scripts/provision_package.py → src/sage/providers/protected_auth.py
- `_run()` --uses--> `SelectedAccount`  [INFERRED]
  src/sage/__main__.py → src/sage/protocol.py

## Import Cycles

- None detected.

## Hyperedges (group relationships)

- **Specified foundation acceptance and reported open evidence gates** — docs_superpowers_specs_2026_10_22_sage_foundation_design_foundation_acceptance, docs_validation_foundation_results_foundation_acceptance_incomplete, docs_validation_foundation_results_outer_signature_failure, docs_validation_foundation_results_failed_native_connection_test, docs_validation_foundation_results_live_copilot_skipped [INFERRED 0.85]
- **Reviewed local note authority across specification, security policy, implementation claim and earlier native evidence** — docs_superpowers_specs_2026_10_22_sage_foundation_design_reviewed_note_authority, docs_security_authority_and_trust_path, readme_reviewed_local_notes, docs_validation_foundation_results_native_ui_note_restart [INFERRED 0.85]
- **Guarded offline SDK evidence and earlier failed live connection remain separate** — docs_security_guarded_sdk_self_check, docs_testing_guarded_sdk_probe, docs_validation_foundation_results_offline_sdk_probe, docs_validation_foundation_results_failed_native_connection_test [INFERRED 0.85]

## Communities (21 total, 8 thin omitted)

### Community 0 - "Renderer and strict shared wire contracts"

Cohesion: 0.08
Nodes (67): api, App(), cancelledTask(), cancelTask(), getTask(), purgeCancelledTask(), Conversation(), cancel() (+59 more)

### Community 1 - "Pinned SDK provider and reasoning records"

Cohesion: 0.05
Nodes (25): check(), count(), main(), pair(), _literal_text(), _nonblank_body(), _nonblank_title(), ProviderDiagnostic (+17 more)

### Community 2 - "Revision-bound notes and SQLite integrity"

Cohesion: 0.06
Nodes (16): ActionService, _hash(), _identity(), _proposal(), _stamp(), ActionProposal, ActionResult, Approval (+8 more)

### Community 3 - "Core routing and bounded private protocol"

Cohesion: 0.06
Nodes (33): Settings, _context_text(), Contract, diagnostic(), _constant(), encode_frame(), Failure, _pairs() (+25 more)

### Community 4 - "Native host, account selection and IPC"

Cohesion: 0.06
Nodes (43): AccountBroker, closed(), defaultGhConfig(), EXECUTABLE_HASHES, EXECUTABLE_SIZES, generation(), metadata(), noSymlinks() (+35 more)

### Community 5 - "Foundation documents and evidence limits"

Cohesion: 0.08
Nodes (30): Closed provider stage and category diagnostics, Guarded offline SDK self-check boundary, Local AI only routing, Open security and release gates, Local retention and cleanup, Security architecture and evidence boundaries, Selected Copilot account path, Sage delivery scope (+22 more)

### Community 6 - "Portable packaging and bounded smoke"

Cohesion: 0.10
Nodes (13): config, main(), validateArchive(), result, cleanup(), close(), deadline(), fail() (+5 more)

### Community 7 - "Explicit startup, identity trust and Windows pipes"

Cohesion: 0.12
Nodes (7): main(), _run(), backend(), self_check(), WindowsPipe, identity_context(), ProtectedSource

### Community 8 - "Pinned resource staging and notices"

Cohesion: 0.17
Nodes (7): inventory(), main(), validate_sources(), copy_javascript_notices(), electron_component_versions(), main(), verified_copy()

### Community 9 - "Protected authentication and identity requests"

Cohesion: 0.18
Nodes (6): _bounded(), helper_environment(), _identity_body(), _reap(), run_helper(), trusted_executable()

### Community 11 - "Fixed SDK capability guard"

Cohesion: 0.21
Nodes (4): CapabilityGuard, metadata(), checked(), _Silent

### Community 12 - "Verified tooling/native provisioning"

Cohesion: 0.18
Nodes (4): provision(), fetch(), main(), platform_key()

### Community 13 - "Complete security report collection"

Cohesion: 0.27
Nodes (7): collect_bandit(), execute(), main(), npm_result(), python_result(), scan(), secret_result()

## Knowledge Gaps

- **31 isolated node(s):** `EXECUTABLE_HASHES`, `EXECUTABLE_SIZES`, `Child`, `SelectionResponse`, `Terminal` (+26 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 166 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions

_Questions this graph is uniquely positioned to answer:_

- **Why does `Store` connect `Revision-bound notes and SQLite integrity` to `Core routing and bounded private protocol`, `Explicit startup, identity trust and Windows pipes`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Why does `MemorySessionFs` connect `Bounded RAM session filesystem` to `Pinned SDK provider and reasoning records`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `CoreService` connect `Core routing and bounded private protocol` to `Pinned SDK provider and reasoning records`, `Revision-bound notes and SQLite integrity`, `Explicit startup, identity trust and Windows pipes`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Are the 12 inferred relationships involving `CoreService` (e.g. with `ActionService` and `Settings`) actually correct?**
  _`CoreService` has 12 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `ActionService` (e.g. with `ActionProposal` and `ActionResult`) actually correct?**
  _`ActionService` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `Store` (e.g. with `ActionService` and `_run()`) actually correct?**
  _`Store` has 6 INFERRED edges - model-reasoned connections that need verification._
- **What connects `EXECUTABLE_HASHES`, `EXECUTABLE_SIZES`, `Child` to the rest of the system?**
  _31 weakly-connected nodes found - possible documentation gaps or missing edges._
## Snapshot and interpretation

[Exact selected input hashes and provenance](provenance.json), [graph data](graph.json), [full extracted relationships](extraction.json), [interactive graph](graph.html), [health diagnostics](diagnostics.json), [estimated retrieval benchmark](benchmark.json).

All 56 selected source files match implementation commit 2652a67dbcbe433cc351f7740ea5283e7e4c92c6 exactly; the selected working-tree delta is empty. The graph artifacts were generated afterward and do not include their own artifact commit or certify native/runtime behavior. The original untracked prototype graph is preserved separately.

The undirected community projection combines parallel relationships; graph.json retains every original edge whose endpoints resolve. Health diagnostics expose any dangling endpoints, self-loops or projected edge collapse. The interactive view uses the pinned Graphify vis-network9.1.6 CDN script with SRI; it was not executed here and is not certified as an offline viewer. Five code files yielded no symbols: desktop/main/index.ts, desktop/renderer/main.tsx and the three Vite config entry files. This extraction limit is retained.

[graphify] MultiDiGraph edge-collapse diagnostic
input: <in-memory>
input_stage: provided JSON (normal graph.json is post-build)
effective_directed: <direct-call>
nodes: 545
unverified_code_nodes: 0
raw_edges: 1555
valid_candidate_edges: 1362
missing_endpoint_edges: 0
dangling_endpoint_edges: 145
external_reference_edges: 48
self_loop_edges: 5
exact_duplicate_edges: 1
directed_unique_endpoint_pairs: 1287
directed_same_endpoint_collapsed_edges: 75
undirected_unique_endpoint_pairs: 1284
undirected_same_endpoint_collapsed_edges: 78
same_endpoint_group_count: 71
relation_variant_groups: 56
source_file_variant_groups: 0
source_location_variant_groups: 8
context_variant_groups: 6
post_build_graph_type: Graph
post_build_edges: 1476
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
  - src_sage_providers_copilot_construct_client -> src_sage_providers_copilot_py_any edges=3 relations=['references'] locations=['L49'] contexts=['generic_arg', 'parameter_type', 'return_type']
  - desktop_main_core_process_decode -> desktop_main_core_process_decode_walk edges=2 relations=['calls', 'contains'] locations=['L57', 'L68'] contexts=['', 'call']
note: normal graph.json is post-build; raw producer loss must be measured earlier.

Explicit health limits: 145 raw dangling-endpoint edges, 48 external-reference edges, 5 self-loops, 1 exact duplicates, and 78 relationships combined by the undirected projection. 1 raw edges have unresolved export endpoints and are omitted from graph.json; extraction.json preserves all 1555 raw edges. These are extraction limitations, not a clean graph-health claim.
The final fix3 source hashes were revalidated by the same semantic seat, which retained the 33-node/44-edge/3-hyperedge I3 fragment unchanged. The current AST includes the filename-bearing import boundary fix; the extra redistribution evidence is linked but outside the selected six-document semantic corpus.
