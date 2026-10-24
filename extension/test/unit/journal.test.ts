import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  utimes,
  rename,
  symlink,
  link,
  chmod,
  mkdir,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EffectJournal,
  intentProjection,
  receiptProjection,
  journalHash,
  requireFreshAcks,
} from "../../src/journal";
import {
  BINDING,
  HASH,
  makeReceipt,
} from "../../../desktop/tests/coding-fixtures";
import {
  parseCodeReceipt,
  type CodeIntent,
  type CodeBinding,
} from "../../../desktop/shared/coding-contracts";
const boundary = vi.hoisted(() => ({
  collision: false,
  rename: "" as "" | "before" | "after",
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (boundary.collision && String(args[0]).includes("acknowledged-")) {
        await fs.mkdir(args[0]);
        await fs.writeFile(
          String(args[0]) + "/human",
          "retained human marker",
          { flag: "wx" },
        );
      }
      return fs.mkdir(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const owned = String(args[1]).includes("acknowledged-");
      if (owned && boundary.rename === "before")
        throw Error("owned pre-rename interruption");
      await fs.rename(...args);
      if (owned && boundary.rename === "after")
        throw Error("owned post-rename interruption");
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  boundary.collision = false;
  boundary.rename = "";
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp("/private/tmp/sage-journal-");
  roots.push(root);
  return { root, journal: new EffectJournal(pathToFileURL(root)) };
}
function intent(): CodeIntent {
  return {
    binding: BINDING as CodeBinding,
    operation_id: "op",
    effect_id: "effect",
    ordinal: 0,
    scope: "code.create",
    target: "index.html",
    expected_hash: HASH,
  };
}
it("records ordered source-free metadata durably and normalizes Python optional receipts", async () => {
  const { root, journal } = await fixture();
  const value = intent();
  const ack = await journal.intent(value);
  expect(ack.status).toBe("recorded");
  expect(ack.recorded_hash).toBe(journalHash(intentProjection(value)));
  expect((await journal.intent(value)).status).toBe("duplicate");
  expect(
    (await journal.intent({ ...value, expected_hash: "b".repeat(64) })).status,
  ).toBe("conflict");
  const observed = parseCodeReceipt({
    ...makeReceipt({ observed_hash: null, observed_length: null }),
    binding: BINDING,
    operation_id: "op",
    effect_id: "effect",
    ordinal: 0,
    expected_hash: HASH,
  });
  const receipt = receiptProjection(observed);
  expect(receipt).toMatchObject({ observed_hash: null, observed_length: null });
  expect((await journal.observed(observed)).status).toBe("recorded");
  const recovered = await new EffectJournal(pathToFileURL(root)).get("op");
  expect(recovered.intents).toHaveLength(1);
  expect(recovered.observations).toHaveLength(1);
  const bytes = await readFile(join(root, (await readdir(root))[0]), "utf8");
  expect(bytes).not.toMatch(/source body|request marker|output marker/);
});
it("journal_failure_before_effect_is_zero_calls", async () => {
  const { root, journal } = await fixture();
  await writeFile(join(root, "operation-op.json"), '{"version":2}');
  let calls = 0;
  await expect(
    (async () => {
      const local = await journal.intent(intent());
      requireFreshAcks(local, local);
      calls++;
    })(),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
it("never treats duplicate, conflicting, missing or mismatched core acknowledgement as effect authority", async () => {
  const { journal } = await fixture();
  const local = await journal.intent(intent());
  expect(() => requireFreshAcks(local, local)).not.toThrow();
  for (const remote of [
    undefined,
    { ...local, status: "duplicate" as const },
    { ...local, status: "conflict" as const },
    { ...local, recorded_hash: "b".repeat(64) },
    { ...local, effect_id: "other" },
  ])
    expect(() => requireFreshAcks(local, remote)).toThrow();
});
it("serializes fresh writers and bounds ordinals, ownership and observations", async () => {
  const { journal } = await fixture();
  const a = intent();
  const results = await Promise.all([journal.intent(a), journal.intent(a)]);
  expect(results.map((x) => x.status)).toEqual(["recorded", "duplicate"]);
  await expect(
    journal.intent({ ...a, effect_id: "next", ordinal: 2 }),
  ).rejects.toThrow();
  await expect(
    journal.observed(
      parseCodeReceipt({ ...makeReceipt(), operation_id: "absent" }),
    ),
  ).rejects.toThrow();
});
it("expires only owned metadata after thirty days and fails closed on corrupt/future data", async () => {
  const { root, journal } = await fixture();
  await journal.intent(intent());
  await writeFile(join(root, "unrelated"), "human");
  await journal.expire(new Date(Date.now() + 31 * 86400000));
  expect(await readdir(root)).toEqual(["unrelated"]);
  await writeFile(join(root, "operation-op.json"), "{}");
  await expect(journal.get("op")).rejects.toThrow();
  await expect(journal.expire(new Date())).rejects.toThrow();
});

it("persists the exact private test projection and drops executable/cwd/environment markers", async () => {
  const corpus = await import("../../../tests/fixtures/coding-contracts.json");
  const vector = corpus.default.journal_vectors.find(
    (row) => row.label === "test-private-projection-unicode-env",
  )!;
  const { root, journal } = await fixture();
  const { parseCodeIntent } =
    await import("../../../desktop/shared/coding-contracts");
  const input = parseCodeIntent(structuredClone(vector.input));
  const pending = journal.intent(input);
  if (input.scope === "code.test")
    (input.recipe.environment as Record<string, string>).TEMP =
      "mutated after await";
  const ack = await pending;
  expect(ack.recorded_hash).toBe(vector.canonical_sha256);
  const bytes = await readFile(join(root, (await readdir(root))[0]), "utf8");
  expect(bytes).not.toMatch(/PRIVATE_MARKER|mutated after await/);
  expect((await journal.get(input.operation_id)).intents[0]).toEqual(
    vector.projection,
  );
});
it("new durable records extend retention, while reads and duplicates cannot renew it", async () => {
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const { journal } = await fixture();
  const value = intent();
  await journal.intent(value);
  const first = await journal.get("op");
  vi.setSystemTime(now + 86400000);
  await journal.intent(value);
  expect((await journal.get("op")).expires_at).toBe(first.expires_at);
  await journal.observed(
    parseCodeReceipt({
      ...makeReceipt(),
      binding: BINDING,
      operation_id: "op",
      effect_id: "effect",
      ordinal: 0,
    }),
  );
  expect(Date.parse((await journal.get("op")).expires_at)).toBe(
    now + 31 * 86400000,
  );
  vi.setSystemTime(now);
  await expect(journal.get("op")).rejects.toThrow();
  vi.useRealTimers();
});

it("fails closed on a duplicate-key or noncanonical persisted metadata record", async () => {
  const { root, journal } = await fixture();
  await journal.intent(intent());
  const path = join(root, "operation-op.json"),
    text = await readFile(path, "utf8");
  await writeFile(path, text.replace('"version":1', '"version":2,"version":1'));
  await expect(journal.get("op")).rejects.toThrow();
});

it("bounds the four-file operation and preserves interleaved intent/observation acknowledgment order", async () => {
  const { journal } = await fixture();
  const names = [
    "index.html",
    "focus.js",
    "focus.test.mjs",
    "README.md",
  ] as const;
  for (const [ordinal, target] of names.entries()) {
    const value = {
      ...intent(),
      effect_id: `effect-${ordinal}`,
      ordinal,
      target,
    };
    expect((await journal.intent(value)).status).toBe("recorded");
    const receipt = parseCodeReceipt({
      ...makeReceipt(),
      binding: BINDING,
      operation_id: "op",
      effect_id: value.effect_id,
      ordinal,
      target,
    });
    expect((await journal.observed(receipt)).status).toBe("recorded");
    expect((await journal.observed(receipt)).status).toBe("duplicate");
    expect(
      (
        await journal.observed(
          parseCodeReceipt({ ...receipt, observed_hash: "b".repeat(64) }),
        )
      ).status,
    ).toBe("conflict");
  }
  const operation = await journal.get("op");
  expect(operation.intents).toHaveLength(4);
  expect(operation.observations).toHaveLength(4);
  expect(operation.ack_ids).toHaveLength(8);
  await expect(
    journal.intent({ ...intent(), effect_id: "fifth", ordinal: 4 }),
  ).rejects.toThrow();
});
it("refuses source-bearing extras before creating metadata and enforces bounded store saturation", async () => {
  const { root, journal } = await fixture();
  expect(() =>
    journal.intent({
      ...intent(),
      body: "REQUEST_PRIVATE_MARKER",
    } as unknown as CodeIntent),
  ).toThrow();
  expect(await readdir(root)).toEqual([]);
  await Promise.all(
    Array.from({ length: 1024 }, (_, i) =>
      writeFile(join(root, `operation-reserved${i}.json`), "reserved"),
    ),
  );
  await expect(journal.intent(intent())).rejects.toThrow();
  expect((await readdir(root)).length).toBe(1024);
});
it("refuses corrupt acknowledgement metadata and over-cap reads without replacing data", async () => {
  const { root, journal } = await fixture();
  await journal.intent(intent());
  const path = join(root, "operation-op.json"),
    text = await readFile(path, "utf8");
  const value = JSON.parse(text);
  await writeFile(
    path,
    text.replace(
      `"recorded_hash":"${value.ack_ids[0].recorded_hash}"`,
      `"recorded_hash":"${"b".repeat(64)}"`,
    ),
  );
  await expect(journal.get("op")).rejects.toThrow();
  await writeFile(path, "x".repeat(1048577));
  await expect(journal.get("op")).rejects.toThrow();
});

it("fails closed on a fresh crash remnant without deleting reconciliation evidence", async () => {
  const { root, journal } = await fixture();
  const pending = join(root, `pending-${"a".repeat(32)}`);
  await writeFile(pending, '{"version":1');
  await expect(journal.expire(new Date())).rejects.toThrow();
  expect(await readFile(pending, "utf8")).toBe('{"version":1');
});

it("ages out only recognized expired owned version1 pending metadata", async () => {
  const { root, journal } = await fixture();
  await journal.intent(intent());
  const now = Date.now(),
    old = new Date(now - 31 * 86400000),
    pending = join(root, `pending-${"a".repeat(32)}`);
  const source = join(root, "operation-op.json");
  await rename(source, pending);
  await utimes(pending, old, old);
  await expect(journal.expire(new Date(now))).rejects.toThrow();
  expect(await readdir(root)).toEqual([pending.split("/").at(-1)]);
  const value = JSON.parse(await readFile(pending, "utf8"));
  value.created_at = old.toISOString();
  value.updated_at = old.toISOString();
  value.expires_at = new Date(old.getTime() + 30 * 86400000).toISOString();
  await writeFile(pending, JSON.stringify(value));
  await utimes(pending, old, old);
  await journal.expire(new Date(now));
  expect(await readdir(root)).toEqual([]);
  await writeFile(pending, '{"version":1');
  await utimes(pending, old, old);
  await journal.expire(new Date(now));
  expect(await readdir(root)).toEqual([]);
  const unrelated = join(root, "pending-human");
  await writeFile(unrelated, "human");
  await utimes(unrelated, old, old);
  await journal.expire(new Date(now));
  expect(await readFile(unrelated, "utf8")).toBe("human");
});
it("preserves future/unknown versions, invalid types, links, oversized or clock-future pending state", async () => {
  const { root, journal } = await fixture();
  const now = Date.now(),
    old = new Date(now - 31 * 86400000),
    pending = join(root, `pending-${"b".repeat(32)}`);
  for (const content of [
    '{"version":2}',
    '{"version":2',
    '{"version":2,"version":1}',
    '{"unknown":1}',
    "x".repeat(1048577),
  ]) {
    await writeFile(pending, content);
    await utimes(pending, old, old);
    await expect(journal.expire(new Date(now))).rejects.toThrow();
    expect((await readFile(pending)).length).toBe(Buffer.byteLength(content));
  }
  await writeFile(pending, '{"version":1');
  await utimes(pending, new Date(now + 86400000), new Date(now + 86400000));
  await expect(journal.expire(new Date(now))).rejects.toThrow();
  await rm(pending);
  const target = join(root, "human");
  await writeFile(target, "human");
  await symlink(target, pending);
  await expect(journal.expire(new Date(now))).rejects.toThrow();
  await rm(pending);
  await link(target, pending);
  await expect(journal.expire(new Date(now))).rejects.toThrow();
  await rm(pending);
  expect(await readFile(target, "utf8")).toBe("human");
  await mkdir(pending);
  await expect(journal.expire(new Date(now))).rejects.toThrow();
  await rm(pending, { recursive: true });
  await writeFile(pending, '{"version":1');
  await utimes(pending, old, old);
  await chmod(pending, 0);
  await expect(journal.expire(new Date(now))).rejects.toThrow();
  await chmod(pending, 0o600);
  await expect(journal.expire(new Date(NaN))).rejects.toThrow();
});

it("rejects persisted observation order that differs from effect ordinals", async () => {
  const { root, journal } = await fixture();
  for (const [ordinal, target] of (
    ["index.html", "focus.js"] as const
  ).entries()) {
    const value = {
      ...intent(),
      effect_id: `effect-${ordinal}`,
      ordinal,
      target,
    };
    await journal.intent(value);
    await journal.observed(
      parseCodeReceipt({
        ...makeReceipt(),
        binding: BINDING,
        operation_id: "op",
        effect_id: value.effect_id,
        ordinal,
        target,
      }),
    );
  }
  const path = join(root, "operation-op.json"),
    value = JSON.parse(await readFile(path, "utf8"));
  value.observations.reverse();
  await writeFile(path, JSON.stringify(value));
  await expect(journal.get("op")).rejects.toThrow();
});

it("identifies unexpired pending evidence as the specific pairing blocker", async () => {
  const { root, journal } = await fixture();
  await writeFile(join(root, "pending-" + "a".repeat(32)), '{"version":1,');
  await expect(journal.intent(intent())).rejects.toThrow(
    /Inspect interrupted Sage journal/,
  );
});

it.each(["supported", "malformed"])(
  "acknowledges one %s v1 remnant without changing evidence age or promoting operation authority",
  async (kind) => {
    const { root, journal } = await fixture();
    const pending = "pending-" + "c".repeat(32);
    if (kind === "supported") {
      await journal.intent(intent());
      await rename(join(root, "operation-op.json"), join(root, pending));
    } else await writeFile(join(root, pending), '{"version":1,');
    const before = await readFile(join(root, pending));
    const age = new Date(Date.now() - 10000);
    await utimes(join(root, pending), age, age);
    const stat = await lstat(join(root, pending));
    const result = await journal.inspectPending();
    expect(result.complete).toBe(true);
    expect(result.entries[0].classification).toBe(
      kind === "supported" ? "supported_v1" : "malformed_v1",
    );
    await journal.acknowledgePending(result.entries[0]);
    const names = await readdir(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^acknowledged-[a-f0-9]{32}$/);
    expect(await readFile(join(root, names[0], pending))).toEqual(before);
    expect((await lstat(join(root, names[0], pending))).mtimeMs).toBe(
      stat.mtimeMs,
    );
    await expect(journal.get("op")).rejects.toThrow();
    await expect(
      journal.acknowledgePending(result.entries[0]),
    ).rejects.toThrow();
    expect(
      (await journal.intent({ ...intent(), operation_id: "fresh" })).status,
    ).toBe("recorded");
    await journal.expire(new Date());
    expect(await readFile(join(root, names[0], pending))).toEqual(before);
  },
);
it.each([
  '{"version":2}',
  '{"unknown":1}',
  '{"version":1.5}',
  '{"version":1,"version":2}',
])("keeps opaque %s pending evidence blocked", async (content) => {
  const { root, journal } = await fixture();
  const name = "pending-" + "d".repeat(32);
  await writeFile(join(root, name), content);
  const result = await journal.inspectPending();
  expect(["future_version", "unrecognized"]).toContain(
    result.entries[0].classification,
  );
  await expect(journal.acknowledgePending(result.entries[0])).rejects.toThrow();
  expect(await readFile(join(root, name), "utf8")).toBe(content);
});
it("refuses an exact pending choice after replacement and preserves both versions", async () => {
  const { root, journal } = await fixture();
  const name = "pending-" + "e".repeat(32);
  await writeFile(join(root, name), '{"version":1,');
  const result = await journal.inspectPending();
  await rename(join(root, name), join(root, "human-backup"));
  await writeFile(join(root, name), '{"version":1, "different":true');
  await expect(journal.acknowledgePending(result.entries[0])).rejects.toThrow();
  expect(await readFile(join(root, "human-backup"), "utf8")).toBe(
    '{"version":1,',
  );
  expect(await readdir(root)).toHaveLength(2);
});
it("inventories only complete old bindings including a local intent missing from Core without renewing retention", async () => {
  const { root, journal } = await fixture();
  await journal.intent(intent());
  const path = join(root, "operation-op.json");
  const before = await readFile(path);
  expect(await journal.inspectJob(BINDING as CodeBinding)).toMatchObject({
    complete: true,
    operations: [{ operation_id: "op", observations: [] }],
  });
  expect(
    await journal.inspectJob({ ...BINDING, boot_id: "other" } as CodeBinding),
  ).toEqual({ complete: true, operations: [] });
  expect(await readFile(path)).toEqual(before);
  await writeFile(join(root, "operation-corrupt.json"), '{"version":2}');
  expect((await journal.inspectJob(BINDING as CodeBinding)).complete).toBe(
    false,
  );
});
it("acknowledged malformed v1 retains original strict 30-day age and then expires", async () => {
  const { root, journal } = await fixture();
  const name = "pending-" + "f".repeat(32),
    now = Date.now(),
    age = new Date(now - 31 * 86400000);
  await writeFile(join(root, name), '{"version":1,');
  await utimes(join(root, name), age, age);
  await journal.acknowledgePending((await journal.inspectPending()).entries[0]);
  await journal.expire(new Date());
  expect(await readdir(root)).toEqual([]);
});

it("refuses acknowledging otherwise valid v1 evidence whose original metadata clock is in the future", async () => {
  const { root, journal } = await fixture();
  await journal.intent(intent());
  const path = join(root, "operation-op.json"),
    name = "pending-" + "9".repeat(32);
  let text = await readFile(path, "utf8");
  const record = JSON.parse(text),
    futureMs = Date.now() + 86400000,
    future = new Date(futureMs).toISOString(),
    expiry = new Date(futureMs + 30 * 86400000).toISOString();
  text = text
    .replaceAll(record.created_at, future)
    .replaceAll(record.expires_at, expiry);
  await writeFile(join(root, name), text);
  const result = await journal.inspectPending();
  expect(result.entries[0].classification).toBe("unsafe");
  await expect(journal.acknowledgePending(result.entries[0])).rejects.toThrow();
});

it("an exclusive acknowledgment-directory collision never overwrites an existing destination", async () => {
  const { root, journal } = await fixture();
  const name = "pending-" + "7".repeat(32);
  await writeFile(join(root, name), '{"version":1,');
  const choice = (await journal.inspectPending()).entries[0];
  boundary.collision = true;
  await expect(journal.acknowledgePending(choice)).rejects.toThrow();
  expect(await readFile(join(root, name), "utf8")).toBe('{"version":1,');
  const retained = (await readdir(root)).find((entry) =>
    entry.startsWith("acknowledged-"),
  )!;
  expect(await readFile(join(root, retained, "human"), "utf8")).toBe(
    "retained human marker",
  );
  expect(await readdir(join(root, retained))).toEqual(["human"]);
});
it.each(["before", "after"] as const)(
  "an interruption %s acknowledgment rename preserves exact bytes/age and never promotes an operation",
  async (cutpoint) => {
    const { root, journal } = await fixture();
    const name = "pending-" + "8".repeat(32);
    await writeFile(join(root, name), '{"version":1,');
    const age = new Date(Date.now() - 1000);
    await utimes(join(root, name), age, age);
    const before = await lstat(join(root, name));
    const choice = (await journal.inspectPending()).entries[0];
    boundary.rename = cutpoint;
    await expect(journal.acknowledgePending(choice)).rejects.toThrow();
    boundary.rename = "";
    const directory = (await readdir(root)).find((entry) =>
      entry.startsWith("acknowledged-"),
    )!;
    const retained =
      cutpoint === "before" ? join(root, name) : join(root, directory, name);
    expect(await readFile(retained, "utf8")).toBe('{"version":1,');
    expect((await lstat(retained)).mtimeMs).toBe(before.mtimeMs);
    await expect(journal.get("op")).rejects.toThrow();
    const fresh = {
      ...intent(),
      operation_id: "fresh-op",
      binding: {
        ...intent().binding,
        job_id: "fresh-job",
        boot_id: "fresh-boot",
        pair_id: "fresh-pair",
      },
    };
    if (cutpoint === "before") {
      expect(await readdir(join(root, directory))).toEqual([]);
      await expect(journal.intent(fresh)).rejects.toThrow(
        /Inspect interrupted Sage journal/,
      );
    } else {
      expect(await readdir(join(root, directory))).toEqual([name]);
      expect((await journal.intent(fresh)).status).toBe("recorded");
    }
  },
);
