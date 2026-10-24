/** Minimal local pairing shell. Source selection and native effects belong to later slices. */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ExtensionBridge, localWorkspace } from "./bridge";
type PairOperation = {
  client?: ExtensionBridge;
  pending: boolean;
  cancelled: boolean;
};
let owner: PairOperation | undefined;
async function closeOperation(
  operation: PairOperation | undefined,
): Promise<void> {
  if (!operation) return;
  operation.cancelled = true;
  if (owner === operation) owner = undefined;
  await operation.client?.close();
  operation.client = undefined;
}
export function activate(context: vscode.ExtensionContext): void {
  const windowId = randomBytes(16).toString("hex");
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
  // Fail activation in unsupported environments even if the manifest guard changes.
  current();
  const dispose = () => {
    void closeOperation(owner);
  };
  context.subscriptions.push(
    { dispose },
    vscode.workspace.onDidChangeWorkspaceFolders(dispose),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("sage.pairLocalEditor", async () => {
      // Claim ownership before any await, including old-client disposal and prompts.
      if (owner?.pending) return;
      const previous = owner;
      const operation: PairOperation = { pending: true, cancelled: false };
      owner = operation;
      let ticket: string | undefined;
      try {
        await closeOperation(previous);
        const workspace = current();
        const guard = () => {
          if (
            operation.cancelled ||
            owner !== operation ||
            JSON.stringify(current()) !== JSON.stringify(workspace)
          )
            throw new Error("Pairing operation changed");
        };
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
        await pairing;
        guard();
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
}
export async function deactivate(): Promise<void> {
  await closeOperation(owner);
}
