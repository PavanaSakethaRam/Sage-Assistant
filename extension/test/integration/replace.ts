/** Real owned editor controls + authenticated bridge + actual CoreService/SQLite. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { EffectJournal, receiptProjection } from "../../src/journal";
import { isolatedChildEnv } from "../../../desktop/main/child-env";
import { EditorBridgeHost } from "../../../desktop/main/editor-bridge";
import {
  parseCodeJobView,
  parseHostCodingControl,
  parseHostCodingReply,
  type CodingControlInput,
  type HostCodingReply,
  type CodeJobView,
} from "../../../desktop/shared/coding-contracts";
import type { PairView } from "../../../desktop/shared/editor-bridge";
export type ReplaceScenario =
  | "success"
  | "participant"
  | "human-save"
  | "cancel-save"
  | "disconnect-save"
  | "expiry-save"
  | "external-save"
  | "auto-save";
export async function replaceThroughWorkbench(
  page: Page,
  fixture: string,
  root: string,
  scenario: ReplaceScenario,
) {
  const state = join(fixture, "core");
  await mkdir(state, { mode: 0o700 });
  await mkdir(join(state, "tmp"));
  const child = spawn(
    resolve(
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    ),
    ["-I", resolve("e2e/fixtures/coding_core.py"), "--root", state],
    {
      cwd: state,
      env: isolatedChildEnv({
        LANG: "C.UTF-8",
        TMPDIR: join(state, "tmp"),
        TMP: join(state, "tmp"),
        TEMP: join(state, "tmp"),
      }),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let pending:
      | { resolve: (value: unknown) => void; reject: (e: Error) => void }
      | undefined,
    stderr = "",
    generation = 0,
    job: CodeJobView | undefined,
    view: PairView | undefined,
    observationCalls = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const p = pending;
    pending = undefined;
    if (!p) return;
    try {
      assert.ok(Buffer.byteLength(line) <= 1048576);
      p.resolve(JSON.parse(line));
    } catch (e) {
      p.reject(e as Error);
    }
  });
  child.stderr.on("data", (b) => {
    stderr += b.toString();
    if (stderr.length > 8192) child.kill();
  });
  child.on("exit", () => {
    pending?.reject(
      Error("Owned Core fixture stopped: " + stderr.slice(0, 2048)),
    );
    pending = undefined;
  });
  let tail: Promise<unknown> = Promise.resolve();
  const call = (value: unknown): Promise<unknown> => {
    const work = tail.then(
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending = undefined;
            reject(Error("Core fixture deadline"));
            child.kill();
          }, 30000);
          pending = {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          };
          child.stdin.write(JSON.stringify(value) + "\n");
        }),
    );
    tail = work.catch(() => {});
    return work;
  };
  const control = async (
    input: CodingControlInput,
  ): Promise<HostCodingReply> => {
    const value = parseHostCodingControl({
      version: 1,
      kind: "host_coding",
      host_boot_id: "a".repeat(32),
      generation: ++generation,
      id: randomUUID(),
      ...input,
    });
    return parseHostCodingReply(await call(value), value);
  };
  const status = async (jobId: string) => {
    const response = (await call({
      version: 1,
      kind: "request",
      id: randomUUID(),
      method: "coding.get",
      params: { job_id: jobId },
    })) as { result: unknown };
    return parseCodeJobView(response.result);
  };
  const host = new EditorBridgeHost({
    onPair: (v) => {
      view = v;
    },
    onData: () => {
      throw Error("Unexpected native fixture data");
    },
    onJobStatus: (j) => {
      job = j;
    },
    codingStatus: status,
    codingControl: async (input) => {
      if (input.operation === "observation") observationCalls++;
      let reply: HostCodingReply;
      try {
        reply = await control(input);
      } catch (error) {
        await writeFile(
          join(fixture, `core-control-failure-${input.operation}.json`),
          JSON.stringify({
            operation: input.operation,
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
        throw error;
      }
      await writeFile(
        join(fixture, "core-control-last.json"),
        JSON.stringify({ operation: input.operation }),
      );
      return reply;
    },
  });
  const select = async (placeholder: string, label: string) => {
    const input = page.getByPlaceholder(placeholder, { exact: true });
    await input.waitFor({ timeout: 20000 });
    await input.fill(label);
    await page
      .locator(".quick-input-widget")
      .filter({ has: input })
      .getByText(label, { exact: true })
      .first()
      .click();
  };
  const wait = async (check: () => Promise<boolean>) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("Native create proof deadline");
  };
  const finish = async () => {
    await host.close();
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Core fixture shutdown deadline"));
      }, 5000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    lines.close();
    assert.equal(stderr, "");
  };
  try {
    const ticket = await host.start();
    const input = page.getByPlaceholder("Sage pairing ticket", { exact: true });
    await input.waitFor({ timeout: 20000 });
    await input.fill(Buffer.from(JSON.stringify(ticket)).toString("base64url"));
    await input.press("Enter");
    const pair = page.getByRole("button", {
      name: "Pair this folder",
      exact: true,
    });
    await pair.waitFor({ timeout: 20000 });
    assert.ok(view);
    await pair.click();
    assert.equal((await host.confirm(view.pair_id)).status, "paired");
    await select("Sage: Choose context mode", "Replace one focus file");
    await select("Sage: Choose replacement target", "focus.js");
    await page
      .getByPlaceholder(
        "Sage: Select 0–3 additional read-only manifest files",
        { exact: true },
      )
      .press("Enter");
    await select("Sage: Optional selected diagnostics", "No diagnostics");
    await select(
      "Sage: Confirm selected disclosure",
      "Send selected context to local Sage",
    );
    const baseline = await readFile(join(root, "focus.js"), "utf8");
    const expected = baseline + "\n// approved followup\n";
    await wait(
      async () =>
        (await page
          .getByPlaceholder("Sage: Review focus project", { exact: true })
          .count()) > 0 ||
        (await page
          .getByText("Sage stopped replacement.", { exact: false })
          .count()) > 0,
    );
    if (
      (await page
        .getByPlaceholder("Sage: Review focus project", { exact: true })
        .count()) === 0
    ) {
      assert.equal(
        await readFile(join(root, "focus.js"), "utf8"),
        expected,
        "actual editor replacement must reach disk",
      );
    }
    await select("Sage: Review focus project", "Review focus.js");
    await page
      .getByRole("button", { name: "Continue review", exact: true })
      .click();
    await select("Sage: Review focus project", "Apply and save this file");
    await page
      .getByRole("button", { name: "Apply and save this file", exact: true })
      .click();
    if (
      scenario === "human-save" ||
      scenario === "disconnect-save" ||
      scenario === "expiry-save" ||
      scenario === "external-save"
    ) {
      await wait(async () => {
        try {
          return !!(await readFile(join(fixture, "save-pending.json")));
        } catch {
          return false;
        }
      });
      if (scenario === "human-save")
        await page.keyboard.insertText("// pending human\n");
      if (scenario === "disconnect-save") await host.close();
      if (scenario === "external-save")
        await writeFile(join(root, "focus.js"), "// external pending human\n");
      await writeFile(join(fixture, "save-release.json"), "{}");
    }
    if (scenario === "auto-save") {
      await wait(
        async () =>
          (await page
            .getByText("Sage stopped replacement.", { exact: false })
            .count()) > 0,
      );
    } else if (
      scenario === "participant" ||
      scenario === "human-save" ||
      scenario === "external-save"
    ) {
      await wait(
        async () =>
          !!job && (await status(job.binding.job_id)).state === "needs_review",
      );
      const resume = page.getByRole("button", {
        name: "Continue review",
        exact: true,
      });
      await resume.waitFor({ timeout: 20000 });
      await resume.click();
    } else if (
      scenario === "cancel-save" ||
      scenario === "disconnect-save" ||
      scenario === "expiry-save"
    ) {
      await wait(
        async () =>
          !!job && (await status(job.binding.job_id)).cancel_requested === true,
      );
      await wait(async () => {
        try {
          return !!(await readFile(join(fixture, "save-settled.json")));
        } catch {
          return false;
        }
      });
    } else
      await wait(
        async () =>
          !!job && (await status(job.binding.job_id)).state === "applied_saved",
      );
    assert.ok(job);
    const proof = (await call({ fixture: "proof" })) as {
      effects: number;
      grants: number;
      tasks: number;
      job: CodeJobView;
    };
    assert.equal(proof.effects, scenario === "auto-save" ? 0 : 1);
    assert.equal(proof.tasks, 0);
    const actual = await readFile(join(root, "focus.js"));
    const wanted =
      scenario === "auto-save"
        ? baseline
        : scenario === "external-save"
          ? "// external pending human\n"
          : scenario === "participant"
            ? "// real participant\n" + expected
            : scenario === "human-save"
              ? "// pending human\n// " + expected
              : expected;
    assert.equal(actual.toString(), wanted);
    assert.equal(
      proof.job.state,
      scenario === "auto-save"
        ? "cancelled"
        : scenario === "success"
          ? "applied_saved"
          : scenario === "cancel-save" ||
              scenario === "disconnect-save" ||
              scenario === "expiry-save"
            ? "applying"
            : "needs_review",
    );
    if (
      scenario !== "auto-save" &&
      scenario !== "cancel-save" &&
      scenario !== "disconnect-save" &&
      scenario !== "expiry-save"
    ) {
      const receipt = proof.job
        .receipts[0] as import("../../../desktop/shared/coding-contracts").CodeFileReceipt;
      assert.equal(
        receipt.observed_hash,
        createHash("sha256").update(actual).digest("hex"),
      );
      assert.equal(receipt.observed_length, actual.length);
    }
    const source = [{ name: "focus.js", bytes: actual }];
    let localJournal: unknown = null;
    if (proof.effects) {
      const journalRoot = resolve(
        fixture,
        "../profile/User/globalStorage/sage-local.sage-editor-bridge/effect-journal",
      );
      let journalFiles: string[] = [],
        record: import("../../src/journal").JournalOperation | undefined;
      await wait(async () => {
        journalFiles = await readdir(journalRoot);
        assert.ok(
          journalFiles.every(
            (name) =>
              /^operation-[0-9a-f]{32}\.json$/.test(name) ||
              /^pending-[0-9a-f]{32}$/.test(name),
          ),
        );
        if (
          journalFiles.length !== 1 ||
          !/^operation-[0-9a-f]{32}\.json$/.test(journalFiles[0])
        )
          return false;
        record = JSON.parse(
          await readFile(join(journalRoot, journalFiles[0]), "utf8"),
        );
        return (
          record!.intents.length === 1 &&
          record!.observations.length === 1 &&
          record!.ack_ids.length === 2
        );
      });
      const operation = record!.operation_id;
      const reader = new EffectJournal(pathToFileURL(journalRoot));
      // The synthetic forward-clock fixture deliberately leaves future metadata; real-clock loading must refuse rollback.
      if (scenario === "expiry-save")
        await assert.rejects(reader.get(operation));
      const local =
        scenario === "expiry-save" ? record! : await reader.get(operation);
      assert.deepEqual(
        local.observations.map(receiptProjection),
        local.observations,
      );
      if (
        scenario === "cancel-save" ||
        scenario === "disconnect-save" ||
        scenario === "expiry-save"
      ) {
        assert.equal(proof.job.receipts.length, 0);
        assert.equal(local.observations[0].status, "applied_saved");
        assert.equal(local.ack_ids.length, 2);
        assert.equal(observationCalls, 0);
      } else
        assert.deepEqual(
          local.observations,
          proof.job.receipts.map(receiptProjection),
        );
      assert.equal(local.intents.length, proof.effects);
      if (
        scenario !== "cancel-save" &&
        scenario !== "disconnect-save" &&
        scenario !== "expiry-save"
      )
        assert.equal(local.ack_ids.length, 2 * proof.effects);
      const files = await readdir(journalRoot);
      assert.equal(files.length, 1);
      const bytes = await readFile(join(journalRoot, files[0]));
      localJournal = {
        root: journalRoot,
        operation_id: operation,
        intents: local.intents.length,
        observations: local.observations.length,
        ack_ids: local.ack_ids.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      };
    } else assert.equal(proof.grants, 1);
    await writeFile(
      join(fixture, "replace-authority.json"),
      JSON.stringify(
        {
          scenario,
          core_sqlite: join(state, "coding.sqlite"),
          local_journal: localJournal,
          ...proof,
          files: source.map((f) => ({
            name: f.name,
            sha256: createHash("sha256").update(f.bytes).digest("hex"),
            bytes: f.bytes.length,
          })),
          no_test_spawn: true,
          core_observation_calls: observationCalls,
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(fixture, "replace-finished.json"),
      JSON.stringify({ scenario }),
    );
    return {
      close: finish,
      assertDisconnected: async () => {
        assert.ok(job);
        let refused = false;
        try {
          await host.send({
            kind: "revoke",
            binding: job.binding,
            payload: null,
          });
        } catch {
          refused = true;
        }
        assert.equal(refused, true);
      },
      exerciseContext: async () => {},
    };
  } catch (e) {
    await writeFile(
      join(fixture, "native-controls-failure.json"),
      JSON.stringify({
        notifications: await page
          .locator(".notification-list-item-message")
          .allTextContents(),
        picker: await page.locator(".quick-input-widget").allTextContents(),
        core: await call({ fixture: "proof" }),
      }),
    );
    await finish();
    throw e;
  }
}

/** Public pinned API race proof, separate from the real-Core product save lane above. */
export async function runReplacementEditorRaces(
  extensionPath: string,
  fixture: string,
) {
  const vscode = await import("vscode"),
    { captureContext, validateContext, replacementState, releaseContext } =
      await import("../../src/context"),
    { localWorkspace } = await import("../../src/bridge"),
    { probeRoot } = await import("../../src/root-probe"),
    { rootIdentity } = await import("../../../desktop/shared/editor-bridge");
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath,
    path = join(root, "focus.js"),
    raw = vscode.workspace.workspaceFolders![0].uri.toString(),
    storage = join(fixture, "race-probe");
  await mkdir(storage);
  const workspace = localWorkspace(
      {
        trusted: true,
        remoteName: undefined,
        uiKind: "desktop",
        folders: [{ uri: raw }],
      },
      "race-window",
    ),
    pair = {
      ...workspace,
      root_id: rootIdentity(workspace),
      pair_id: "race-pair",
      host_boot_id: "race-host",
      challenge: "owned",
      status: "paired" as const,
    },
    guard = () => {
      assert.equal(vscode.workspace.isTrusted, true);
      assert.equal(vscode.workspace.workspaceFolders![0].uri.toString(), raw);
    },
    identity = await probeRoot(root, extensionPath, storage, guard),
    base = {
      pair,
      binding: {
        job_id: "race-job",
        boot_id: pair.host_boot_id,
        pair_id: pair.pair_id,
        window_id: pair.window_id,
        root_id: pair.root_id,
        revision: 1,
        policy_version: "code-v1" as const,
      },
      generation: 0,
      rawRootUri: raw,
      nativeIdentity: identity,
      extensionPath,
      storagePath: storage,
      mode: "replace_focus_file" as const,
      target: "focus.js" as const,
      names: ["focus.js" as const],
      diagnosticIds: [],
      guard,
    };
  const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path),
    ),
    editor = await vscode.window.showTextDocument(document, { preview: false }),
    original = document.getText(),
    whole = () =>
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
  const proof: Record<string, unknown> = {};
  const context = await captureContext(base),
    state = replacementState(context);
  let human: Thenable<boolean> | undefined;
  const stale = await editor.edit((builder) => {
    state.originalCheck();
    builder.replace(whole(), "// Sage stale replacement\n");
    human = editor.edit((b) =>
      b.insert(new vscode.Position(0, 0), "// transaction human\n"),
    );
  });
  assert.equal(await human, true);
  assert.equal(stale, false);
  assert.equal(document.getText(), "// transaction human\n" + original);
  assert.equal(await readFile(path, "utf8"), original);
  proof.final_native_transaction = {
    sage_edit_result: stale,
    human_edit_result: true,
    human_preserved: true,
    disk_unchanged: true,
  };
  await writeFile(
    join(fixture, "native-race-partial.json"),
    JSON.stringify(proof),
  );
  releaseContext(context);
  assert.equal(await document.save(), true);
  const fresh = await captureContext(base);
  assert.ok(fresh.files[0].text.startsWith("// transaction human\n"));
  const version = document.version;
  await editor.edit((b) =>
    b.insert(new vscode.Position(0, 0), "// undo marker\n"),
  );
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), fresh.files[0].text);
  assert.ok(document.version > version);
  await assert.rejects(validateContext(fresh));
  await vscode.commands.executeCommand("redo");
  assert.ok(document.getText().startsWith("// undo marker\n"));
  proof.undo_same_text_stale = true;
  proof.redo_human_preserved = true;
  assert.equal(await document.save(), true);
  const dirty = await captureContext(base);
  await editor.edit((b) =>
    b.insert(new vscode.Position(0, 0), "// dirty human\n"),
  );
  await assert.rejects(validateContext(dirty));
  proof.dirty_refused = true;
  assert.equal(await document.save(), true);
  const closed = await captureContext(base),
    oldDoc = document;
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const closedText = oldDoc.getText();
  await vscode.workspace.fs.delete(oldDoc.uri);
  for (let i = 0; i < 100 && !oldDoc.isClosed; i++)
    await new Promise((r) => setTimeout(r, 20));
  proof.tab_close_document_still_live = !oldDoc.isClosed;
  await writeFile(path, closedText);
  const reopened = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path),
  );
  proof.reopened_document_is_new_instance = reopened !== oldDoc;
  await assert.rejects(validateContext(closed));
  proof.same_document_reopen_target_substitution_refused = true;
  await vscode.window.showTextDocument(reopened, { preview: false });
  const external = await captureContext(base);
  await writeFile(path, "// external human\n");
  await assert.rejects(validateContext(external));
  proof.external_disk_refused = true;
  for (let i = 0; i < 100 && reopened.getText() !== "// external human\n"; i++)
    await new Promise((r) => setTimeout(r, 20));
  const eolContext = await captureContext(base),
    eolEditor = await vscode.window.showTextDocument(reopened, {
      preview: false,
    });
  assert.equal(
    await eolEditor.edit((b) => b.setEndOfLine(vscode.EndOfLine.CRLF)),
    true,
  );
  await assert.rejects(validateContext(eolContext));
  proof.actual_eol_drift_refused = true;
  await writeFile(path, "\ufeff// BOM human\n");
  await assert.rejects(captureContext(base));
  proof.raw_bom_refused = true;
  return proof;
}
