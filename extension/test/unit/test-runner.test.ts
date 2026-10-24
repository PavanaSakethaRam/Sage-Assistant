import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FOCUS_NAMES,
  recipeHash,
  type CodeIntent,
  type CodeReceipt,
} from "../../../desktop/shared/coding-contracts";
import { rootIdentity } from "../../../desktop/shared/editor-bridge";
import {
  captureContext,
  validateCreateProgress,
  releaseContext,
  contextOffer,
} from "../../src/context";
import {
  inspectNode,
  prepareFocusTest,
  runFocusTest,
  KnownResultOpener,
} from "../../src/test-runner";
import { ProposalReview } from "../../src/review";
type TestUri = { toString(): string; fsPath: string; scheme: string };
type TestDocument = {
  uri: TestUri;
  isClosed: boolean;
  isDirty: boolean;
  version: number;
  eol: number;
  encoding: string;
  getText(): string;
};
type Provider = {
  provideTextDocumentContent(u: { toString(): string }): string;
};
const ui = vi.hoisted(() => ({
  documents: [] as TestDocument[],
  choices: [] as (string | undefined)[],
  text: new Map<string, string>(),
  provider: undefined as Provider | undefined,
  beforeConfirm: undefined as (() => void | Promise<void>) | undefined,
  confirm: true,
  viewed: [] as string[],
  tabs: [] as { input: unknown }[],
  closed: [] as { input: unknown }[],
  external: [] as string[],
}));
const processDouble = vi.hoisted(() => ({
  spawn: undefined as
    | undefined
    | ((
        ...args: Parameters<typeof import("node:child_process").spawn>
      ) => ReturnType<typeof import("node:child_process").spawn>),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      processDouble.spawn
        ? processDouble.spawn(...args)
        : Reflect.apply(actual.spawn, undefined, args),
  };
});
const cleanupFault = vi.hoisted(() => ({
  enabled: false,
  delayed: false,
  reject: undefined as (() => void) | undefined,
  paths: [] as string[],
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      if (
        cleanupFault.enabled &&
        String(args[0]).includes("sage-focus-test-")
      ) {
        cleanupFault.paths.push(String(args[0]));
        if (cleanupFault.delayed)
          return new Promise<void>((_resolve, reject) => {
            cleanupFault.reject = () =>
              reject(Error("owned temp cleanup failed"));
          });
        return Promise.reject(Error("owned temp cleanup failed"));
      }
      return actual.rm(...args);
    },
  };
});
vi.mock("../../src/root-probe", () => ({
  probeRoot: async () => "native",
  validateRootSpelling() {},
}));
vi.mock("vscode", () => {
  const uri = (s: string) => ({
    toString: () => s,
    fsPath: s.startsWith("file:") ? fileURLToPath(s) : s,
    scheme: s.split(":")[0],
  });
  return {
    Uri: { file: (p: string) => uri(pathToFileURL(p).href), parse: uri },
    EndOfLine: { LF: 1 },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    TabInputText: class {
      constructor(public uri: TestUri) {}
    },
    TabInputTextDiff: class {},
    env: {
      openExternal: async () => {
        throw Error("Real OS opener forbidden");
      },
    },
    workspace: {
      get textDocuments() {
        return ui.documents;
      },
      registerTextDocumentContentProvider: (_s: string, p: Provider) => {
        ui.text.set("provider", "");
        ui.provider = p;
        return { dispose() {} };
      },
      openTextDocument: async (u: TestUri) => {
        if (u.scheme !== "file")
          return {
            uri: u,
            getText: () => ui.provider!.provideTextDocumentContent(u),
          };
        const existing = ui.documents.find(
          (d) => d.uri.toString() === u.toString(),
        );
        if (existing) return existing;
        const d = {
          uri: u,
          isClosed: false,
          isDirty: false,
          version: 1,
          eol: 1,
          encoding: "utf8",
          getText: () => readFileSync(u.fsPath, "utf8"),
        };
        ui.documents.push(d);
        return d;
      },
    },
    window: {
      tabGroups: {
        get all() {
          return [{ tabs: ui.tabs }];
        },
        close: async (tabs: { input: unknown }[]) => {
          ui.closed.push(...tabs);
          return true;
        },
      },
      showTextDocument: async (d: { uri: TestUri }) => {
        ui.viewed.push(d.uri.toString());
        return {};
      },
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => {
        await ui.beforeConfirm?.();
        return ui.confirm ? "Run fixed tests" : undefined;
      },
      createQuickPick: () => {
        let accept = () => {},
          hide = () => {};
        return {
          items: [] as { label: string }[],
          selectedItems: [] as { label: string }[],
          onDidAccept(cb: () => void) {
            accept = cb;
            return { dispose() {} };
          },
          onDidHide(cb: () => void) {
            hide = cb;
            return { dispose() {} };
          },
          dispose() {},
          hide() {
            hide();
          },
          show() {
            const c = ui.choices.shift();
            queueMicrotask(() => {
              if (!c) hide();
              else {
                this.selectedItems = this.items.filter((i) => i.label === c);
                accept();
              }
            });
          },
        };
      },
    },
  };
});
let NODE: string;
const roots: string[] = [];
const reviews: ProposalReview[] = [];
afterEach(async () => {
  cleanupFault.reject?.();
  cleanupFault.reject = undefined;
  cleanupFault.delayed = false;
  cleanupFault.enabled = false;
  await Promise.all(
    cleanupFault.paths
      .splice(0)
      .map((p) => rm(p, { recursive: true, force: true })),
  );
  processDouble.spawn = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const r of reviews.splice(0)) await r.dispose();
  ui.documents = [];
  ui.choices = [];
  ui.text.clear();
  ui.viewed = [];
  ui.tabs = [];
  ui.closed = [];
  ui.beforeConfirm = undefined;
  ui.confirm = true;
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture(
  source = "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('fixed',()=>assert.equal(2+2,4));\n",
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sage-test-runner-")),
  );
  roots.push(root);
  const stat = lstatSync(root, { bigint: true }),
    workspace = {
      root_uri: pathToFileURL(root).href,
      root_file_id: `${stat.dev}-${stat.ino}`,
      window_id: "window",
    },
    rid = rootIdentity(workspace);
  let valid = true;
  const binding = {
    job_id: "job",
    boot_id: "host",
    pair_id: "pair",
    window_id: "window",
    root_id: rid,
    revision: 1,
    policy_version: "code-v1" as const,
  };
  const context = await captureContext({
    pair: {
      ...workspace,
      root_id: rid,
      host_boot_id: "host",
      pair_id: "pair",
      challenge: "c",
      status: "paired",
    },
    binding,
    generation: 1,
    rawRootUri: workspace.root_uri,
    nativeIdentity: "native",
    extensionPath: root,
    storagePath: root,
    mode: "create_focus_project",
    names: [],
    diagnosticIds: [],
    guard: () => {
      if (!valid) throw Error("revoked");
    },
  });
  const proposal = {
    job_id: "job",
    revision: 1,
    explanation: "fixture",
    files: FOCUS_NAMES.map((name) => ({
      name,
      text: name === "focus.test.mjs" ? source : `// owned ${name}\n`,
    })),
  };
  const prefix: import("../../src/context").CreatedPrefix[] = [];
  for (const file of proposal.files) {
    await writeFile(join(root, file.name), file.text);
    prefix.push({
      name: file.name,
      stat: lstatSync(join(root, file.name), { bigint: true }),
    });
    await validateCreateProgress(context, proposal, prefix);
  }
  const messages: import("../../../desktop/shared/editor-bridge").BridgeData[] =
      [],
    intents: CodeIntent[] = [],
    receipts: CodeReceipt[] = [],
    handlers = new Set<
      (v: import("../../../desktop/shared/editor-bridge").BridgeData) => void
    >();
  let afterIntent: (() => void | Promise<void>) | undefined;
  const bridge = {
    onData: (
      cb: (
        v: import("../../../desktop/shared/editor-bridge").BridgeData,
      ) => void,
    ) => {
      handlers.add(cb);
      return () => handlers.delete(cb);
    },
    send: async (
      v: import("../../../desktop/shared/editor-bridge").BridgeData,
    ) => {
      messages.push(v);
      if (v.kind === "review.decision") {
        for (const h of handlers)
          h({
            kind: "grant.reply",
            binding,
            payload: {
              kind: "grant",
              grant: {
                binding,
                scope: "code.test",
                approved_hash: v.payload.approved_hash,
                operation_id: "operation",
                grant_boot_id: "core",
                issued_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
                expires_at: new Date(Date.now() + 290000)
                  .toISOString()
                  .replace(/\.\d{3}Z$/, "Z"),
              },
            },
          });
      }
    },
    recordIntent: async (_j: unknown, i: CodeIntent) => {
      intents.push(i);
      await afterIntent?.();
      return {};
    },
    recordObserved: async (_j: unknown, r: CodeReceipt) => {
      receipts.push(r);
      return {};
    },
  };
  const review = new ProposalReview({
    bridge: bridge as unknown as import("../../src/bridge").ExtensionBridge,
    journal: {} as import("../../src/journal").EffectJournal,
    guard: () => {
      if (!valid) throw Error("revoked");
    },
    onFailure: async () => {
      valid = false;
    },
  });
  reviews.push(review);
  return {
    root,
    context,
    review,
    messages,
    intents,
    receipts,
    afterIntent(fn: () => void | Promise<void>) {
      afterIntent = fn;
    },
    revoke() {
      valid = false;
      releaseContext(context);
    },
  };
}
async function approved(f: Awaited<ReturnType<typeof fixture>>) {
  const vscode = await import("vscode");
  const node = await inspectNode(vscode.Uri.file(NODE));
  const recipe = await prepareFocusTest(f.context, node);
  ui.choices = ["Run fixed tests"];
  await f.review.showTest(f.context, recipe);
  return recipe;
}
async function fakeProcess(
  mode:
    | "probe"
    | "spawn-error"
    | "null-exit"
    | "stream-error"
    | "lost-completion"
    | "unconfirmed"
    | "term-force",
  output = "",
) {
  const { EventEmitter } = await import("node:events"),
    { PassThrough } = await import("node:stream");
  const c = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    exitCode: null as number | null,
    signalCode: null as string | null,
    pid: 12345,
    kill: vi.fn((signal: string) => typeof signal === "string"),
  });
  const end = (code: number | null, signal: string | null) => {
    c.exitCode = code;
    c.signalCode = signal;
    c.stdout.end();
    c.stderr.end();
    c.emit("exit", code, signal);
  };
  c.kill.mockImplementation((s) => {
    if (mode === "term-force" && s === "SIGKILL") end(null, "SIGKILL");
    return true;
  });
  const start = () =>
    queueMicrotask(() => {
      if (mode === "spawn-error") {
        c.emit("error", Error("owned synthetic spawn error"));
        return;
      }
      c.emit("spawn");
      if (output) c.stdout.write(output);
      if (mode === "probe") end(0, null);
      if (mode === "null-exit") end(null, null);
      if (mode === "stream-error") {
        c.stdout.emit("error", Error("owned stream fault"));
        end(0, null);
      }
      if (mode === "lost-completion") {
        c.exitCode = 0;
        c.emit("exit", 0, null);
      }
    });
  return Object.assign(c, { start });
}
it("fixed opener requires current saved identities and emits only canonical index file URI", async () => {
  const f = await fixture(),
    calls: string[] = [],
    opener = new KnownResultOpener(async (u) => {
      calls.push(u.toString());
      return true;
    });
  await opener.openKnownResult(f.context, "index.html", "browser");
  expect(calls).toEqual([pathToFileURL(join(f.root, "index.html")).href]);
  await expect(
    opener.openKnownResult(f.context, "focus.js", "browser"),
  ).rejects.toThrow();
  await writeFile(join(f.root, "index.html"), "human");
  await expect(
    opener.openKnownResult(f.context, "index.html", "browser"),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

it("older standalone runtime remains unavailable, without fallback", async () => {
  const vscode = await import("vscode"),
    node = await inspectNode(vscode.Uri.file(process.execPath));
  // Unit host may itself be the pinned Node. Only a genuinely older runtime exercises this lane.
  if (process.version !== "v26.12.1") expect(node.available).toBe(false);
  else expect(node.version).toBe("26.12.1");
});

it("rejected known-file handoff reports failure without changing target", async () => {
  const f = await fixture(),
    opener = new KnownResultOpener(async () => false);
  await expect(
    opener.openKnownResult(f.context, "index.html", "browser"),
  ).rejects.toThrow(/handoff/);
  f.revoke();
  await expect(
    opener.openKnownResult(f.context, "index.html", "browser"),
  ).rejects.toThrow();
});

it.each(["v26.10.0\n", "v26.13.0\n"])(
  "version probe %s remains unavailable without recorded build evidence",
  async (version) => {
    const child = await fakeProcess("probe", version);
    processDouble.spawn = () => {
      child.start();
      return child as unknown as ReturnType<
        typeof import("node:child_process").spawn
      >;
    };
    const vscode = await import("vscode"),
      candidate = await inspectNode(vscode.Uri.file(process.execPath));
    expect(candidate.available).toBe(false);
  },
);
it.each([
  "v26.12.1-rc.1\n",
  "v26.12.1\nv26.12.1\n",
  "v26.12.1\r\n",
  "v26.12.1\n\n",
])("probe rejects non-exact stable single line %s", async (version) => {
  const child = await fakeProcess("probe", version);
  processDouble.spawn = () => {
    child.start();
    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  };
  const vscode = await import("vscode");
  await expect(
    inspectNode(vscode.Uri.file(process.execPath)),
  ).rejects.toThrow();
});

describe("measured standalone Node recipe", () => {
  const pinnedHash =
    "06eb3f5762c2b6890e99d03f931bf01d9b20fd341dec1a8c1ef5c1809e66102b";
  let sourceNode: string;
  beforeAll(async () => {
    sourceNode = await realpath(process.execPath);
    const source = lstatSync(sourceNode);
    if (
      process.release.name !== "node" ||
      process.versions.electron ||
      process.version !== "v26.12.1" ||
      process.platform !== "darwin" ||
      process.arch !== "arm64" ||
      !source.isFile() ||
      source.isSymbolicLink() ||
      source.nlink !== 1 ||
      createHash("sha256").update(readFileSync(sourceNode)).digest("hex") !==
        pinnedHash
    )
      throw Error("Unsupported standalone Node recipe prerequisite");
  });
  beforeEach(async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "sage-node-fixture-")),
    );
    roots.push(directory);
    NODE = join(directory, "node");
    await copyFile(sourceNode, NODE);
    await chmod(NODE, 0o700);
    const source = lstatSync(sourceNode),
      selected = lstatSync(NODE);
    expect(selected.isFile() && !selected.isSymbolicLink()).toBe(true);
    expect(selected.nlink).toBe(1);
    expect(String(selected.dev) + "-" + String(selected.ino)).not.toBe(
      String(source.dev) + "-" + String(source.ino),
    );
    expect(readFileSync(NODE).equals(readFileSync(sourceNode))).toBe(true);
    expect(createHash("sha256").update(readFileSync(NODE)).digest("hex")).toBe(
      pinnedHash,
    );
  });
  it("accepts only the exact recorded standalone Node identity/version, never a copied candidate", async () => {
    const vscode = await import("vscode"),
      node = await inspectNode(vscode.Uri.file(NODE));
    expect(node).toMatchObject({ version: "26.12.1", available: true });
    const f = await fixture();
    await expect(prepareFocusTest(f.context, { ...node })).rejects.toThrow();
  });
  it("binds the fixed argv, saved hashes, original lease, empty PATH and owned temp map", async () => {
    const f = await fixture(),
      vscode = await import("vscode"),
      node = await inspectNode(vscode.Uri.file(NODE));
    const r = await prepareFocusTest(f.context, node);
    expect(r.argv).toEqual([
      "--test",
      "--test-isolation=none",
      "--test-reporter=tap",
      "focus.test.mjs",
    ]);
    expect(r.file_hashes.map((x) => x.name)).toEqual(FOCUS_NAMES);
    expect(r.environment.PATH).toBe("");
    expect(r.environment.HOME).toBeUndefined();
    expect(r.timeout_seconds).toBe(30);
    expect(r.recipe_hash).toBe(await recipeHash(r));
    expect(Date.parse(r.deadline)).toBeLessThanOrEqual(
      contextOffer(f.context).expires_at_ms,
    );
    await expect(runFocusTest(r, {} as never)).rejects.toThrow(/confirmation/);
  });
  it.each([
    ["success", "", "passed", 0],
    ["nonzero", "process.exitCode=1;", "failed", 1],
    ["overflow", "process.stdout.write('x'.repeat(300000));", "failed", null],
    [
      "mutation",
      "import {writeFileSync} from 'node:fs'; writeFileSync('focus.js','changed');",
      "changed_during_test",
      0,
    ],
  ] as const)(
    "real process %s has a correlated receipt and bounded digest",
    async (_name, body, status, code) => {
      const f = await fixture(body + "\n");
      await approved(f);
      expect(f.receipts).toHaveLength(1);
      const r = f.receipts[0];
      expect(r).toMatchObject({
        scope: "code.test",
        status,
        cancel_requested: false,
        timeout: false,
      });
      if (code !== null) expect(r).toHaveProperty("exit_code", code);
      expect(r).toHaveProperty(
        "output_digest",
        expect.stringMatching(/^[0-9a-f]{64}$/),
      );
      expect(JSON.stringify(r)).not.toContain(f.root);
      expect(JSON.stringify(r)).not.toContain("owned");
      expect(f.messages.some((m) => m.kind === "test.preview")).toBe(true);
      expect(f.messages.some((m) => m.kind === "result.dismissed")).toBe(false);
    },
  );
  it("refuses dirty saved buffers before test authority or intent", async () => {
    const f = await fixture();
    ui.documents[0].isDirty = true;
    await expect(approved(f)).rejects.toThrow();
    expect(f.intents).toEqual([]);
  });
  it("revocation after intent stops spawning and clears transient text", async () => {
    const f = await fixture();
    f.afterIntent(() => f.revoke());
    await expect(approved(f)).rejects.toThrow();
    expect(f.receipts).toEqual([]);
  });
  it("real timeout never passes and confirms same owned child termination", async () => {
    const f = await fixture("setInterval(()=>{},1000);\n");
    await approved(f);
    expect(f.receipts[0]).toMatchObject({
      status: "failed",
      timeout: true,
      cancel_requested: false,
      exit_code: 0,
      signal: null,
    });
  }, 40000);
  it("real cancellation drops output promptly while preserving the late receipt", async () => {
    const f = await fixture(
      "process.stdout.write('private transient'); setInterval(()=>{},1000);\n",
    );
    f.afterIntent(() => {
      setTimeout(() => f.revoke(), 300);
    });
    await expect(approved(f)).rejects.toThrow();
    expect(f.receipts[0]).toMatchObject({
      status: "cancelled",
      cancel_requested: true,
      timeout: false,
    });
  });
  it("exit_with_inherited_stdout_stays_bounded and does not claim descendant containment", async () => {
    const f = await fixture(
      "import {spawn} from 'node:child_process'; spawn(process.execPath,['-e','setTimeout(()=>{},4500)'],{stdio:['ignore',1,2],detached:false}).unref();\n",
    );
    const actual =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    let exitedAt: number | undefined;
    const ended: string[] = [];
    f.afterIntent(() => {
      processDouble.spawn = (...args) => {
        const child = Reflect.apply(actual.spawn, undefined, args);
        if (Array.isArray(args[1]) && args[1][0] === "--test") {
          child.once("exit", () => {
            exitedAt = performance.now();
          });
          child.stdout!.once("end", () => ended.push("stdout"));
          child.stderr!.once("end", () => ended.push("stderr"));
        }
        return child;
      };
    });
    await approved(f);
    expect(f.receipts[0]).toMatchObject({
      status: "unknown",
      exit_code: 0,
      signal: null,
      timeout: false,
    });
    expect(exitedAt).toBeTypeOf("number");
    expect(performance.now() - exitedAt!).toBeLessThan(4400);
    expect(ended).toEqual([]);
    // The owned fixture descendant settles itself; wait for its bounded cleanup before deleting files.
    await new Promise((r) => setTimeout(r, 1800));
  }, 8000);
  it.each(["during review", "after intent"] as const)(
    "a genuinely inspected executable changed %s refuses before any fixed-test spawn",
    async (boundary) => {
      const f = await fixture(),
        vscode = await import("vscode"),
        actual =
          await vi.importActual<typeof import("node:child_process")>(
            "node:child_process",
          ),
        directory = await realpath(
          await mkdtemp(join(tmpdir(), "sage-selected-node-")),
        ),
        selected = join(directory, "node"),
        calls: { executable: string; argv: readonly string[] }[] = [],
        hash = (path: string) =>
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        pinnedHash = hash(NODE);
      roots.push(directory);
      await copyFile(NODE, selected);
      await chmod(selected, 0o700);
      expect(hash(selected)).toBe(pinnedHash);
      expect(lstatSync(selected).ino).not.toBe(lstatSync(NODE).ino);
      processDouble.spawn = (...args) => {
        const argv = Array.isArray(args[1]) ? args[1] : [];
        calls.push({ executable: args[0], argv });
        // A failed guard must be observable without executing the mutated file.
        if (argv[0] !== "--version") throw Error("Unexpected fixed-test spawn");
        return Reflect.apply(actual.spawn, undefined, args);
      };
      const node = await inspectNode(vscode.Uri.file(selected));
      expect(node).toMatchObject({
        executable: selected,
        hash: pinnedHash,
        version: "26.12.1",
        available: true,
      });
      const recipe = await prepareFocusTest(f.context, node);
      expect(recipe.executable).toBe(selected);
      expect(recipe.executable_hash).toBe(pinnedHash);
      let changed = false;
      const mutate = async () => {
        const before = lstatSync(selected, { bigint: true });
        if (boundary === "during review") {
          await appendFile(selected, "\0");
          expect(hash(selected)).not.toBe(pinnedHash);
        } else {
          const replacement = join(directory, "replacement");
          await copyFile(NODE, replacement);
          await chmod(replacement, 0o700);
          await rename(replacement, selected);
          expect(hash(selected)).toBe(pinnedHash);
          expect(lstatSync(selected, { bigint: true }).ino).not.toBe(
            before.ino,
          );
        }
        changed = true;
      };
      if (boundary === "during review") ui.beforeConfirm = mutate;
      else f.afterIntent(mutate);
      ui.choices = ["Run fixed tests"];
      await expect(f.review.showTest(f.context, recipe)).rejects.toThrow(
        "Fixed test recipe unavailable or changed",
      );
      expect(changed).toBe(true);
      expect(f.intents).toHaveLength(boundary === "during review" ? 0 : 1);
      expect(f.receipts).toEqual([]);
      expect(calls).toEqual([{ executable: selected, argv: ["--version"] }]);
      expect(calls.filter((call) => call.argv[0] === "--test")).toEqual([]);
      expect(hash(NODE)).toBe(pinnedHash);
    },
  );
  it.each([
    "spawn-error",
    "null-exit",
    "stream-error",
    "lost-completion",
  ] as const)(
    "unit process event double %s cannot falsely pass",
    async (mode) => {
      const f = await fixture();

      let child: Awaited<ReturnType<typeof fakeProcess>>;
      f.afterIntent(async () => {
        child = await fakeProcess(mode);
        processDouble.spawn = () => {
          child.start();
          return child as unknown as ReturnType<
            typeof import("node:child_process").spawn
          >;
        };
      });
      await approved(f);
      expect(f.receipts[0]).toMatchObject({
        status: "unknown",
        timeout: false,
        overflow: false,
      });
      expect(child!.stdout.destroyed).toBe(true);
      if (mode === "stream-error")
        expect(child!.kill).toHaveBeenCalledWith("SIGTERM");
      else expect(child!.kill).not.toHaveBeenCalled();
      if (mode === "lost-completion" || mode === "stream-error")
        expect(f.receipts[0]).toHaveProperty("exit_code", 0);
    },
    8000,
  );
  it("actual captured output is inert/read-only and retained until explicit Done", async () => {
    const f = await fixture(
      "process.stdout.write('\\u001b[31msynthetic literal\\u001b[0m\\u0000');\n",
    );
    const recipe = await approved(f),
      { testResultText } = await import("../../src/test-runner");
    expect(testResultText(recipe)).toContain("synthetic literal");
    expect(testResultText(recipe)).not.toContain("\x1b");
    expect(testResultText(recipe)).not.toContain("\0");
    const text = ui.provider!.provideTextDocumentContent({
      toString: () => ui.viewed.at(-1)!,
    });
    expect(text).toContain("Fixed test result: passed");
    expect(text).toContain("Exit: 0");
    expect(text).toContain("Generated tests do not certify app behavior");
    const vscode = await import("vscode"),
      owned = {
        input: new vscode.TabInputText(vscode.Uri.parse(ui.viewed.at(-1)!)),
      },
      human = {
        input: new vscode.TabInputText(
          vscode.Uri.file(join(f.root, "index.html")),
        ),
      },
      unrelated = {
        input: new vscode.TabInputText(
          vscode.Uri.parse("sage-diff:/unrelated-owner"),
        ),
      };
    ui.tabs = [owned, human, unrelated];
    ui.choices = ["Done"];
    await f.review.resultControls(f.context);
    expect(ui.closed).toEqual([owned]);
    expect(
      f.messages.filter((m) => m.kind === "result.dismissed"),
    ).toHaveLength(1);
    expect(() => testResultText(recipe)).toThrow();
  });
  it("an expired latest-start cannot create an intent or renew its preview", async () => {
    const f = await fixture(),
      vscode = await import("vscode"),
      node = await inspectNode(vscode.Uri.file(NODE)),
      recipe = await prepareFocusTest(f.context, node);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(recipe.deadline));
    await expect(f.review.showTest(f.context, recipe)).rejects.toThrow();
    expect(f.intents).toEqual([]);
  });
  it("declining the separate test review has zero execution effects", async () => {
    const f = await fixture(),
      vscode = await import("vscode"),
      node = await inspectNode(vscode.Uri.file(NODE)),
      recipe = await prepareFocusTest(f.context, node);
    ui.choices = ["Decline"];
    await f.review.showTest(f.context, recipe);
    expect(f.intents).toEqual([]);
    expect(f.receipts).toEqual([]);
  });
  it("unit live-child double forces only the same child after two seconds and retains overflow facts", async () => {
    const f = await fixture();
    let child: Awaited<ReturnType<typeof fakeProcess>> | undefined,
      started = false;
    let bornResolve = () => {};
    const born = new Promise<void>((resolve) => {
      bornResolve = resolve;
    });
    f.afterIntent(async () => {
      child = await fakeProcess("term-force", "x".repeat(262145));
      processDouble.spawn = () => {
        started = true;
        child!.start();
        bornResolve();
        return child as unknown as ReturnType<
          typeof import("node:child_process").spawn
        >;
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    const work = approved(f);
    await born;
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(child!.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    await work;
    expect(child!.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(f.receipts[0]).toMatchObject({
      status: "failed",
      overflow: true,
      timeout: false,
      signal: "SIGKILL",
      exit_code: null,
    });
  }, 8000);
  it("correlates the digest with actual combined captured bytes, independently of inert display", async () => {
    const f = await fixture(
      "process.stdout.write('constant-output\\u001b[31m');process.stderr.write('constant-error');\n",
    );
    const original =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        ),
      chunks: Buffer[] = [];
    f.afterIntent(() => {
      processDouble.spawn = (...args: Parameters<typeof original.spawn>) => {
        const child = Reflect.apply(
          original.spawn,
          undefined,
          args,
        ) as ReturnType<typeof original.spawn>;
        for (const stream of [child.stdout, child.stderr])
          stream!.on("data", (b: Buffer) => chunks.push(Buffer.from(b)));
        return child as unknown as ReturnType<
          typeof import("node:child_process").spawn
        >;
      };
    });
    await approved(f);
    expect(
      "output_digest" in f.receipts[0] ? f.receipts[0].output_digest : null,
    ).toBe(createHash("sha256").update(Buffer.concat(chunks)).digest("hex"));
  });
  it("revoked source observation never resamples expired document text while settling cancellation", async () => {
    const f = await fixture("setInterval(()=>{},1000);\n");
    let revoked = false,
      expiredReads = 0;
    for (const document of ui.documents) {
      const get = document.getText;
      document.getText = () => {
        if (revoked) {
          expiredReads++;
          throw Error("expired source read");
        }
        return get();
      };
    }
    f.afterIntent(() => {
      setTimeout(() => {
        revoked = true;
        f.revoke();
      }, 300);
    });
    await expect(approved(f)).rejects.toThrow();
    expect(expiredReads).toBe(0);
    expect(f.receipts[0]).toMatchObject({
      status: "cancelled",
      cancel_requested: true,
    });
  });
  it("owned temp cleanup failure cannot discard actual child exit or its receipt", async () => {
    const f = await fixture();
    f.afterIntent(() => {
      cleanupFault.enabled = true;
    });
    const recipe = await approved(f);
    expect(
      (await import("../../src/test-runner")).testResultText(recipe),
    ).toContain("Temporary cleanup incomplete");
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]).toMatchObject({
      scope: "code.test",
      status: "passed",
      exit_code: 0,
      signal: null,
      timeout: false,
      overflow: false,
    });
  });
  it("pending cleanup never delays receipt and a later rejection appears on result inspection", async () => {
    const f = await fixture();
    f.afterIntent(() => {
      cleanupFault.enabled = true;
      cleanupFault.delayed = true;
    });
    const recipe = await approved(f);
    expect(f.receipts[0]).toMatchObject({ status: "passed", exit_code: 0 });
    expect(cleanupFault.reject).toBeDefined();
    const runner = await import("../../src/test-runner");
    expect(runner.testResultText(recipe)).not.toContain(
      "Temporary cleanup incomplete",
    );
    cleanupFault.reject!();
    await Promise.resolve();
    await Promise.resolve();
    const vscode = await import("vscode");
    let warned = false;
    vi.spyOn(vscode.window, "showTextDocument").mockImplementation(
      async (document: unknown) => {
        warned = (document as { getText(): string })
          .getText()
          .includes("Temporary cleanup incomplete");
        return {} as never;
      },
    );
    ui.choices = ["Inspect test result", "Done"];
    await f.review.resultControls(f.context);
    expect(warned).toBe(true);
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]).toMatchObject({
      status: "passed",
      exit_code: 0,
      timeout: false,
      overflow: false,
    });
  });
  it("unit lost-completion double blocks new tests after bounded unconfirmed termination", async () => {
    const f = await fixture(),
      vscode = await import("vscode"),
      node = await inspectNode(vscode.Uri.file(NODE));
    let child: Awaited<ReturnType<typeof fakeProcess>> | undefined,
      started = false;
    f.afterIntent(async () => {
      child = await fakeProcess("unconfirmed");
      processDouble.spawn = () => {
        started = true;
        child!.start();
        return child as unknown as ReturnType<
          typeof import("node:child_process").spawn
        >;
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    const work = approved(f);
    await vi.waitFor(() => expect(started).toBe(true));
    await vi.advanceTimersByTimeAsync(35000);
    await work;
    expect(child!.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(f.receipts[0]).toMatchObject({
      status: "termination_unconfirmed",
      timeout: true,
      exit_code: null,
      signal: null,
    });
    await expect(prepareFocusTest(f.context, node)).rejects.toThrow();
  }, 8000);
});
