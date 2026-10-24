/** Isolated test driver only; excluded from every product package and exports no API. */
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const workspaceDeadline = Date.now() + 20000;
  while (
    vscode.workspace.workspaceFolders === undefined &&
    Date.now() < workspaceDeadline
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);
  assert.equal(
    vscode.workspace.workspaceFolders![0].uri.fsPath,
    fileURLToPath(config.expectedRoot),
  );
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
      if (config.selectedCase === "replace") {
        stage = "replace-capture";
        const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
        const path = join(root, "focus.js");
        await writeFile(
          path,
          (await readFile(join(config.fixtureSource, "focus.js"), "utf8")) +
            "\n// human baseline 😀\n",
        );
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(path),
        );
        const editor = await vscode.window.showTextDocument(doc, {
          preview: false,
        });
        const sourceVersion = doc.version;
        const scenario = config.replaceScenario ?? "success";
        const realNow = Date.now;
        const listener = vscode.workspace.onWillSaveTextDocument((event) => {
          if (event.document !== doc || scenario === "success") return;
          if (scenario === "participant")
            event.waitUntil(
              Promise.resolve([
                vscode.TextEdit.insert(
                  new vscode.Position(0, 0),
                  "// real participant\n",
                ),
              ]),
            );
          if (
            scenario === "human-save" ||
            scenario === "disconnect-save" ||
            scenario === "expiry-save" ||
            scenario === "external-save"
          )
            event.waitUntil(
              (async () => {
                editor.selection = new vscode.Selection(0, 0, 0, 0);
                if (scenario === "expiry-save")
                  Date.now = () => realNow() + 1800001;
                await emitReceipt(join(fixture, "save-pending.json"), {
                  scenario,
                });
                const deadline = realNow() + 10000;
                while (realNow() < deadline) {
                  try {
                    await readFile(join(fixture, "save-release.json"));
                    if (scenario === "expiry-save") {
                      await vscode.commands.executeCommand(
                        "sage.cancelContext",
                      );
                      const views = vscode.workspace.textDocuments.filter(
                        (d) =>
                          d.uri.scheme === "sage-diff" ||
                          d.uri.scheme === "sage-context",
                      );
                      for (
                        let i = 0;
                        i < 100 &&
                        views.some(
                          (d) => !d.getText().includes("expired or cancelled"),
                        );
                        i++
                      )
                        await new Promise((r) => setTimeout(r, 10));
                      assert.ok(
                        views.every((d) =>
                          d.getText().includes("expired or cancelled"),
                        ),
                      );
                      await assert.rejects(
                        readFile(join(fixture, "save-settled.json")),
                      );
                      await emitReceipt(
                        join(
                          fixture,
                          "source-revoked-before-save-settled.json",
                        ),
                        {
                          source_views_cleared: true,
                          save_still_pending: true,
                          synthetic_clock: true,
                        },
                      );
                    }
                    return [];
                  } catch {
                    await new Promise((r) => setTimeout(r, 10));
                  }
                }
                throw Error("owned pending save release deadline");
              })(),
            );
          if (scenario === "cancel-save")
            event.waitUntil(
              (async () => {
                await vscode.commands.executeCommand("sage.cancelContext");
                return [];
              })(),
            );
        });
        const savedListener = vscode.workspace.onDidSaveTextDocument(
          (saved) => {
            if (saved === doc)
              void emitReceipt(join(fixture, "save-settled.json"), {
                scenario,
              });
          },
        );
        await vscode.commands.executeCommand("sage.captureContext");
        await vscode.commands.executeCommand("sage.sendContext");
        const end = realNow() + 60000;
        while (realNow() < end) {
          try {
            await readFile(join(fixture, "replace-finished.json"));
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        const expected =
          (await readFile(join(config.fixtureSource, "focus.js"), "utf8")) +
          "\n// human baseline 😀\n\n// approved followup\n";
        listener.dispose();
        savedListener.dispose();
        Date.now = realNow;
        const wanted =
          scenario === "auto-save"
            ? expected.slice(0, -"\n// approved followup\n".length)
            : scenario === "participant"
              ? "// real participant\n" + expected
              : scenario === "human-save"
                ? "// pending human\n// " + expected
                : expected;
        assert.equal(doc.getText(), wanted);
        if (scenario === "success") {
          assert.equal(doc.version, sourceVersion + 1);
          await emitReceipt(join(fixture, "replace-version.json"), {
            source_version: sourceVersion,
            saved_version: doc.version,
            one_transaction_delta: doc.version - sourceVersion,
          });
        }
        assert.equal(doc.isDirty, scenario === "external-save");
        assert.equal(
          await readFile(path, "utf8"),
          scenario === "external-save" ? "// external pending human\n" : wanted,
        );
        stage = "replace-native-races";
        const { runReplacementEditorRaces } =
          await import("../integration/replace");
        if (scenario === "success")
          await emitReceipt(
            join(fixture, "replace-races.json"),
            await runReplacementEditorRaces(product.extensionPath, fixture),
          );
      }
      if (
        config.selectedCase === "create" ||
        config.selectedCase === "test-runner"
      ) {
        stage = "create-capture";
        assert.deepEqual(
          await import("node:fs/promises").then((fs) =>
            fs.readdir(vscode.workspace.workspaceFolders![0].uri.fsPath),
          ),
          [],
        );
        await vscode.commands.executeCommand("sage.captureContext");
        const preview = vscode.window.activeTextEditor?.document;
        assert.equal(preview?.uri.scheme, "sage-context");
        stage = "create-send";
        await vscode.commands.executeCommand("sage.sendContext");
        await emitReceipt(join(fixture, "create-disclosure-sent.json"), {
          ...receipt,
        });
        stage = "create-diffs";
        const end = Date.now() + 30000;
        let diffs: vscode.TabInputTextDiff[] = [];
        while (Date.now() < end) {
          diffs = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .flatMap((t) =>
              t.input instanceof vscode.TabInputTextDiff &&
              t.input.original.scheme === "sage-diff"
                ? [t.input]
                : [],
            );
          if (diffs.length === 4) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(diffs.length, 4);
        const checked = [];
        for (const name of [
          "index.html",
          "focus.js",
          "focus.test.mjs",
          "README.md",
        ]) {
          const diff = diffs.find((d) => d.modified.path.endsWith("/" + name));
          assert.ok(diff);
          const before = await vscode.workspace.openTextDocument(diff.original),
            after = await vscode.workspace.openTextDocument(diff.modified);
          let expected = await readFile(
            join(config.fixtureSource, name),
            "utf8",
          );
          if (
            config.selectedCase === "test-runner" &&
            name === "focus.test.mjs"
          ) {
            const { focusTestSuffix } =
              await import("../integration/test-runner");
            expected += focusTestSuffix(config.testScenario ?? "success");
          }
          assert.equal(before.getText(), "");
          assert.equal(after.getText(), expected);
          assert.equal(before.isDirty, false);
          assert.equal(after.isDirty, false);
          checked.push({
            name,
            sha256: createHash("sha256").update(expected).digest("hex"),
            bytes: Buffer.byteLength(expected),
          });
        }
        await emitReceipt(join(fixture, "diffs-checked.json"), {
          ...receipt,
          diffs: checked,
          literal_readonly: true,
        });
        if (config.selectedCase === "test-runner") {
          const { runNativeEnvironmentFixture } =
            await import("../integration/test-runner");
          await runNativeEnvironmentFixture(fixture);
        }
        stage = "create-result";
        let resultInspected = false;
        while (Date.now() < end + 30000) {
          if (config.selectedCase === "test-runner" && !resultInspected) {
            try {
              await readFile(join(fixture, "test-result-ready.json"));
              const result = vscode.window.activeTextEditor?.document;
              assert.equal(result?.uri.scheme, "sage-diff");
              assert.ok(result!.getText().startsWith("Fixed test result:"));
              assert.ok(
                result!
                  .getText()
                  .includes("Generated tests do not certify app behavior"),
              );
              assert.equal(result!.isDirty, false);
              resultInspected = true;
              await writeFile(
                join(fixture, "test-result-inspected.json"),
                JSON.stringify({
                  readonly: true,
                  warning: true,
                  result_uri: result!.uri.toString(),
                }),
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
          try {
            await readFile(join(fixture, "create-finished.json"));
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        assert.ok(await readFile(join(fixture, "create-finished.json")));
      }
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
        const contextHash = /Context hash: ([0-9a-f]{64})/.exec(
          preview.getText(),
        )?.[1];
        assert.ok(contextHash);
        const fileHash = createHash("sha256")
          .update("export const nativeMarker = '😀';\n")
          .digest("hex");
        const summary = [
          "Mode: replace_focus_file",
          "Selected manifest (1 existing): focus.js",
          "Target: focus.js",
          "Read-only scope: none",
          `Context SHA256 (1/2): ${contextHash.slice(0, 32)}`,
          `Context SHA256 (2/2): ${contextHash.slice(32)}`,
          "focus.js source: 33 code points",
          `focus.js text SHA256 (1/2): ${fileHash.slice(0, 32)}`,
          `focus.js text SHA256 (2/2): ${fileHash.slice(32)}`,
          `focus.js disk SHA256 (1/2): ${fileHash.slice(0, 32)}`,
          `focus.js disk SHA256 (2/2): ${fileHash.slice(32)}`,
          "Source: 33 code points",
          "Selected diagnostics: 0 code points (0 selected)",
          "Provider-visible metadata: 34 code points",
          "Total: 67 / 64000 code points",
        ];
        assert.ok(preview.getText().includes(summary.join("\n")));
        assert.equal(preview.isDirty, false);
        await emitReceipt(join(fixture, "context-preview.json"), {
          ...receipt,
          preview_readonly: true,
          preview_summary_checked: true,
          summary,
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
          preview_summary_checked: true,
          summary,
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
