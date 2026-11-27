/** Fixed recovery proof over actual Core/SQLite and explicit owned workbench controls. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, lstat, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { isolatedChildEnv } from "../../../desktop/main/child-env";
import { EditorBridgeHost } from "../../../desktop/main/editor-bridge";
import {
  parseCodeJobView,
  parseCodeJobPage,
} from "../../../desktop/shared/coding-contracts";
import type { PairView } from "../../../desktop/shared/editor-bridge";
import { createThroughWorkbench } from "./create";
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
async function waitFile(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("Owned recovery receipt deadline");
}
export async function runRecoveryFixture(
  productPath: string,
  fixture: string,
): Promise<void> {
  const vscode = await import("vscode");
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const authority = await waitFile(join(fixture, "create-authority.json"));
  const journal = authority.local_journal as {
    root: string;
    operation_id: string;
  };
  const operation = join(
    journal.root,
    `operation-${journal.operation_id}.json`,
  );
  const bytes = await readFile(operation),
    pendingName = "pending-" + "a".repeat(32),
    pending = join(journal.root, pendingName);
  await writeFile(pending, bytes, { flag: "wx", mode: 0o600 });
  const originalAge = new Date(Date.now() - 60000);
  await utimes(pending, originalAge, originalAge);
  const original = await lstat(pending);
  await writeFile(
    join(fixture, "recovery-pending-ready.json"),
    JSON.stringify({
      synthetic_interrupted_write_remnant: true,
      digest: digest(bytes),
      mtime: original.mtimeMs,
    }),
  );
  await vscode.commands.executeCommand("sage.pairLocalEditor");
  await vscode.commands.executeCommand("sage.inspectInterruptedJournal");
  const retained = (await readdir(journal.root)).filter((name) =>
    /^acknowledged-[a-f0-9]{32}$/.test(name),
  );
  assert.equal(retained.length, 1);
  const retainedPath = join(journal.root, retained[0], pendingName);
  assert.equal(digest(await readFile(retainedPath)), digest(bytes));
  assert.equal((await lstat(retainedPath)).mtimeMs, original.mtimeMs);
  assert.equal(digest(await readFile(operation)), digest(bytes));
  assert.deepEqual(await readdir(root), ["index.html"]);
  await writeFile(
    join(fixture, "recovery-acknowledged.json"),
    JSON.stringify({
      digest: digest(bytes),
      mtime: original.mtimeMs,
      retained_path: retainedPath,
      project_names: ["index.html"],
      no_operation_promotion: true,
    }),
  );
  await writeFile(
    join(fixture, "recovery-stage.json"),
    JSON.stringify({ stage: "fresh-pair" }),
  );
  await vscode.commands.executeCommand("sage.pairLocalEditor");
  await writeFile(
    join(fixture, "recovery-stage.json"),
    JSON.stringify({ stage: "open-human-buffer" }),
  );
  const uri = vscode.Uri.file(join(root, "index.html")),
    document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
  });
  const disk = digest(await readFile(uri.fsPath));
  assert.equal(
    await editor.edit((edit) =>
      edit.insert(new vscode.Position(0, 0), "<!-- human unsaved -->\n"),
    ),
    true,
  );
  const buffer = digest(document.getText()),
    version = document.version;
  assert.equal(document.isDirty, true);
  await writeFile(
    join(fixture, "recovery-stage.json"),
    JSON.stringify({ stage: "inspect-job" }),
  );
  await vscode.commands.executeCommand("sage.inspectInterruptedJob");
  await writeFile(
    join(fixture, "recovery-stage.json"),
    JSON.stringify({ stage: "check-view" }),
  );
  const view = vscode.window.activeTextEditor?.document;
  assert.equal(view?.uri.toString(), "sage-inspection:/interrupted-job.txt");
  assert.equal(view!.isDirty, false);
  const refreshDeadline = Date.now() + 5000;
  while (
    !(
      view!
        .getText()
        .includes(`Job: ${parseCodeJobView(authority.job).binding.job_id};`) &&
      view!.getText().includes(disk) &&
      view!.getText().includes(buffer)
    ) &&
    Date.now() < refreshDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  const text = view!.getText();
  await writeFile(
    join(fixture, "recovery-view-check.json"),
    JSON.stringify({
      verified: text.includes("Historical root verified"),
      unverified: text.includes("Historical root unverified"),
      disk_hash_present: text.includes(disk),
      buffer_hash_present: text.includes(buffer),
      test_unknown: text.includes("Test outcome: unknown"),
      same_version: document.version === version,
      dirty: document.isDirty,
    }),
  );
  assert.ok(
    text.includes("Historical root verified"),
    "recovery root must verify",
  );
  assert.ok(text.includes(disk), "raw disk hash must be displayed");
  assert.ok(text.includes(buffer), "logical buffer hash must be displayed");
  assert.ok(
    text.includes("Test outcome: unknown"),
    "missing test receipt must remain unknown",
  );
  assert.equal(document.version, version);
  assert.equal(document.isDirty, true);
  assert.equal(digest(document.getText()), buffer);
  assert.equal(digest(await readFile(uri.fsPath)), disk);
  await vscode.commands.executeCommand("sage.dismissInspection");
  assert.equal(document.version, version);
  assert.equal(document.isDirty, true);
  assert.equal(digest(document.getText()), buffer);
  await writeFile(
    join(fixture, "recovery-view-ready.json"),
    JSON.stringify({
      disk_hash: disk,
      buffer_hash: buffer,
      document_version: version,
      dirty_preserved: true,
      fixed_inspection_uri: view!.uri.toString(),
      test_outcome: "unknown",
      no_source_archive: true,
      installed_probe_product: productPath,
    }),
  );
  await waitFile(join(fixture, "recovery-expired.json"));
  await vscode.commands.executeCommand("sage.inspectInterruptedJob");
  await writeFile(
    join(fixture, "recovery-driver-complete.json"),
    JSON.stringify({
      bounded_empty_expired_page: true,
      dirty_preserved:
        document.isDirty &&
        document.version === version &&
        digest(document.getText()) === buffer,
    }),
  );
}
export async function recoveryThroughWorkbench(
  page: Page,
  fixture: string,
  root: string,
) {
  const previous = await createThroughWorkbench(
    page,
    fixture,
    root,
    "cancel-prefix",
  );
  await previous.close();
  const beforeAuthority = await waitFile(
    join(fixture, "create-authority.json"),
  );
  const oldJob = parseCodeJobView(beforeAuthority.job);
  const state = join(fixture, "core");
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
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let pending:
    | { resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;
  let tail: Promise<unknown> = Promise.resolve(),
    output = 0,
    stderr = "",
    view: PairView | undefined;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const p = pending;
    pending = undefined;
    output += Buffer.byteLength(line);
    if (output > 262144) {
      p?.reject(Error("Recovery Core output limit"));
      child.kill();
      return;
    }
    try {
      p?.resolve(JSON.parse(line));
    } catch {
      p?.reject(Error("Recovery Core response"));
    }
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
    if (stderr.length > 8192) child.kill();
  });
  child.once("exit", () => {
    pending?.reject(Error("Recovery Core stopped"));
    pending = undefined;
  });
  const call = (request: unknown): Promise<unknown> => {
    const work = tail.then(
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending = undefined;
            child.kill();
            reject(Error("Recovery Core deadline"));
          }, 30000);
          pending = {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          child.stdin.write(JSON.stringify(request) + "\n");
        }),
    );
    tail = work.catch(() => {});
    return work;
  };
  const get = async (job_id: string) => {
    const response = (await call({
      version: 1,
      kind: "request",
      id: randomUUID(),
      method: "coding.get",
      params: { job_id },
    })) as { result: unknown };
    return parseCodeJobView(response.result);
  };
  const proof = () =>
    call({ fixture: "retained_job", job_id: oldJob.binding.job_id });
  const host = new EditorBridgeHost({
    onPair: (value) => {
      view = value;
    },
    onData: () => {
      throw Error("Unexpected recovery effect data");
    },
    codingStatus: get,
    codingHistory: async (offset) => {
      const response = (await call({
        version: 1,
        kind: "request",
        id: randomUUID(),
        method: "coding.list",
        params: { limit: 20, offset },
      })) as { result: unknown };
      return parseCodeJobPage(response.result);
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
  const finish = async () => {
    await host.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("Recovery Core shutdown deadline"));
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
    const before = await proof();
    const synthetic = await waitFile(
      join(fixture, "recovery-pending-ready.json"),
    );
    await select(
      "Sage: Inspect interrupted Sage journal",
      "pending-" + "a".repeat(32),
    );
    await select(
      "Old effects and test outcomes remain uncertain; new work needs fresh pairing and approvals",
      "Acknowledge uncertainty and retain evidence",
    );
    const acknowledged = await waitFile(
      join(fixture, "recovery-acknowledged.json"),
    );
    const ticket = await host.start();
    const ticketInput = page.getByPlaceholder("Sage pairing ticket", {
      exact: true,
    });
    await ticketInput.waitFor({ timeout: 20000 });
    await ticketInput.fill(
      Buffer.from(JSON.stringify(ticket)).toString("base64url"),
    );
    await ticketInput.press("Enter");
    const confirm = page.getByRole("button", {
      name: "Pair this folder",
      exact: true,
    });
    await confirm.waitFor({ timeout: 20000 });
    assert.ok(view);
    await confirm.click();
    const paired = await host.confirm(view.pair_id);
    assert.notEqual(paired.host_boot_id, oldJob.binding.boot_id);
    assert.notEqual(paired.pair_id, oldJob.binding.pair_id);
    assert.equal(paired.root_id, oldJob.binding.root_id);
    const refreshed = await get(oldJob.binding.job_id);
    assert.deepEqual(refreshed.binding, oldJob.binding);
    await select(
      "Sage: Inspect interrupted job — one retained Core page",
      oldJob.binding.job_id,
    );
    const observation = await waitFile(
      join(fixture, "recovery-view-ready.json"),
    );
    const afterInspection = await proof();
    assert.deepEqual(afterInspection, before);
    await call({ fixture: "expire_history" });
    const expired = (await call({
      version: 1,
      kind: "request",
      id: randomUUID(),
      method: "coding.list",
      params: { limit: 20, offset: 0 },
    })) as { result: unknown };
    assert.deepEqual(parseCodeJobPage(expired.result), {
      items: [],
      next_offset: null,
    });
    const after = await proof();
    assert.equal((after as { present: boolean }).present, false);
    await writeFile(
      join(fixture, "recovery-expired.json"),
      JSON.stringify({ advanced_owned_core_days: 31 }),
    );
    const driver = await waitFile(
      join(fixture, "recovery-driver-complete.json"),
    );
    await writeFile(
      join(fixture, "recovery-proof.json"),
      JSON.stringify(
        {
          synthetic,
          acknowledged,
          old_binding: oldJob.binding,
          current_pair: {
            boot_id: paired.host_boot_id,
            pair_id: paired.pair_id,
            window_id: paired.window_id,
            root_id: paired.root_id,
          },
          before,
          after_inspection: afterInspection,
          after_retention: after,
          observation,
          driver,
          actual_core_restarted_same_sqlite: true,
          no_history_effect_calls: true,
          no_provider_or_test_process: true,
        },
        null,
        2,
      ),
    );
    return {
      close: finish,
      assertDisconnected: async () => {},
      exerciseContext: async () => {},
    };
  } catch (error) {
    await finish();
    throw error;
  }
}
