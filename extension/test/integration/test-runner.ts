/** Fixed owned GUI continuation after genuine Core/capture/review/create. */
import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { CodeJobView } from "../../../desktop/shared/coding-contracts";
export const TEST_SCENARIOS = [
  "success",
  "nonzero",
  "timeout",
  "cancel",
  "overflow",
  "mutation",
  "inherited",
] as const;
export type TestScenario = (typeof TEST_SCENARIOS)[number];
export function focusTestSuffix(scenario: TestScenario): string {
  return {
    success: "",
    nonzero: "\nprocess.exitCode=1;\n",
    timeout: "\nsetInterval(()=>{},1000);\n",
    cancel: "\nsetInterval(()=>{},1000);\n",
    overflow: "\nprocess.stdout.write('x'.repeat(300000));\n",
    mutation:
      "\n(await import('node:fs')).writeFileSync('focus.js','changed by owned test');\n",
    inherited:
      "\n(await import('node:child_process')).spawn(process.execPath,['-e','setTimeout(()=>{},4500)'],{stdio:['ignore',1,2],detached:false}).unref();\n",
  }[scenario];
}
export async function testThroughWorkbench(
  page: Page,
  fixture: string,
  _root: string,
  status: () => Promise<CodeJobView>,
) {
  const select = async (label: string) => {
    const input = page.getByPlaceholder("Sage: Review focus project", {
      exact: true,
    });
    await input.waitFor();
    await input.fill(label);
    await page
      .locator(".quick-input-widget")
      .filter({ has: input })
      .getByText(label, { exact: true })
      .first()
      .click();
  };
  const config = JSON.parse(await readFile(join(fixture, "case.json"), "utf8")),
    scenario: TestScenario = config.testScenario ?? "success";
  await select("Review fixed tests");
  await page.getByRole("button", { name: "Select Node", exact: true }).click();
  // This is the public workbench file chooser in the owned profile, not an OS dialog double.
  const chooser = page
    .locator(".quick-input-widget input")
    .filter({ visible: true })
    .first();
  await chooser.waitFor();
  await chooser.fill("/private/tmp/sage-task1-node.alAwYF/node");
  await chooser.press("Enter");
  await select("Run fixed tests");
  await page
    .getByRole("button", { name: "Run fixed tests", exact: true })
    .click();
  if (scenario === "cancel") {
    await new Promise((r) => setTimeout(r, 1000));
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
  const deadline = Date.now() + 40000;
  while (
    Date.now() < deadline &&
    !(await status()).receipts.some((r) => r.scope === "code.test") &&
    scenario !== "cancel"
  )
    await new Promise((r) => setTimeout(r, 25));
  let job = await status();
  const journalRoot = join(
    fixture,
    "../profile/User/globalStorage/sage-local.sage-editor-bridge/effect-journal",
  );
  const { readdir } = await import("node:fs/promises");
  let local: import("../../src/journal").JournalOperation | undefined;
  while (Date.now() < deadline) {
    for (const name of await readdir(journalRoot)) {
      if (!/^operation-/.test(name)) continue;
      const record = JSON.parse(
        await readFile(join(journalRoot, name), "utf8"),
      );
      if (
        record.intents[0]?.scope === "code.test" &&
        record.observations.length === 1
      )
        local = record;
    }
    if (local) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(local, "owned test intent must settle its actual child receipt");
  const receipt = local.observations[0];
  assert.ok(receipt.scope === "code.test");
  assert.equal(
    receipt.status,
    {
      success: "passed",
      nonzero: "failed",
      timeout: "failed",
      cancel: "cancelled",
      overflow: "failed",
      mutation: "changed_during_test",
      inherited: "unknown",
    }[scenario],
  );
  assert.equal(receipt.timeout, scenario === "timeout");
  assert.equal(receipt.overflow, scenario === "overflow");
  assert.equal(receipt.cancel_requested, scenario === "cancel");
  assert.equal(typeof receipt.output_digest, "string");
  assert.match(receipt.output_digest!, /^[a-f0-9]{64}$/);
  if (scenario === "nonzero") assert.equal(receipt.exit_code, 1);
  if (scenario === "success") assert.equal(receipt.exit_code, 0);
  if (scenario !== "cancel") {
    assert.equal(
      job.receipts.filter((r) => r.scope === "code.test").length,
      1,
      "fresh separately selected fixed test must produce its actual child receipt",
    );
    assert.deepEqual(job.receipts.at(-1), receipt);
    {
      await select("Inspect test result");
      await writeFile(join(fixture, "test-result-ready.json"), "{}");
      while (Date.now() < deadline) {
        try {
          await readFile(join(fixture, "test-result-inspected.json"));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      assert.ok(await readFile(join(fixture, "test-result-inspected.json")));
      await select("Done");
      const finalState =
        scenario === "success"
          ? "completed"
          : scenario === "inherited"
            ? "needs_reconciliation"
            : "failed";
      while (Date.now() < deadline && (await status()).state !== finalState)
        await new Promise((r) => setTimeout(r, 25));
      job = await status();
      assert.equal(job.state, finalState);
    }
  } else {
    assert.equal(job.receipts.filter((r) => r.scope === "code.test").length, 0);
    while (Date.now() < deadline && !(await status()).cancel_requested)
      await new Promise((r) => setTimeout(r, 25));
    job = await status();
    assert.equal(job.cancel_requested, true);
  }
  if (scenario === "inherited") await new Promise((r) => setTimeout(r, 1800));
  await writeFile(
    join(fixture, "test-runner-proof.json"),
    JSON.stringify(
      {
        scenario,
        job,
        local_test_journal: local,
        chooser: "actual owned public workbench",
        expected_node_uri: "file:///private/tmp/sage-task1-node.alAwYF/node",
        receipt,
        after_done: scenario !== "cancel",
      },
      null,
      2,
    ),
  );
}

/** Actual fixed-argv child from the owned extension host; no raw environment is logged. */
export async function runNativeEnvironmentFixture(fixture: string) {
  const { spawn } = await import("node:child_process"),
    { mkdir } = await import("node:fs/promises"),
    { isolatedChildEnv } = await import("../../../desktop/main/child-env");
  const owned = join(fixture, "native-test-env");
  await mkdir(owned);
  await mkdir(join(owned, "tmp"));
  const supplied = isolatedChildEnv({
    PATH: "",
    TEMP: join(owned, "tmp"),
    TMP: join(owned, "tmp"),
    TMPDIR: join(owned, "tmp"),
    ...(process.platform === "win32" ? { HOME: "" } : {}),
  });
  const script = `import {test} from 'node:test'; import assert from 'node:assert/strict'; const inspect=${nativeEnvironmentProof.toString()}; test('actual native supplied map and runtime additions',()=>{ const proof=inspect(${JSON.stringify(supplied)},process.env,process.platform,process.getuid?.(),undefined); console.log('SAGE_NATIVE_PROOF='+JSON.stringify({...proof,uid_for_parent:process.getuid?.()})); assert.ok(proof.accepted); });`;
  await writeFile(join(owned, "focus.test.mjs"), script);
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({
    SAGE_TOKEN: "synthetic-token-marker",
    HTTPS_PROXY: "synthetic-proxy-marker",
    NODE_OPTIONS: "--trace-warnings",
    NODE_PATH: "synthetic-node-path",
  })) {
    old[k] = process.env[k];
    process.env[k] = v;
  }
  let child;
  try {
    child = spawn(
      "/private/tmp/sage-task1-node.alAwYF/node",
      [
        "--test",
        "--test-isolation=none",
        "--test-reporter=tap",
        "focus.test.mjs",
      ],
      {
        cwd: owned,
        env: supplied,
        shell: false,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  let output = "",
    count = 0;
  child.stdout.on("data", (b) => {
    count += b.length;
    if (count > 16384) child.kill();
    else output += b.toString();
  });
  child.stderr.on("data", (b) => {
    count += b.length;
    if (count > 16384) child.kill();
    else output += b.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Native environment child timeout"));
    }, 10000);
    child.once("error", reject);
    child.once("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  const match = /SAGE_NATIVE_PROOF=(\{[^\n]+\})/.exec(output);
  output = "";
  assert.ok(match);
  const { uid_for_parent, ...measured } = JSON.parse(match[1]);
  const parent_uid_match = process.getuid
    ? uid_for_parent === process.getuid()
    : true;
  const proof = {
    ...measured,
    parent_uid_match,
    accepted: measured.accepted && parent_uid_match,
  };
  assert.equal(code, 0);
  assert.equal(proof.accepted, true);
  await writeFile(
    join(fixture, "test-env-proof.json"),
    JSON.stringify(
      {
        ...proof,
        exit_code: code,
        output_bytes: count,
        scope:
          "actual standalone fixed child from owned extension host; supplied map separate from native additions",
      },
      null,
      2,
    ),
  );
  return proof;
}

/** Fixture-only closed classifier; the value never leaves this child as raw text. */
export function nativeEnvironmentProof(
  supplied: Record<string, string>,
  actual: Record<string, string>,
  platform: string,
  uid: number | undefined,
  parentUid: number | undefined,
) {
  const extra = Object.keys(actual)
      .filter((k) => !Object.hasOwn(supplied, k))
      .sort(),
    value = actual.__CF_USER_TEXT_ENCODING;
  const fields = typeof value === "string" ? value.split(":") : [];
  const match =
    typeof value === "string"
      ? /^(0x[0-9a-fA-F]{1,8}):(0x[0-9a-fA-F]{1,8}):(0x[0-9a-fA-F]{1,8})$/.exec(
          value,
        )
      : null;
  const cfValid =
    typeof value === "string" &&
    value.length <= 64 &&
    match?.[0] === value &&
    uid !== undefined &&
    Number.parseInt(match[1], 16) === uid &&
    (parentUid === undefined || uid === parentUid);
  const proof = {
    extra,
    supplied_unchanged: Object.entries(supplied).every(
      ([k, v]) => actual[k] === v,
    ),
    aliases_absent:
      new Set(Object.keys(actual).map((k) => k.toUpperCase())).size ===
      Object.keys(actual).length,
    worker_exact: actual.NODE_TEST_WORKER_ID === "1",
    marker_keys_absent: [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "SAGE_TOKEN",
      "NODE_OPTIONS",
      "NODE_PATH",
      ...(platform === "darwin" ? ["HOME", "USERPROFILE"] : []),
    ].every((k) => !Object.hasOwn(actual, k)),
    cf_present: typeof value === "string",
    cf_bounded: typeof value === "string" && value.length <= 64,
    cf_fields: fields.map((v) => ({
      prefix: v.startsWith("0x") ? "0x" : "none",
      width: v.length,
      hex: /^0x[0-9a-fA-F]{1,8}$/.test(v),
    })),
    cf_uid_match: fields.length === 3 && Number.parseInt(fields[0], 16) === uid,
    cf_strict_valid: cfValid,
  };
  const exact =
    JSON.stringify(extra) ===
    JSON.stringify(
      platform === "darwin"
        ? ["NODE_TEST_WORKER_ID", "__CF_USER_TEXT_ENCODING"]
        : ["NODE_TEST_WORKER_ID"],
    );
  return {
    ...proof,
    accepted:
      proof.supplied_unchanged &&
      proof.aliases_absent &&
      proof.worker_exact &&
      proof.marker_keys_absent &&
      exact &&
      (platform !== "darwin" || cfValid),
  };
}
