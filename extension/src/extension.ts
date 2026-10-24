/** Minimal local pairing shell. Source selection and native effects belong to later slices. */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ExtensionBridge, localWorkspace } from "./bridge";
let bridge: ExtensionBridge | undefined;
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
    void bridge?.close();
    bridge = undefined;
  };
  context.subscriptions.push(
    { dispose },
    vscode.workspace.onDidChangeWorkspaceFolders(dispose),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("sage.pairLocalEditor", async () => {
      try {
        const workspace = current();
        await bridge?.close();
        bridge = undefined;
        let ticket = await vscode.window.showInputBox({
          title: "Pair local Sage",
          prompt: "Enter the one-use Sage pairing ticket",
          placeHolder: "Sage pairing ticket",
          password: true,
          ignoreFocusOut: true,
        });
        if (!ticket) return;
        const guard = () => {
          if (JSON.stringify(current()) !== JSON.stringify(workspace))
            throw new Error("Workspace changed");
        };
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
        bridge = client;
        const pairing = client.pair(ticket, workspace);
        ticket = undefined;
        await pairing;
        guard();
        void vscode.window.showInformationMessage(
          "Sage paired with this local folder. No source has been shared.",
        );
      } catch {
        dispose();
        void vscode.window.showErrorMessage(
          "Sage could not pair. Use a fresh ticket in a trusted local single-folder desktop window.",
        );
      }
    }),
  );
}
export async function deactivate(): Promise<void> {
  await bridge?.close();
  bridge = undefined;
}
