/** One fixed standalone Node probe/recipe/owned child. Test code retains user authority. */
import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, lstat, realpath, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedChildEnv } from "../../desktop/main/child-env";
import {
  FOCUS_NAMES,
  recipeHash,
  type CodeContext,
  type TestRecipe,
  type CodeReceipt,
  type CodeTestReceipt,
  type FocusName,
} from "../../desktop/shared/coding-contracts";
import { focusTestState, onContextRelease, contextOffer } from "./context";
import { consumeLocalTestReview, type LocalReview } from "./review";
import { journalHash } from "./journal";
const TEST_ARGV = [
  "--test",
  "--test-isolation=none",
  "--test-reporter=tap",
  "focus.test.mjs",
] as const;
const PIN = "06eb3f5762c2b6890e99d03f931bf01d9b20fd341dec1a8c1ef5c1809e66102b";
export type NodeCandidate = Readonly<{
  executable: string;
  identity: string;
  hash: string;
  version: string;
  available: boolean;
  readiness: string;
}>;
const candidates = new WeakMap<NodeCandidate, BigIntStats>();
type Prepared = {
  context: CodeContext;
  node: NodeCandidate;
  state: Awaited<ReturnType<typeof focusTestState>>;
  temp: string;
  controller: AbortController;
  output?: () => string;
  clearOutput?: () => void;
  cleanup?: Promise<void>;
  cleanupIncomplete?: boolean;
  used: boolean;
  clear: () => void;
};
function cleanupPrepared(p: Prepared): Promise<void> {
  p.cleanup ??= rm(p.temp, { recursive: true, force: true }).catch(() => {
    p.cleanupIncomplete = true;
  });
  return p.cleanup;
}
const recipes = new WeakMap<TestRecipe, Prepared>();
let terminationUnconfirmed = false,
  activeChild = false;
