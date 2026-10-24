/** Isolated test driver only; excluded from every product package and exports no API. */
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert } from "node:assert";
async function emitReceipt(path: string, data: unknown): Promise<void> {
  await writeFile(path + ".pending", JSON.stringify(data), { flag: "wx" });
  await rename(path + ".pending", path);
}
let stage = "setup";
export function activate(): void {
  void run().catch(async () => {
    const fixture = process.env.SAGE_OWNED_FIXTURE;
    if (fixture)
      await emitReceipt(join(fixture, "failure.json"), {
        status: "failed",
        pid: process.pid,
        stage,
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
    }
  }
  await emitReceipt(join(fixture, `complete-${config.phase}.json`), {
    ...receipt,
    product_active: productState(),
    packaged: config.packaged,
    package_hash: config.packageHash ?? null,
  });
}
