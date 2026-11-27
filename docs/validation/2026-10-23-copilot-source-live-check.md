# Copilot source authentication/cancellation check — 23 October 2026

**PASS for this scoped source test. Foundation and release acceptance remain incomplete.**

The owner explicitly approved one new check for GitHub account `PavanaSakethaRam`, after the earlier native Test had exhausted its separate one-test approval. The existing [live source harness](../../tests/live/test_copilot_smoke.py) ran once against source commit `f486facbb41b7bc664f58506c47840047d3cd570`: **one test passed, exit 0, 6.03 seconds, no retry**. The [closed result record](artifacts/copilot-source-live-2026-10-23.json) contains the sanitized evidence.

The harness uses one top-level reasoning invocation with the fixed prompt `Return {"text":"synthetic Sage smoke","proposal":null}.` and empty attached context. It requests cancellation after entering the SDK send wrapper, then closes its provider. No workspace documents, browser data or old social API values are attached. Pytest itself imports project source; this is not a claim that no workspace code executes.

## What the result establishes

The source backend reached the selected protected authentication and GitHub identity-validation path, runtime status validation, session creation, SDK send entry and the expected cancelled result without a proposal. The test asserted empty supplied tool/agent configuration fields and an empty owned session directory. It did not mark connection readiness as ready.

The controller independently observed two attributed descendants during the run. At the post-run snapshot none remained, no new unattributed managed executable was found, and no controller termination was needed. Metadata-only inspection found the owned session directory and five helper directories empty. The controller removed the exact owned temporary root. This is sampled process and logical filesystem evidence, not exhaustive process containment or forensic erasure.

Before launch, the harness bytes matched the reviewed Git snapshot and **302 selected managed vendor files** matched the existing size/hash inventory. The run used fresh owned home/temp directories, a minimal environment, explicit account selection, disabled pytest entry-point plugin autoload, disabled cache writes and no traceback/locals output. Built-in pytest/configuration machinery still executed. Raw test/vendor output was held in memory and discarded; it was not written to a log or included in this report. No credential value was printed or persisted by the controller.

## Limits and earlier evidence

- SDK send entry does not establish completed inference, valid response/proposal content, cloud-side cancellation or cloud-side cleanup.
- Actual protected-read, identity-request and model-request counts, SDK retries and quota consumption remain **unknown**. Source-level invocation structure is not a native/network operation counter.
- The fixture does not expose every internal cleanup result. Empty owned directories and the sampled process observations do not certify every cleanup stage, RAM zeroization or physical storage erasure.
- The vendor inventory and harness hash do not fingerprint every imported Python module. No repository conftest.py was found; this is not a loaded-module inventory.
- This source run does not validate the frozen application, current packaged UI/IPC/native consent, successful response/proposal flow, Windows, a clean macOS installation or an unavailable protected store. Signing, native/component licensing/notices and native CVE gates remain open.

The earlier approved native connection Test on the older package still has its recorded `runtime_error` outcome and unknown operation counts. This separately approved source check does not diagnose or relabel that failure. The current graph and package records remain their exact earlier source/artifact snapshots; this additive result does not transfer source-test success to a frozen binary. See [foundation results](foundation-results.md), [delivery scope](../superpowers/specs/2026-10-22-sage-delivery-scope.md) and [redistribution evidence](redistribution-evidence.md).

The one-check approval is now used. The controller initiated no second test or reasoning invocation, no credential/helper retry and no account change. No push, CI job, artifact upload or release was performed.
