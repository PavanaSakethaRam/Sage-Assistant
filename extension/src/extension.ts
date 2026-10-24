/** Local selection and disclosure only; no provider or workspace effect command. */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionBridge, localWorkspace } from "./bridge";
import {
  captureContext,
  contextOffer,
  onContextRelease,
  diagnosticChoices,
  disclosureSummary,
  releaseContext,
  validateContext,
} from "./context";
import { ProposalReview } from "./review";
import { probeRoot } from "./root-probe";
import { EffectJournal } from "./journal";
import {
  FOCUS_NAMES,
  type CodeContext,
  type FocusName,
} from "../../desktop/shared/coding-contracts";
import type { PairView } from "../../desktop/shared/editor-bridge";
type PairOperation = {
  client?: ExtensionBridge;
  pending: boolean;
  cancelled: boolean;
  pair?: PairView;
  guard?: () => void;
  rawRootUri?: string;
  generation?: number;
  nativeIdentity?: string;
  journal?: EffectJournal;
  context?: CodeContext;
  review?: ProposalReview;
  reviewTask?: Promise<void>;
  applied?: boolean;
  sent?: boolean;
  preview?: vscode.Uri;
  timer?: ReturnType<typeof setTimeout>;
  pickers: Set<vscode.QuickInput>;
  clearPreview?: () => Promise<void>;
  releaseContextListener?: () => void;
};
let owner: PairOperation | undefined;
async function closeOperation(
  operation: PairOperation | undefined,
): Promise<void> {
  if (!operation) return;
  operation.cancelled = true;
  if (owner === operation) owner = undefined;
  const client = operation.client;
  operation.client = undefined;
  for (const picker of operation.pickers) {
    picker.hide();
    picker.dispose();
  }
  operation.pickers.clear();
  operation.review?.cancel();
  const reviewCleanup = operation.review?.dispose();
  operation.review = undefined;
  const cleanup = operation.clearPreview?.();
  await client?.close();
  await cleanup;
  await reviewCleanup;
  operation.journal = undefined;
}
function reviewFailure(
  operation: PairOperation,
  mode: CodeContext["mode"],
): () => void {
  return () => {
    void closeOperation(operation);
    void vscode.window.showErrorMessage(
      mode === "replace_focus_file"
        ? "Sage stopped replacement. Current buffer and disk were preserved; a dispatched save may have completed. Capture fresh context before another attempt."
        : "Sage stopped creation. Existing and partial files were preserved; capture fresh context before another attempt.",
    );
  };
}
function input<T extends vscode.QuickPickItem>(
  operation: PairOperation,
  items: T[],
  title: string,
  many = false,
): Promise<readonly T[] | undefined> {
  operation.guard?.();
  return new Promise((resolve, reject) => {
    const picker = vscode.window.createQuickPick<T>();
    operation.pickers.add(picker);
    picker.items = items;
    picker.title = title;
    picker.placeholder = title;
    picker.canSelectMany = many;
    picker.ignoreFocusOut = true;
    let settled = false;
    const done = (value?: readonly T[]) => {
      if (settled) return;
      settled = true;
      operation.pickers.delete(picker);
      accept.dispose();
      hide.dispose();
      picker.dispose();
      try {
        operation.guard?.();
        resolve(value);
      } catch (error) {
        reject(error);
      }
    };
    const accept = picker.onDidAccept(() => done([...picker.selectedItems]));
    const hide = picker.onDidHide(() => done());
    picker.show();
  });
}
export function activate(context: vscode.ExtensionContext): void {
  const windowId = randomBytes(16).toString("hex");
  let generation = 0;
  const contents = new Map<string, string>();
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const current = () =>
    localWorkspace(
      {
        trusted: vscode.workspace.isTrusted,
        remoteName: vscode.env.remoteName,
        uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? "desktop" : "web",
        folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
          uri: folder.uri.toString(),
        })),
      },
      windowId,
    );
  current();
  const previewProvider = vscode.workspace.registerTextDocumentContentProvider(
    "sage-context",
    {
      onDidChange: changed.event,
      provideTextDocumentContent: (uri) =>
        contents.get(uri.toString()) ?? "Disclosure expired or cancelled.",
    },
  );
  const clearPreview = (operation: PairOperation): Promise<void> => {
    const captured = operation.context,
      uri = operation.preview,
      sent = operation.sent;
    operation.releaseContextListener?.();
    operation.releaseContextListener = undefined;
    operation.context = undefined;
    operation.preview = undefined;
    operation.sent = false;
    operation.applied = false;
    if (operation.timer) clearTimeout(operation.timer);
    operation.timer = undefined;
    if (captured) releaseContext(captured);
    if (uri) {
      contents.delete(uri.toString());
      changed.fire(uri);
    }
    const tabs = uri
      ? vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .filter(
            (tab) =>
              tab.input instanceof vscode.TabInputText &&
              tab.input.uri.toString() === uri.toString(),
          )
      : [];
    return (async () => {
      if (sent && captured && operation.client)
        await operation.client.send({
          kind: "result.dismissed",
          binding: captured.binding,
          payload: null,
        });
      if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    })();
  };
  const dispose = () => {
    void closeOperation(owner);
  };
  context.subscriptions.push(
    { dispose },
    changed,
    previewProvider,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      generation++;
      dispose();
    }),
  );
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      const operation = owner;
      if (
        operation?.preview &&
        !operation.applied &&
        event.closed.some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === operation.preview?.toString(),
        )
      )
        void closeOperation(operation);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("sage.pairLocalEditor", async () => {
      if (owner?.pending) return;
      const previous = owner,
        operation: PairOperation = {
          pending: true,
          cancelled: false,
          pickers: new Set(),
        };
      owner = operation;
      operation.clearPreview = () => clearPreview(operation);
      let ticket: string | undefined;
      try {
        await closeOperation(previous);
        const rawRootUri =
          vscode.workspace.workspaceFolders?.[0].uri.toString();
        if (!rawRootUri) throw Error("No folder");
        const rawUrl = new URL(rawRootUri);
        if (
          rawUrl.protocol !== "file:" ||
          rawUrl.host ||
          rawUrl.search ||
          rawUrl.hash ||
          rawUrl.href !== rawRootUri
        )
          throw Error("Invalid local folder");
        const pairedGeneration = generation,
          workspace = current();
        const guard = () => {
          if (
            operation.cancelled ||
            owner !== operation ||
            pairedGeneration !== generation ||
            vscode.workspace.workspaceFolders?.[0].uri.toString() !==
              rawRootUri ||
            JSON.stringify(current()) !== JSON.stringify(workspace)
          )
            throw Error("Pairing operation changed");
        };
        operation.guard = guard;
        operation.rawRootUri = rawRootUri;
        operation.generation = pairedGeneration;
        guard();
        await mkdir(context.globalStorageUri.fsPath, {
          recursive: true,
          mode: 0o700,
        });
        guard();
        operation.nativeIdentity = await probeRoot(
          fileURLToPath(rawRootUri),
          context.extensionPath,
          context.globalStorageUri.fsPath,
          guard,
        );
        guard();
        operation.journal = new EffectJournal(
          vscode.Uri.file(
            join(context.globalStorageUri.fsPath, "effect-journal"),
          ),
        );
        await operation.journal.expire(new Date());
        guard();
        ticket = await vscode.window.showInputBox({
          title: "Pair local Sage",
          prompt: "Enter the one-use Sage pairing ticket",
          placeHolder: "Sage pairing ticket",
          password: true,
          ignoreFocusOut: true,
        });
        if (!ticket) return;
        guard();
        const client = new ExtensionBridge({
          guard,
          onClose: () => {
            void closeOperation(operation);
          },
          confirm: async (view) => {
            guard();
            const choice = await vscode.window.showWarningMessage(
              "Pair Sage with this local folder?",
              {
                modal: true,
                detail: `Folder: ${view.root_uri}\nWindow: ${view.window_id}\nChallenge: ${view.challenge}\nNo source is shared by pairing.`,
              },
              "Pair this folder",
            );
            guard();
            return choice === "Pair this folder";
          },
        });
        operation.client = client;
        const pairing = client.pair(ticket, workspace);
        ticket = undefined;
        operation.pair = await pairing;
        guard();
        const review = new ProposalReview({
          bridge: client,
          journal: operation.journal!,
          guard,
          onFailure: () => closeOperation(operation),
          onApplied: () => {
            guard();
            operation.applied = true;
          },
        });
        operation.review = review;
        client.onData((message) => {
          if (message.kind === "proposal.offer") {
            const captured = operation.context;
            if (!captured || !operation.sent || operation.applied)
              throw Error("No current selected context");
            // Return to the receive pump so grant/ACK frames can complete the local gesture.
            operation.reviewTask = review
              .show(captured, message.payload)
              .catch(reviewFailure(operation, captured.mode));
          }
        });
        void vscode.window.showInformationMessage(
          "Sage paired with this local folder. No source has been shared.",
        );
      } catch {
        const cancelled = operation.cancelled;
        await closeOperation(operation);
        if (!cancelled)
          void vscode.window.showErrorMessage(
            "Sage could not pair. Use a fresh ticket in a trusted local single-folder desktop window.",
          );
      } finally {
        ticket = undefined;
        operation.pending = false;
        if (!operation.client && owner === operation) owner = undefined;
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("sage.captureContext", async () => {
      const operation = owner;
      if (
        !operation?.client ||
        !operation.pair ||
        !operation.guard ||
        operation.pending
      )
        return;
      operation.pending = true;
      try {
        const guard = operation.guard;
        guard();
        await clearPreview(operation);
        guard();
        const mode = (
          await input(
            operation,
            [
              {
                label: "Create focus project",
                mode: "create_focus_project" as const,
              },
              {
                label: "Replace one focus file",
                mode: "replace_focus_file" as const,
              },
            ],
            "Sage: Choose context mode",
          )
        )?.[0]?.mode;
        if (!mode) return;
        guard();
        let target: FocusName | undefined,
          names: FocusName[] = [];
        if (mode === "replace_focus_file") {
          target = (
            await input(
              operation,
              FOCUS_NAMES.map((name) => ({ label: name, name })),
              "Sage: Choose replacement target",
            )
          )?.[0]?.name;
          if (!target) return;
          guard();
          const additional = await input(
            operation,
            FOCUS_NAMES.filter((name) => name !== target).map((name) => ({
              label: name,
              name,
            })),
            "Sage: Select 0–3 additional read-only manifest files",
            true,
          );
          if (!additional) return;
          guard();
          names = [target, ...additional.map((item) => item.name)];
        }
        const capturedAtMs = Date.now();
        operation.timer = setTimeout(() => {
          void closeOperation(operation);
        }, 1800000);
        let diagnosticIds: string[] = [];
        if (names.length) {
          const choice = (
            await input(
              operation,
              [
                { label: "No diagnostics", include: false },
                { label: "Select diagnostics", include: true },
              ],
              "Sage: Optional selected diagnostics",
            )
          )?.[0];
          if (!choice) return;
          guard();
          if (choice.include) {
            const choices = diagnosticChoices(
              names,
              fileURLToPath(operation.rawRootUri!),
            );
            guard();
            const selected = await input(
              operation,
              choices.map((item) => ({ label: item.text, id: item.id })),
              "Sage: Select diagnostics to disclose",
              true,
            );
            if (!selected) return;
            guard();
            diagnosticIds = selected.map((item) => item.id);
          }
        }
        const captured = await captureContext({
          pair: operation.pair,
          binding: {
            job_id: randomBytes(16).toString("hex"),
            boot_id: operation.pair.host_boot_id,
            pair_id: operation.pair.pair_id,
            window_id: windowId,
            root_id: operation.pair.root_id,
            revision: 1,
            policy_version: "code-v1",
          },
          generation: operation.generation!,
          rawRootUri: operation.rawRootUri!,
          nativeIdentity: operation.nativeIdentity!,
          extensionPath: context.extensionPath,
          storagePath: context.globalStorageUri.fsPath,
          mode,
          ...(target ? { target } : {}),
          names,
          diagnosticIds,
          capturedAtMs,
          guard,
        });
        try {
          guard();
        } catch (error) {
          releaseContext(captured);
          throw error;
        }
        operation.context = captured;
        operation.releaseContextListener = onContextRelease(
          captured,
          closeOperation.bind(undefined, operation),
        );
        contextOffer(captured);
        const uri = vscode.Uri.parse(
          `sage-context:/${randomBytes(16).toString("hex")}/selected-disclosure.txt`,
        );
        operation.preview = uri;
        contents.set(
          uri.toString(),
          `Selected disclosure to local Sage\nSending this context does not call a cloud model.\nFolder: ${captured.root_uri}\nContext hash: ${captured.context_hash}\n${disclosureSummary(captured).join("\n")}\n\n${captured.files.map((file) => `--- ${file.name} (version ${file.document_version}, SHA256 ${file.text_hash}) ---\n${file.text}`).join("\n")}\nSelected diagnostics:\n${(captured.diagnostics ?? []).join("\n")}\n\nUse Sage: Send Selected Context to send exactly this snapshot, or Sage: Cancel Context.\n`,
        );
        const document = await vscode.workspace.openTextDocument(uri);
        guard();
        contextOffer(captured);
        await vscode.window.showTextDocument(document, {
          preview: true,
          preserveFocus: false,
        });
        guard();
        contextOffer(captured);
      } catch {
        await closeOperation(operation);
        void vscode.window.showErrorMessage(
          "Sage refused the selected context because the folder, document, encoding, or snapshot changed.",
        );
      } finally {
        operation.pending = false;
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("sage.sendContext", async () => {
      const operation = owner,
        captured = operation?.context;
      if (
        !operation?.client ||
        !captured ||
        !operation.guard ||
        operation.pending ||
        operation.sent
      )
        return;
      operation.pending = true;
      try {
        operation.guard();
        await validateContext(captured);
        operation.guard();
        const summary = disclosureSummary(captured);
        const selected = await input(
          operation,
          [
            {
              label: "Send selected context to local Sage",
              description: `Target: ${captured.target ?? "new empty project"}; ${summary.at(-1)}`,
              send: true,
            },
            { label: "Keep local", send: false },
            ...summary.map((label) => ({
              label,
              alwaysShow: true,
              send: false,
            })),
          ],
          "Sage: Confirm selected disclosure",
        );
        if (!selected?.[0]?.send) return;
        operation.guard();
        if (operation.context !== captured) throw Error("Context changed");
        await validateContext(captured);
        operation.guard();
        await operation.client.send({
          kind: "context.offer",
          binding: captured.binding,
          payload: contextOffer(captured),
        });
        operation.guard();
        operation.sent = true;
      } catch {
        await closeOperation(operation);
        void vscode.window.showErrorMessage(
          "Sage could not send the snapshot. Capture and review fresh context.",
        );
      } finally {
        operation.pending = false;
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("sage.cancelContext", async () => {
      await closeOperation(owner);
    }),
  );
}
export async function deactivate(): Promise<void> {
  await closeOperation(owner);
}
