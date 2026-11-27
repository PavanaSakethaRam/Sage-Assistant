/** Real owned editor controls + authenticated bridge + actual CoreService/SQLite. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { EffectJournal, receiptProjection } from "../../src/journal";
import { isolatedChildEnv } from "../../../desktop/main/child-env";
import { EditorBridgeHost } from "../../../desktop/main/editor-bridge";
import {
  FOCUS_NAMES,
  parseCodeJobView,
  parseHostCodingControl,
  parseHostCodingReply,
  type CodingControlInput,
  type HostCodingReply,
  type CodeJobView,
} from "../../../desktop/shared/coding-contracts";
import type { PairView } from "../../../desktop/shared/editor-bridge";
export type CreateScenario =
  | "success"
  | "decline"
  | "collision"
  | "root-switch"
  | "cancel-prefix"
  | "ack-loss"
  | "expiry";
export async function createThroughWorkbench(
  page: Page,
  fixture: string,
  root: string,
  scenario: CreateScenario,
  testRunner = false,
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
    observations = 0;
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
      if (
        input.operation === "observation" &&
        ++observations === 1 &&
        (scenario === "ack-loss" || scenario === "cancel-prefix")
      ) {
        // Both paths retain a genuine first-file observation. ACK loss closes before reply.
        if (scenario === "ack-loss") await host.close();
        else {
          await page.keyboard.press(
            process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P",
          );
          const command = page.getByPlaceholder(
            "Type the name of a command to run.",
            { exact: true },
          );
          await command.fill(">Sage: Cancel Context");
          await page
            .getByText("Sage: Cancel Context", { exact: true })
            .first()
            .click();
        }
      }
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
    await select("Sage: Choose context mode", "Create focus project");
    await select(
      "Sage: Confirm selected disclosure",
      "Send selected context to local Sage",
    );
    for (const name of FOCUS_NAMES) {
      await select("Sage: Review focus project", `Review ${name}`);
      const resume = page.getByRole("button", {
        name: "Continue review",
        exact: true,
      });
      await resume.waitFor({ timeout: 20000 });
      await page
        .getByPlaceholder("Sage: Review focus project", { exact: true })
        .waitFor({ state: "hidden", timeout: 10000 });
      await resume.click();
    }
    const source = await Promise.all(
      FOCUS_NAMES.map(async (name) => ({
        name,
        bytes: await readFile(resolve("tests/fixtures/focus-project", name)),
      })),
    );
    if (testRunner) {
      const { focusTestSuffix } = await import("./test-runner");
      const config = JSON.parse(
        await readFile(join(fixture, "case.json"), "utf8"),
      );
      const test = source.find((f) => f.name === "focus.test.mjs")!;
      test.bytes = Buffer.concat([
        test.bytes,
        Buffer.from(focusTestSuffix(config.testScenario ?? "success")),
      ]);
    }
    await wait(async () => {
      try {
        return !!JSON.parse(
          await readFile(join(fixture, "diffs-checked.json"), "utf8"),
        );
      } catch {
        return false;
      }
    });
    await select("Sage: Review focus project", "Create four files");
    const create = page.getByRole("button", {
      name: "Create on local disk",
      exact: true,
    });
    await create.waitFor({ timeout: 20000 });
    if (scenario === "expiry") await call({ fixture: "expire" });
    if (scenario === "collision")
      await writeFile(join(root, "index.html"), "human");
    if (scenario === "root-switch") {
      await rename(root, root + "-old");
      await mkdir(root);
    }
    if (scenario === "decline")
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    else await create.click();
    if (scenario === "success")
      await wait(async () => {
        try {
          return (
            (await readdir(root)).length === 4 &&
            !!job &&
            (await status(job.binding.job_id)).state === "applied_saved"
          );
        } catch {
          return false;
        }
      });
    else if (scenario === "ack-loss" || scenario === "cancel-prefix")
      await wait(
        async () =>
          observations === 1 &&
          (await page
            .getByText("Sage stopped creation.", { exact: false })
            .count()) > 0,
      );
    else await wait(async () => !(await create.isVisible()));
    assert.ok(job);
    if (scenario !== "success")
      await wait(async () =>
        [
          "cancelled",
          "rejected",
          "partial",
          "needs_reconciliation",
          "interrupted",
        ].includes((await status(job!.binding.job_id)).state),
      );
    const proof = (await call({ fixture: "proof" })) as {
      effects: number;
      grants: number;
      tasks: number;
      job: CodeJobView;
    };
    const entries = await readdir(root);
    if (scenario === "success") {
      assert.deepEqual(entries.sort(), [...FOCUS_NAMES].sort());
      assert.equal(proof.effects, 4);
      assert.equal(proof.job.state, "applied_saved");
      assert.equal(proof.job.receipts.length, 4);
      assert.equal(proof.tasks, 0);
      for (const file of source)
        assert.deepEqual(await readFile(join(root, file.name)), file.bytes);
    } else if (scenario === "collision") {
      assert.deepEqual(entries, ["index.html"]);
      assert.equal(await readFile(join(root, "index.html"), "utf8"), "human");
      assert.equal(proof.effects, 0);
    } else if (scenario === "ack-loss" || scenario === "cancel-prefix") {
      assert.equal(proof.effects, 1);
      assert.deepEqual(entries.sort(), ["index.html"]);
      assert.equal(proof.job.receipts[0].status, "created");
    } else {
      assert.deepEqual(entries, []);
      assert.equal(proof.effects, 0);
    }
    let localJournal: unknown = null;
    if (proof.effects) {
      const journalRoot = resolve(
        fixture,
        "../profile/User/globalStorage/sage-local.sage-editor-bridge/effect-journal",
      );
      const operation = proof.job.receipts[0].operation_id;
      const local = await new EffectJournal(pathToFileURL(journalRoot)).get(
        operation,
      );
      assert.deepEqual(
        local.observations,
        proof.job.receipts.map(receiptProjection),
      );
      assert.equal(local.intents.length, proof.effects);
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
    } else assert.equal(proof.grants, 0);
    await writeFile(
      join(fixture, "create-authority.json"),
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
        },
        null,
        2,
      ),
    );
    if (testRunner) {
      const { testThroughWorkbench } = await import("./test-runner");
      await testThroughWorkbench(page, fixture, root, () =>
        status(job!.binding.job_id),
      );
    }
    await writeFile(
      join(fixture, "create-finished.json"),
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
        picker: await page.locator(".quick-input-title").allTextContents(),
      }),
    );
    await finish();
    throw e;
  }
}