function unavailable(): never {
  throw Error("Fixed test recipe unavailable or changed");
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    a.nlink === 1n &&
    b.nlink === 1n &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
async function executable(path: string) {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > 268435456n ||
    (process.getuid && before.uid !== BigInt(process.getuid())) ||
    (await realpath(path)) !== path
  )
    unavailable();
  const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    ),
    hash = createHash("sha256");
  try {
    if (!same(before, await handle.stat({ bigint: true }))) unavailable();
    const bytes = Buffer.alloc(65536);
    let offset = 0;
    while (true) {
      const n = await handle.read(bytes, 0, bytes.length, offset);
      if (!n.bytesRead) break;
      offset += n.bytesRead;
      if (offset > 268435456) unavailable();
      hash.update(bytes.subarray(0, n.bytesRead));
    }
    if (
      BigInt(offset) !== before.size ||
      !same(before, await handle.stat({ bigint: true })) ||
      !same(before, await lstat(path, { bigint: true }))
    )
      unavailable();
  } finally {
    await handle.close();
  }
  return {
    stat: before,
    hash: hash.digest("hex"),
    identity: `${before.dev}-${before.ino}`,
  };
}
function inert(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
/** Direct exit is separate from complete captured pipes; never a descendant-containment claim. */
function collect(
  child: ChildProcess,
  limit: number,
  cap: number,
  signal: AbortSignal,
) {
  let spawned = false,
    ended = false,
    stdout = false,
    stderr = false,
    broken = false,
    settled = false,
    cancelling = signal.aborted,
    timeout = false,
    overflow = false,
    code: number | null = null,
    exitSignal: string | null = null,
    bytes = 0;
  let chunks: Buffer[] = [],
    retain = !signal.aborted;
  const hash = createHash("sha256"),
    timers = new Set<ReturnType<typeof setTimeout>>();
  const clear = () => {
    retain = false;
    chunks = [];
  };
  let finish: () => void;
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    timers.add(timer);
    return timer;
  };
  const live = () =>
    spawned && !ended && child.exitCode === null && child.signalCode === null;
  let stopping = false,
    termSent = false;
  const terminate = () => {
    if (live() && !termSent) {
      termSent = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* Observe the owned child within the fixed bound. */
      }
    }
  };
  const stop = () => {
    if (stopping || settled) return;
    stopping = true;
    terminate();
    later(() => {
      if (live()) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* Unconfirmed is reported after bounded observation. */
        }
      }
    }, 2000);
    later(() => finish(), 5000);
  };
  const abort = () => {
    cancelling = true;
    clear();
    stop();
  };
  const complete = () => {
    if (ended && stdout && stderr) finish();
  };
  const result = new Promise<{
    spawned: boolean;
    ended: boolean;
    complete: boolean;
    code: number | null;
    signal: string | null;
    cancelling: boolean;
    timeout: boolean;
    overflow: boolean;
    digest: string;
    text: (literal?: boolean) => string;
  }>((resolve) => {
    finish = () => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      resolve({
        spawned,
        ended,
        complete: ended && stdout && stderr && !broken,
        code,
        signal: exitSignal,
        cancelling,
        timeout,
        overflow,
        digest: hash.digest("hex"),
        text: (literal = false) =>
          retain
            ? literal
              ? Buffer.concat(chunks).toString("utf8")
              : inert(Buffer.concat(chunks).toString("utf8"))
            : "",
      });
    };
    const data = (chunk: Buffer) => {
      const count = Math.min(chunk.length, Math.max(0, cap - bytes));
      if (count) {
        const part = chunk.subarray(0, count);
        hash.update(part);
        if (retain) chunks.push(Buffer.from(part));
        bytes += count;
      }
      if (chunk.length > count) {
        overflow = true;
        stop();
      }
    };
    child.once("spawn", () => {
      spawned = true;
      if (signal.aborted) {
        abort();
        terminate();
      }
    });
    child.once("error", () => {
      broken = true;
      if (!spawned) finish();
      else stop();
    });
    child.once("exit", (c, s) => {
      ended = true;
      clearTimeout(runtimeTimer);
      code = c;
      exitSignal = s;
      complete();
      if (!settled) later(() => finish(), 3000);
    });
    for (const [name, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      if (!stream) {
        broken = true;
        continue;
      }
      stream.on("data", data);
      stream.once("error", () => {
        broken = true;
        stop();
      });
      stream.once("end", () => {
        if (name === "stdout") stdout = true;
        else stderr = true;
        complete();
      });
    }
    const runtimeTimer = later(() => {
      timeout = true;
      stop();
    }, limit);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  return { result, clear };
}
function environment(temp: string): Record<string, string> {
  const parent: NodeJS.ProcessEnv = {};
  // Only validated OS essentials are read. No identity, proxy, token or Node options are inherited.
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive"]) {
    const matches = Object.keys(process.env).filter(
      (k) => k.toUpperCase() === key.toUpperCase(),
    );
    if (matches.length > 1) unavailable();
    const value = matches.length ? process.env[matches[0]] : undefined;
    if (value !== undefined) {
      if (
        value.length > 4096 ||
        /[\x00-\x1f]/.test(value) ||
        (value &&
          (key === "SystemDrive"
            ? !/^[A-Za-z]:$/.test(value)
            : !isAbsolute(value)))
      )
        unavailable();
      parent[key] = value;
    }
  }
  const map = isolatedChildEnv(
    {
      PATH: "",
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
      ...(process.platform === "win32" ? { HOME: "" } : {}),
    },
    process.platform,
    parent,
  );
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => {
      if (typeof v !== "string") unavailable();
      return [k, v];
    }),
  );
}
export async function inspectNode(uri: vscode.Uri): Promise<NodeCandidate> {
  if (terminationUnconfirmed || activeChild) unavailable();
  const url = new URL(uri.toString());
  if (
    url.protocol !== "file:" ||
    url.host ||
    url.search ||
    url.hash ||
    pathToFileURL(fileURLToPath(url)).href !== uri.toString()
  )
    unavailable();
  const path = fileURLToPath(url);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath,
      part = relative(root, path);
    if (
      !part ||
      (!part.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
        !isAbsolute(part))
    )
      unavailable();
  }
  const before = await executable(path),
    temp = await realpath(await mkdtemp(join(tmpdir(), "sage-node-probe-")));
  try {
    const child = spawn(path, ["--version"], {
        cwd: temp,
        env: environment(temp),
        shell: false,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      capture = collect(child, 5000, 4096, new AbortController().signal),
      observed = await capture.result;
    if (observed.spawned && !observed.ended) terminationUnconfirmed = true;
    const output = observed.text(true);
    capture.clear();
    if (
      !observed.complete ||
      observed.code !== 0 ||
      observed.signal ||
      observed.timeout ||
      observed.overflow ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+\n$/.test(output)
    )
      unavailable();
    const after = await executable(path);
    if (!same(before.stat, after.stat) || before.hash !== after.hash)
      unavailable();
    const version = output.slice(1, -1),
      available =
        process.platform === "darwin" &&
        process.arch === "arm64" &&
        version === "26.12.1" &&
        after.hash === PIN;
    const candidate = Object.freeze({
      executable: path,
      identity: after.identity,
      hash: after.hash,
      version,
      available,
      readiness: available
        ? "Recorded Darwin arm64 26.12.1 recipe; native additions disclosed separately"
        : "Build/platform recipe unavailable; no fallback",
    });
    candidates.set(candidate, after.stat);
    return candidate;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function prepareFocusTest(
  context: CodeContext,
  node: NodeCandidate,
): Promise<TestRecipe> {
  if (
    !candidates.has(node) ||
    !node.available ||
    terminationUnconfirmed ||
    activeChild
  )
    unavailable();
  const state = await focusTestState(context),
    r = relative(state.root, node.executable);
  if (
    !r ||
    (!r.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
      !isAbsolute(r))
  )
    unavailable();
  const actual = await executable(node.executable);
  state.check();
  if (!same(candidates.get(node)!, actual.stat) || actual.hash !== node.hash)
    unavailable();
  const temp = await realpath(
      await mkdtemp(join(tmpdir(), "sage-focus-test-")),
    ),
    controller = new AbortController();
  let unsubscribe = () => {};
  const prepared: Prepared = {
    context,
    node,
    state,
    temp,
    controller,
    used: false,
    clear: () => {
      controller.abort();
      prepared.clearOutput?.();
      unsubscribe();
      if (!prepared.used) void cleanupPrepared(prepared);
    },
  };
  try {
    state.check();
    unsubscribe = onContextRelease(context, prepared.clear);
    const value: TestRecipe = {
      platform: process.platform as "darwin" | "win32",
      executable: node.executable,
      executable_identity: node.identity,
      executable_hash: node.hash,
      executable_version: node.version,
      argv: [...TEST_ARGV] as [string, string, string, string],
      cwd: state.root,
      root_id: context.binding.root_id,
      environment: Object.freeze(environment(temp)),
      file_hashes: Object.freeze(
        state.files.map((file) => Object.freeze(file)),
      ),
      deadline: new Date(
        Math.floor(Math.min(Date.now() + 300000, state.expires) / 1000) * 1000,
      )
        .toISOString()
        .replace(/\.000Z$/, "Z"),
      output_cap: 262144,
      timeout_seconds: 30,
      recipe_hash: "0".repeat(64),
    };
    const recipe = Object.freeze({
      ...value,
      argv: Object.freeze(value.argv),
      recipe_hash: await recipeHash(value),
    });
    state.check();
    recipes.set(recipe, prepared);
    return recipe;
  } catch (error) {
    prepared.clear();
    throw error;
  }
}
export function testRecipeContext(recipe: TestRecipe): CodeContext {
  const p = recipes.get(recipe);
  if (!p || p.used) unavailable();
  p.state.check();
  if (Date.now() >= Date.parse(recipe.deadline)) unavailable();
  return p.context;
}
export function testResultText(recipe: TestRecipe): string {
  const p = recipes.get(recipe);
  if (!p) unavailable();
  contextOffer(p.context);
  return (
    (p.cleanupIncomplete ? "Temporary cleanup incomplete\n\n" : "") +
    (p.output?.() ?? "")
  );
}
export function clearTestRecipe(recipe: TestRecipe): void {
  recipes.get(recipe)?.clear();
}
export async function runFocusTest(
  recipe: TestRecipe,
  approval: LocalReview,
): Promise<CodeReceipt> {
  const owner = consumeLocalTestReview(approval, recipe),
    p = recipes.get(recipe);
  if (!p || p.used || activeChild || terminationUnconfirmed) unavailable();
  owner.check();
  p.state.check();
  const current = await executable(recipe.executable);
  owner.check();
  p.state.check();
  if (
    !same(candidates.get(p.node)!, current.stat) ||
    current.hash !== recipe.executable_hash ||
    (await recipeHash(recipe)) !== recipe.recipe_hash
  )
    unavailable();
  owner.check();
  const intent = {
    binding: p.context.binding,
    scope: "code.test" as const,
    operation_id: owner.grant.operation_id,
    effect_id: randomBytes(16).toString("hex"),
    ordinal: 0,
    expected_hash: recipe.recipe_hash,
    recipe,
  };
  await owner.bridge.recordIntent(owner.journal, intent);
  owner.check();
  p.state.check();
  const final = await executable(recipe.executable);
  owner.check();
  p.state.check();
  if (
    !same(current.stat, final.stat) ||
    final.hash !== current.hash ||
    Date.now() >= Date.parse(recipe.deadline) ||
    p.controller.signal.aborted
  )
    unavailable();
  p.used = true;
  activeChild = true;
  let observed: Awaited<ReturnType<typeof collect>["result"]>;
  try {
    // No await between the last latest-start/owner checks and this sole fixed spawn.
    const child = spawn(recipe.executable, [...TEST_ARGV], {
        cwd: recipe.cwd,
        env: { ...recipe.environment },
        shell: false,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      capture = collect(child, 30000, 262144, p.controller.signal);
    p.clearOutput = capture.clear;
    observed = await capture.result;
    p.output = observed.text;
  } catch {
    observed = {
      spawned: false,
      ended: false,
      complete: false,
      code: null,
      signal: null,
      cancelling: p.controller.signal.aborted,
      timeout: false,
      overflow: false,
      digest: createHash("sha256").digest("hex"),
      text: () => "",
    };
  } finally {
    activeChild = false;
    // Cleanup cannot delay or replace the already-observed process receipt.
    void cleanupPrepared(p);
  }
  const changed = !p.state.observe(),
    unconfirmed = observed.spawned && !observed.ended;
  if (unconfirmed) terminationUnconfirmed = true;
  const status: CodeTestReceipt["status"] = unconfirmed
    ? "termination_unconfirmed"
    : !observed.spawned
      ? observed.cancelling
        ? "cancelled"
        : "unknown"
      : !observed.ended
        ? "unknown"
        : changed
          ? "changed_during_test"
          : observed.cancelling
            ? "cancelled"
            : observed.timeout || observed.overflow
              ? "failed"
              : !observed.complete ||
                  observed.signal !== null ||
                  observed.code === null
                ? "unknown"
                : observed.code === 0
                  ? "passed"
                  : "failed";
  const receipt: CodeTestReceipt = {
    binding: intent.binding,
    scope: "code.test",
    operation_id: intent.operation_id,
    effect_id: intent.effect_id,
    ordinal: 0,
    expected_hash: recipe.recipe_hash,
    status,
    environment_hash: journalHash(recipe.environment),
    executable_hash: recipe.executable_hash,
    executable_version: recipe.executable_version,
    exit_code: observed.code,
    signal: observed.signal,
    cancel_requested: observed.cancelling,
    timeout: observed.timeout,
    overflow: observed.overflow,
    output_digest: observed.digest,
  };
  // Late observations settle this existing intent; they never renew permission or reconnect.
  await owner.bridge.recordObserved(owner.journal, receipt);
  return receipt;
}
export class KnownResultOpener {
  constructor(
    private readonly openFileUri: (uri: vscode.Uri) => Thenable<boolean>,
  ) {}
  async openKnownResult(
    context: CodeContext,
    target: FocusName,
    kind: "editor" | "browser",
  ): Promise<void> {
    if (
      !FOCUS_NAMES.includes(target) ||
      (kind !== "editor" && kind !== "browser") ||
      (kind === "browser" && target !== "index.html")
    )
      unavailable();
    const state = await focusTestState(context);
    state.check();
    const uri = vscode.Uri.file(join(state.root, target));
    if (kind === "browser") {
      if (!(await this.openFileUri(uri)))
        throw Error("External handoff request failed");
    } else {
      const document = await vscode.workspace.openTextDocument(uri);
      state.check();
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }
}
const knownOpener = new KnownResultOpener((uri) =>
  vscode.env.openExternal(uri),
);
export const openKnownResult = knownOpener.openKnownResult.bind(knownOpener);
