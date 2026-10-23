# Graph Report - Sage foundation  (2026-10-23)

## Corpus Check

- 55 files · ~33,875 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary

- 564 nodes · 1380 edges · 32 communities (22 shown, 10 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 56 edges (avg confidence: 0.92)
- Semantic host input/output token counters: unmeasured. Prompt placeholders of zero are not cost measurements. No external model job was dispatched.

## Community Hubs (Navigation)

- Package Build and Verification
- Note Review Desktop UI
- Reviewed Note Decisions
- Desktop Request Contracts
- Copilot Inference Lifecycle
- Foundation Evidence and Scope
- SQLite Transactions and Cleanup
- Note Storage and Search
- Framed Pipe Protocol
- Electron Package Verification
- Protected Credential Acquisition
- Core Dispatch and Selection
- Native Account Consent
- Typed Service Contracts
- Memory Session Filesystem
- Desktop Core Supervision
- Fixed Child Deployment
- Disposable Session Storage
- Renderer Trust Boundary
- Literal Input Validation
- Startup and Offline Probe
- Provider Configuration Types
- Private Pipe Initialization
- Owned Application Paths
- Frozen Restart Smoke
- Frame Decoding and Launch
- Async Pipe Writer

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
  scripts/provision_package.py → src/sage/providers/protected_auth.py
- `main()` --calls--> `platform_key()`  [EXTRACTED]
  scripts/stage_package.py → src/sage/providers/protected_auth.py
- `Passed native UI note and restart check` --conceptually_related_to--> `Implemented reviewed local notes`  [INFERRED]
  docs/validation/foundation-results.md → Readme.md
- `_run()` --uses--> `SelectedAccount`  [INFERRED]
  src/sage/__main__.py → src/sage/protocol.py
- `_run()` --uses--> `Store`  [INFERRED]
  src/sage/__main__.py → src/sage/storage.py

## Import Cycles

- None detected.

## Hyperedges (group relationships)

- **Specified foundation acceptance and reported open evidence gates** — docs_superpowers_specs_2026_10_22_sage_foundation_design_foundation_acceptance, docs_validation_foundation_results_foundation_acceptance_incomplete, docs_validation_foundation_results_outer_signature_failure, docs_validation_foundation_results_live_copilot_skipped [INFERRED 0.85]
- **Reviewed local note authority across specification, security policy, implementation claim and native evidence** — docs_superpowers_specs_2026_10_22_sage_foundation_design_reviewed_note_authority, docs_security_authority_and_trust_path, readme_reviewed_local_notes, docs_validation_foundation_results_native_ui_note_restart [INFERRED 0.85]

## Communities (32 total, 10 thin omitted)

### Community 0 - "Package Build and Verification"

Cohesion: 0.05
Nodes (23): main(), validate_modules(), check(), count(), main(), pair(), inventory(), main() (+15 more)

### Community 1 - "Note Review Desktop UI"

Cohesion: 0.12
Nodes (35): App(), cancelledTask(), cancelTask(), getTask(), purgeCancelledTask(), Conversation(), cancel(), send() (+27 more)

### Community 2 - "Reviewed Note Decisions"

Cohesion: 0.17
Nodes (9): ActionService, _hash(), _identity(), _proposal(), _stamp(), ActionProposal, ActionResult, Approval (+1 more)

### Community 3 - "Desktop Request Contracts"

Cohesion: 0.17
Nodes (33): api, action(), array(), Backend, backends, bounded(), date(), ErrorCode (+25 more)

### Community 4 - "Copilot Inference Lifecycle"

Cohesion: 0.14
Nodes (7): ProviderReadiness, ReasoningRequest, ReasoningResult, ReasoningBackend, CopilotReasoner, _Running, _unique_object()

### Community 5 - "Foundation Evidence and Scope"

Cohesion: 0.10
Nodes (23): Local AI only routing, Open security and release gates, Local retention and cleanup, Security architecture and evidence boundaries, Selected Copilot account path, Sage delivery scope, Five planned delivery slices, Specified foundation acceptance criteria (+15 more)

### Community 7 - "Note Storage and Search"

Cohesion: 0.12
Nodes (5): Note, _migration_scripts(), _note(), SchemaVersionError, StorageError

### Community 8 - "Framed Pipe Protocol"

Cohesion: 0.18
Nodes (13): diagnostic(), _constant(), encode_frame(), _pairs(), Progress, ProtocolError, read_frame(), selection() (+5 more)

### Community 9 - "Electron Package Verification"

Cohesion: 0.13
Nodes (6): config, main(), validateArchive(), result, python, result

### Community 10 - "Protected Credential Acquisition"

Cohesion: 0.18
Nodes (7): _bounded(), helper_environment(), _identity_body(), platform_key(), _reap(), run_helper(), trusted_executable()

### Community 11 - "Core Dispatch and Selection"

Cohesion: 0.22
Nodes (4): Settings, Request, SelectedAccount, CoreService

### Community 12 - "Native Account Consent"

Cohesion: 0.15
Nodes (11): AccountBroker, closed(), defaultGhConfig(), EXECUTABLE_HASHES, EXECUTABLE_SIZES, generation(), metadata(), noSymlinks() (+3 more)

### Community 13 - "Typed Service Contracts"

Cohesion: 0.20
Nodes (13): Contract, Failure, Response, Cancel, Decision, Empty, _Inference, NoteId (+5 more)

### Community 15 - "Desktop Core Supervision"

Cohesion: 0.29
Nodes (7): SelectedAccount, SelectionAck, CoreProcess, encodeFrame(), CoreRequest, CoreResponse, failure()

### Community 16 - "Fixed Child Deployment"

Cohesion: 0.16
Nodes (10): launchCore(), Child, CoreOptions, deployment(), Pending, SelectionResponse, startCore(), Terminal (+2 more)

### Community 18 - "Renderer Trust Boundary"

Cohesion: 0.27
Nodes (11): handleRequest(), createTrust(), createWindowOptions(), guardSession(), guardWindow(), isTrustedSender(), SenderEvent, SessionGuard (+3 more)

### Community 19 - "Literal Input Validation"

Cohesion: 0.22
Nodes (6): _context_text(), _literal_text(), _nonblank_body(), _nonblank_title(), TokenUsage, ReasoningInput

### Community 20 - "Startup and Offline Probe"

Cohesion: 0.22
Nodes (3): main(), self_check(), identity_context()

### Community 21 - "Provider Configuration Types"

Cohesion: 0.24
Nodes (3): _Cancelled, _Incompatible, _Output

### Community 22 - "Private Pipe Initialization"

Cohesion: 0.22
Nodes (4): _run(), backend(), WindowsPipe, ProtectedSource

### Community 24 - "Frozen Restart Smoke"

Cohesion: 0.25
Nodes (5): close(), env, pending, request(), resources

### Community 25 - "Frame Decoding and Launch"

Cohesion: 0.40
Nodes (3): decode(), walk(), FrameDecoder

## Knowledge Gaps

- **33 isolated node(s):** `EXECUTABLE_HASHES`, `EXECUTABLE_SIZES`, `Child`, `SelectionResponse`, `Terminal` (+28 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 162 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions

_Questions this graph is uniquely positioned to answer:_

- **Why does `Store` connect `SQLite Transactions and Cleanup` to `Reviewed Note Decisions`, `Note Storage and Search`, `Core Dispatch and Selection`, `Typed Service Contracts`, `Startup and Offline Probe`, `Private Pipe Initialization`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `CoreService` connect `Core Dispatch and Selection` to `Reviewed Note Decisions`, `Copilot Inference Lifecycle`, `SQLite Transactions and Cleanup`, `Framed Pipe Protocol`, `Typed Service Contracts`, `Startup and Offline Probe`, `Private Pipe Initialization`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `MemorySessionFs` connect `Memory Session Filesystem` to `Disposable Session Storage`, `Copilot Inference Lifecycle`, `Provider Configuration Types`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Are the 12 inferred relationships involving `CoreService` (e.g. with `ActionService` and `Settings`) actually correct?**
  _`CoreService` has 12 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `ActionService` (e.g. with `ActionProposal` and `ActionResult`) actually correct?**
  _`ActionService` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `Store` (e.g. with `ActionService` and `_run()`) actually correct?**
  _`Store` has 6 INFERRED edges - model-reasoned connections that need verification._
- **What connects `EXECUTABLE_HASHES`, `EXECUTABLE_SIZES`, `Child` to the rest of the system?**
  _33 weakly-connected nodes found - possible documentation gaps or missing edges._
## Snapshot and interpretation

[Exact selected input hashes and provenance](provenance.json), [graph data](graph.json), [full extracted relationships](extraction.json), [interactive graph](graph.html), [health diagnostics](diagnostics.json), [estimated retrieval benchmark](benchmark.json).

The graph uses the ancestor commit and exact file hashes in provenance, including the portable ZIP policy working-tree delta. It does not include its own artifact commit or certify native/runtime behavior. The original untracked prototype graph is preserved separately.

The undirected community projection combines parallel relationships; graph.json retains every original edge whose endpoints resolve. Health diagnostics expose any dangling endpoints, self-loops or projected edge collapse. The interactive view uses the pinned Graphify vis-network9.1.6 CDN script with SRI; it was not executed here and is not certified as an offline viewer. Five code files yielded no symbols: desktop/main/index.ts, desktop/renderer/main.tsx and the three Vite config entry files. This extraction limit is retained.

[graphify] MultiDiGraph edge-collapse diagnostic
input: <in-memory>
input_stage: provided JSON (normal graph.json is post-build)
effective_directed: <direct-call>
nodes: 509
unverified_code_nodes: 0
raw_edges: 1450
valid_candidate_edges: 1267
missing_endpoint_edges: 0
dangling_endpoint_edges: 134
external_reference_edges: 49
self_loop_edges: 5
exact_duplicate_edges: 1
directed_unique_endpoint_pairs: 1201
directed_same_endpoint_collapsed_edges: 66
undirected_unique_endpoint_pairs: 1198
undirected_same_endpoint_collapsed_edges: 69
same_endpoint_group_count: 64
relation_variant_groups: 51
source_file_variant_groups: 0
source_location_variant_groups: 8
context_variant_groups: 4
post_build_graph_type: Graph
post_build_edges: 1380
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
  - src_sage_main_run -> src_sage_main_run_backend edges=3 relations=['calls', 'contains', 'indirect_call'] locations=['L65', 'L80', 'L81'] contexts=['', 'argument', 'call']
  - src_sage_actions_proposal -> src_sage_contracts_actionproposal edges=3 relations=['calls', 'references', 'uses'] locations=['L38', 'L39'] contexts=['', 'call', 'return_type']
  - desktop_main_core_process_decode -> desktop_main_core_process_decode_walk edges=2 relations=['calls', 'contains'] locations=['L57', 'L68'] contexts=['', 'call']
  - desktop_main_ipc -> desktop_shared_external_url_validateexternalurl edges=2 relations=['imports'] locations=['L8'] contexts=['import']
  - desktop_main_security -> desktop_shared_external_url edges=2 relations=['imports_from', 're_exports'] locations=['L106'] contexts=['export', 're-export']
note: normal graph.json is post-build; raw producer loss must be measured earlier.

Explicit health limits: 134 raw dangling-endpoint edges, 49 external-reference edges, five self-loops, one exact duplicate, and 69 relationships combined by the undirected projection. One raw logging import edge has an unresolved export endpoint and is omitted from graph.json; extraction.json preserves all 1,450 raw edges. These are extraction limitations, not a clean graph-health claim.
