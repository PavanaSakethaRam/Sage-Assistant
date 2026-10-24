/** One reviewed editor transaction; a dispatched save is settled even after cancellation. */
import * as vscode from "vscode";
import { createHash, randomBytes } from "node:crypto";
import type {
  CodeContext,
  CodeProposal,
  CodeReceipt,
  CodeIntent,
} from "../../desktop/shared/coding-contracts";
import { replacementState, validateContext } from "./context";
import { consumeLocalReview, type LocalReview } from "./review";
export async function replaceFocusFile(
  context: CodeContext,
  proposal: CodeProposal,
  approval: LocalReview,
): Promise<CodeReceipt> {
  const owner = consumeLocalReview(approval, context, proposal);
  owner.check();
  await validateContext(context);
  owner.check();
  const state = replacementState(context),
    document = state.document,
    expected = createHash("sha256")
      .update(proposal.files[0].text)
      .digest("hex"),
    expectedLength = Buffer.byteLength(proposal.files[0].text);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
  });
  owner.check();
  await validateContext(context);
  owner.check();
  state.originalCheck();
  const intent: CodeIntent = {
    binding: context.binding,
    scope: "code.replace",
    operation_id: owner.grant.operation_id,
    effect_id: randomBytes(16).toString("hex"),
    ordinal: 0,
    target: context.target!,
    expected_hash: expected,
  };
  await owner.bridge.recordIntent(owner.journal, intent);
  // Only a fresh ACK permits this one transaction. No observation is invented for lost intent ACKs.
  let registered = false,
    edited: boolean | undefined,
    saved: boolean | undefined,
    saveStarted = false,
    transactionVersion: number | undefined;
  try {
    owner.check();
    state.originalCheck();
    edited = await editor.edit((builder) => {
      owner.check();
      state.originalCheck();
      transactionVersion = document.version + 1;
      if (!Number.isSafeInteger(transactionVersion))
        throw Error("Editor version unavailable");
      builder.replace(
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        ),
        proposal.files[0].text,
      );
      registered = true;
    });
    owner.check();
    if (!registered || !edited) throw Error("Editor refused replacement");
    state.beforeSave(expected, expectedLength, transactionVersion!);
    owner.check();
    // No await between the final check and dispatch. Never saveAll, force, retry or undo.
    saveStarted = true;
    saved = await document.save();
  } catch {
    /* Observe the original target once; never repair or retry. */
  }
  let observed: ReturnType<typeof state.observe> | undefined;
  try {
    observed = state.observe();
  } catch {
    /* The target can no longer be identified reliably. */
  }
  const live =
      !document.isClosed && vscode.workspace.textDocuments.includes(document),
    exact =
      live &&
      createHash("sha256").update(document.getText()).digest("hex") ===
        expected &&
      Buffer.byteLength(document.getText()) === expectedLength &&
      document.eol === vscode.EndOfLine.LF &&
      document.encoding === "utf8",
    oldDisk =
      observed?.hash === state.originalHash &&
      observed.length === state.originalLength &&
      state.originalDisk(observed),
    approvedDisk =
      observed?.hash === expected && observed.length === expectedLength;
  let unchangedSources: boolean | undefined;
  try {
    unchangedSources = state.unchangedSources();
  } catch {
    /* Unidentified selected source blocks retained authority. */
  }
  let status: CodeReceipt["status"] = "needs_reconciliation";
  if (live && observed && unchangedSources !== undefined) {
    if (
      !unchangedSources ||
      !registered ||
      edited === false ||
      !exact ||
      (registered && document.version !== transactionVersion) ||
      (!oldDisk && !approvedDisk)
    )
      status = "needs_review";
    else if (
      saved === true &&
      document.version === transactionVersion &&
      !document.isDirty &&
      approvedDisk
    )
      status = "applied_saved";
    else if (
      edited === true &&
      (saved === false || !saveStarted) &&
      document.isDirty &&
      oldDisk
    )
      status = "applied_unsaved";
    else if (saved !== undefined) status = "needs_review";
  }
  const observedVersion = document.version;
  const receipt: CodeReceipt = {
    ...intent,
    scope: "code.replace",
    status,
    observed_hash: observed?.hash ?? null,
    observed_length: observed?.length ?? null,
  };
  // This is fact settlement, not renewed effect permission. The reviewed bridge journals late facts.
  await owner.bridge.recordObserved(owner.journal, receipt);
  owner.check();
  if (status === "applied_saved")
    state.retain(observed!, observedVersion, expected, expectedLength);
  return receipt;
}
