/** Isolated test driver only; excluded from every product package and exports no API. */
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { runContextFixture } from "../integration/context";
import { strict as assert } from "node:assert";
async function emitReceipt(path: string, data: unknown): Promise<void> {
  await writeFile(path + ".pending", JSON.stringify(data), { flag: "wx" });
  await rename(path + ".pending", path);
}
let stage = "setup";
export function activate(): void {
  void run().catch(async (error) => {
    const fixture = process.env.SAGE_OWNED_FIXTURE;
    if (fixture)
      await emitReceipt(join(fixture, "failure.json"), {
        status: "failed",
        pid: process.pid,
        stage,
        error:
          error instanceof Error ? error.message.slice(0, 2048) : "unknown",
        trusted: vscode.workspace.isTrusted,
        trust_enabled: vscode.workspace
          .getConfiguration("security.workspace.trust")
          .get("enabled"),
      });
  });
}
async function run(): Promise<void> {
  const fixture = process.env.SAGE_OWNED_FIXTURE;
  if (!fixture) throw Error("Missing owned fixture");
  const config = JSON.parse(await readFile(join(fixture, "case.json"), "utf8"));
  const productBuild = JSON.parse(
    await readFile(join(vscode.env.appRoot, "product.json"), "utf8"),
  );
  assert.equal(productBuild.commit, "e646868227c3e3a9e3f24277c8c7220be42c0be7");
  const trusted = vscode.workspace.isTrusted,
    enabled = vscode.workspace
      .getConfiguration("security.workspace.trust")
      .get("enabled");
  stage = "trust-fixture";
  assert.equal(enabled, true);
  assert.equal(trusted, config.trusted);
  assert.equal(vscode.env.remoteName, undefined);
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);
  const productState = () =>
    vscode.extensions.getExtension("sage-local.sage-editor-bridge")?.isActive ??
    false;
  const receipt = {
    nonce: config.nonce,
    lane: config.lane,
    phase: config.phase,
    pid: process.pid,
    ppid: process.ppid,
    trusted,
    trust_enabled: enabled,
    vscode: vscode.version,
    product_commit: productBuild.commit,
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    root_uri: vscode.workspace.workspaceFolders![0].uri.toString(),
    status: "completed",
    product_active: productState(),
    packaged: config.packaged,
    package_hash: config.packageHash ?? null,
  };
  const product = vscode.extensions.getExtension(
    "sage-local.sage-editor-bridge",
  );
  if (!trusted) {
    stage = "restricted-inactive-before";
    assert.equal(product?.isActive ?? false, false);
    stage = "restricted-command-inert";
    try {
      await vscode.commands.executeCommand("sage.pairLocalEditor");
    } catch {
      /* Disabled command may reject or resolve without activating. */
    }
    assert.equal(product?.isActive ?? false, false);
  } else {
    assert.ok(product);
    if (config.packaged) {
      assert.equal(product.extensionPath, config.productPath);
      assert.equal(
        createHash("sha256")
          .update(
            await readFile(join(product.extensionPath, "dist/extension.cjs")),
          )
          .digest("hex"),
        config.bundleHash,
      );
    }
    assert.equal(product.isActive, false);
    assert.equal(await product.activate(), undefined);
    assert.equal(product.isActive, true);
    assert.ok(
      (await vscode.commands.getCommands(true)).includes(
        "sage.pairLocalEditor",
      ),
    );
    if (config.phase === "initial") {
      await emitReceipt(join(fixture, "ready.json"), {
        ...receipt,
        status: "ready",
      });
      await vscode.commands.executeCommand("sage.pairLocalEditor");
      if (config.selectedCase === "context" || config.selectedCase === "all") {
        stage = "context-preview";
        const other = vscode.Uri.file(join(fixture, "unrelated.txt"));
        await writeFile(other.fsPath, "owned unrelated tab");
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(other),
          { preview: false },
        );
        await writeFile(
          join(vscode.workspace.workspaceFolders![0].uri.fsPath, "focus.js"),
          "export const nativeMarker = '😀';\n",
        );
        await vscode.commands.executeCommand("sage.captureContext");
        const preview = vscode.window.activeTextEditor?.document;
        assert.ok(preview);
        assert.equal(preview.uri.scheme, "sage-context");
        assert.ok(
          preview.getText().includes("Selected disclosure to local Sage"),
        );
        assert.equal(preview.isDirty, false);
        await emitReceipt(join(fixture, "context-preview.json"), {
          ...receipt,
          preview_readonly: true,
          preview_uri: preview.uri.toString(),
        });
        stage = "context-send";
        await vscode.commands.executeCommand("sage.sendContext");
        stage = "context-cancel";
        await vscode.commands.executeCommand("sage.cancelContext");
        assert.ok(
          vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .some(
              (t) =>
                t.input instanceof vscode.TabInputText &&
                t.input.uri.toString() === other.toString(),
            ),
        );
        const cleared = await vscode.workspace.openTextDocument(preview.uri);
        for (
          let attempt = 0;
          attempt < 100 &&
          cleared.getText() !== "Disclosure expired or cancelled.";
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(cleared.getText(), "Disclosure expired or cancelled.");
        stage = "context-native-snapshot";
        const proof = await runContextFixture(product.extensionPath, fixture);
        await emitReceipt(join(fixture, "context-native.json"), {
          ...receipt,
          ...proof,
          product_active: product.isActive,
          preview_cleared: true,
          unrelated_tab_preserved: true,
        });
      }
    }
  }
  await emitReceipt(join(fixture, `complete-${config.phase}.json`), {
    ...receipt,
    product_active: productState(),
    packaged: config.packaged,
    package_hash: config.packageHash ?? null,
  });
}
