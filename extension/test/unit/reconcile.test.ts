import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  symlink,
  link,
  lstat,
} from "node:fs/promises";
import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import corpus from "../../../tests/fixtures/coding-contracts.json";
import {
  parseCodeJobView,
  parseCodeReceipt,
} from "../../../desktop/shared/coding-contracts";
import {
  rootIdentity,
  type PairView,
} from "../../../desktop/shared/editor-bridge";
import { EffectJournal } from "../../src/journal";
import {
  inspectInterruptedJob,
  inspectionText,
  InspectionView,
} from "../../src/reconcile";
const ui = vi.hoisted(() => ({
  documents: [] as unknown[],
  providers: new Map<string, (uri: { toString(): string }) => string>(),
  reads: [] as string[],
  open: undefined as (() => Promise<void>) | undefined,
  show: undefined as (() => Promise<void>) | undefined,
  shown: [] as string[],
  closed: [] as string[],
  tabs: [] as unknown[],
  native: "native",
  probe: undefined as (() => void) | undefined,
}));
vi.mock("../../src/root-probe", () => ({
  validateRootSpelling: () => {},
  probeRoot: async () => {
    ui.probe?.();
    return ui.native;
  },
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      ui.reads.push(String(args[0]));
      return fs.open(...args);
    },
  };
});
vi.mock("vscode", () => {
  class TextInput {
    constructor(readonly uri: { toString(): string }) {}
  }
  return {
    Uri: {
      file: (path: string) => ({
        toString: () =>
          pathToFileURL(path).href.replaceAll(
            ":",
            (match: string, offset: number) => (offset > 5 ? "%3A" : match),
          ),
      }),
      parse: (value: string) => ({
        toString: () => value,
        fsPath: value.startsWith("file:") ? fileURLToPath(value) : value,
      }),
    },
    EndOfLine: { LF: 1 },
    TabInputText: TextInput,
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    workspace: {
      get textDocuments() {
        return ui.documents;
      },
      registerTextDocumentContentProvider: (
        scheme: string,
        provider: {
          provideTextDocumentContent: (uri: { toString(): string }) => string;
        },
      ) => {
        ui.providers.set(scheme, provider.provideTextDocumentContent);
        return {
          dispose() {
            ui.providers.delete(scheme);
          },
        };
      },
      openTextDocument: async (uri: { toString(): string }) => {
        await ui.open?.();
        return { uri };
      },
    },
    window: {
      showTextDocument: async (document: { uri: { toString(): string } }) => {
        await ui.show?.();
        ui.shown.push(document.uri.toString());
        ui.tabs.push({ input: new TextInput(document.uri) });
      },
      tabGroups: {
        get all() {
          return [{ tabs: ui.tabs }];
        },
        onDidChangeTabs: () => ({ dispose() {} }),
        close: async (tabs: { input: TextInput }[]) => {
          for (const tab of tabs) {
            ui.closed.push(tab.input.uri.toString());
            ui.tabs = ui.tabs.filter((item) => item !== tab);
          }
          return true;
        },
      },
    },
  };
});
const roots: string[] = [];
const views: InspectionView[] = [];
afterEach(async () => {
  views.splice(0).forEach((view) => view.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
  ui.documents = [];
  ui.reads = [];
  ui.open = ui.show = undefined;
  ui.shown = [];
  ui.closed = [];
  ui.tabs = [];
  ui.native = "native";
  ui.probe = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function positions(text: string) {
  return {
    positionAt(offset: number) {
      const lines = text
        .slice(0, Math.max(0, Math.min(offset, text.length)))
        .split("\n");
      return { line: lines.length - 1, character: lines.at(-1)!.length };
    },
    offsetAt(position: { line: number; character: number }) {
      const lines = text.split("\n");
      return (
        lines
          .slice(0, position.line)
          .reduce((offset, line) => offset + line.length + 1, 0) +
        position.character
      );
    },
  };
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
async function fixture(prefix = "sage-inspection-") {
  const root = await realpath(await mkdtemp("/private/tmp/" + prefix));
  roots.push(root);
  const storage = await realpath(
    await mkdtemp("/private/tmp/sage-inspection-journal-"),
  );
  roots.push(storage);
  const info = lstatSync(root, { bigint: true });
  const workspace = {
    root_uri: pathToFileURL(root).href,
    root_file_id: `${info.dev}-${info.ino}`,
    window_id: "fresh-window",
  };
  const pair: PairView = {
    ...workspace,
    host_boot_id: "fresh-boot",
    pair_id: "fresh-pair",
    root_id: rootIdentity(workspace),
    status: "paired",
    challenge: "challenge",
  };
  const sample = corpus.cases.find(
    (item) => item.kind === "job_view" && item.valid,
  )!;
  const job = parseCodeJobView({
    ...sample.value,
    binding: {
      job_id: "old-job",
      boot_id: "old-boot",
      pair_id: "old-pair",
      window_id: "old-window",
      root_id: pair.root_id,
      revision: 1,
      policy_version: "code-v1",
    },
    state: "interrupted",
    receipts: [],
    hashes: ["index.html", "focus.js", "focus.test.mjs", "README.md"].map(
      (name) => ({
        name,
        source_hash: null,
        proposed_hash: digest(name === "index.html" ? "proposed\n" : name),
        observed_hash: null,
      }),
    ),
  });
  let valid = true;
  const owner = {
    pair,
    rawRootUri: workspace.root_uri,
    nativeIdentity: "native",
    extensionPath: storage,
    storagePath: storage,
    journal: new EffectJournal(pathToFileURL(storage)),
    guard() {
      if (!valid) throw Error("pair lost");
    },
  };
  return {
    root,
    storage,
    job,
    owner,
    invalidate() {
      valid = false;
    },
  };
}
it("hashes only evidenced exact files and existing dirty buffers independently without opening source documents", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "index.html"), "proposed\n");
  const path = pathToFileURL(join(f.root, "index.html")).href;
  let unrelatedReads = 0;
  ui.documents = [
    {
      uri: { toString: () => "file:///unrelated/human" },
      getText() {
        unrelatedReads++;
        throw Error("unrelated");
      },
    },
    {
      uri: { toString: () => path },
      version: 9,
      isDirty: true,
      isClosed: false,
      eol: 1,
      ...positions("human unsaved\n"),
      getText: () => "human unsaved\n",
    },
  ];
  const before = await lstat(join(f.root, "index.html"));
  const result = await inspectInterruptedJob(f.job, f.owner);
  expect(result.root).toBe("verified");
  expect(result.targets[0]).toMatchObject({
    name: "index.html",
    disk: {
      status: "observed",
      hash: digest("proposed\n"),
      matches: ["proposed"],
    },
    buffer: {
      status: "observed",
      hash: digest("human unsaved\n"),
      matches: [],
      version: 9,
      dirty: true,
    },
  });
  expect(result.targets[1].disk.status).toBe("missing");
  expect(inspectionText(result)).toContain(
    "Observed proposed content; completion receipt missing.",
  );
  expect(inspectionText(result)).toContain("Test outcome: unknown");
  expect(JSON.stringify(result)).not.toContain("human unsaved");
  expect(JSON.stringify(result)).not.toContain("proposed\\n");
  expect(unrelatedReads).toBe(0);
  expect(ui.shown).toEqual([]);
  expect((await lstat(join(f.root, "index.html"))).mtimeMs).toBe(
    before.mtimeMs,
  );
});
it.each(["wrong-root", "native", "dead-pair"])(
  "%s leaves historical metadata unverified with zero project target reads",
  async (fault) => {
    const f = await fixture();
    if (fault === "wrong-root")
      f.job = { ...f.job, binding: { ...f.job.binding, root_id: "other" } };
    if (fault === "native") ui.native = "changed-native";
    if (fault === "dead-pair") f.invalidate();
    const result = await inspectInterruptedJob(f.job, f.owner);
    expect(result.root).toBe("unverified");
    expect(result.targets).toEqual([]);
    expect(ui.reads.filter((path) => path.startsWith(f.root + "/"))).toEqual(
      [],
    );
  },
);
it("creation manifest alone never causes a project scan or guessed target read", async () => {
  const f = await fixture();
  const result = await inspectInterruptedJob({ ...f.job, hashes: [] }, f.owner);
  expect(result.root).toBe("verified");
  expect(result.targets).toEqual([]);
  expect(inspectionText(result)).toContain("No retained target hash evidence");
  expect(ui.reads.filter((path) => path.startsWith(f.root + "/"))).toEqual([]);
});
it.each(["symlink", "hardlink", "oversize"])(
  "%s target is unavailable and human files are preserved",
  async (kind) => {
    const f = await fixture();
    const human = join(f.storage, "human");
    await writeFile(human, "human");
    if (kind === "symlink") await symlink(human, join(f.root, "index.html"));
    if (kind === "hardlink") await link(human, join(f.root, "index.html"));
    if (kind === "oversize")
      await writeFile(join(f.root, "index.html"), "x".repeat(128001));
    const result = await inspectInterruptedJob(f.job, f.owner);
    expect(result.targets[0].disk.status).toBe("unavailable");
    expect((await lstat(human)).size).toBe(5);
  },
);
it("local lost-first observation stays separate and coincident original/proposed hashes retain all matches", async () => {
  const f = await fixture();
  const job = parseCodeJobView({
    ...f.job,
    mode: "replace_focus_file",
    target: "index.html",
    file_count: 1,
    manifest: ["index.html"],
    hashes: [
      {
        name: "index.html",
        source_hash: digest("proposed\n"),
        proposed_hash: digest("proposed\n"),
        observed_hash: digest("proposed\n"),
      },
    ],
  });
  await f.owner.journal.intent({
    binding: job.binding,
    scope: "code.replace",
    operation_id: "local-only",
    effect_id: "effect",
    ordinal: 0,
    target: "index.html",
    expected_hash: digest("proposed\n"),
  });
  await writeFile(join(f.root, "index.html"), "proposed\n");
  const result = await inspectInterruptedJob(job, f.owner);
  expect(result.targets[0].disk).toMatchObject({
    matches: ["original", "proposed", "recorded observation"],
  });
  expect(inspectionText(result)).toContain(
    "local observation missing; Core observation missing",
  );
  expect(inspectionText(result)).toContain(
    "Observed proposed content; completion receipt missing.",
  );
});
it.each(["\ufefftext", "CRLF\r\n", "\ud800"])(
  "unsupported logical buffer stays unavailable independently of raw disk",
  async (text) => {
    const f = await fixture();
    await writeFile(join(f.root, "index.html"), text);
    ui.documents = [
      {
        uri: { toString: () => pathToFileURL(join(f.root, "index.html")).href },
        version: 1,
        isDirty: true,
        isClosed: false,
        eol: 1,
        ...positions(text),
        getText: () => text,
      },
    ];
    const result = await inspectInterruptedJob(f.job, f.owner);
    expect(result.targets[0].disk.status).toBe("observed");
    expect(result.targets[0].buffer.status).toBe("unavailable");
  },
);
it("independent fixed view closes only its slot and delayed display cannot revive dismissed metadata", async () => {
  const f = await fixture(),
    result = await inspectInterruptedJob(f.job, f.owner);
  const view = new InspectionView();
  views.push(view);
  const current = { toString: () => "sage-diff:/original/proposed/focus.js" };
  const vscode = await import("vscode");
  ui.tabs.push({
    input: new vscode.TabInputText(current as unknown as import("vscode").Uri),
  });
  ui.providers.set("sage-diff", () => "original review source");
  await view.show(result, f.owner.guard);
  await view.clear();
  expect(ui.closed).toEqual(["sage-inspection:/interrupted-job.txt"]);
  expect(ui.providers.get("sage-diff")!(current)).toBe(
    "original review source",
  );
  let resume!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  ui.show = () => {
    entered();
    return new Promise<void>((resolve) => {
      resume = resolve;
    });
  };
  const showing = view.show(result, f.owner.guard);
  const rejected = expect(showing).rejects.toThrow();
  await ready;
  await view.clear();
  resume();
  await rejected;
  expect(
    ui.providers.get("sage-inspection")!({
      toString: () => "sage-inspection:/interrupted-job.txt",
    }),
  ).toBe("Inspection dismissed or expired.");
  expect(ui.tabs).toHaveLength(1);
});

it("observes an exact already-open VS Code URI in a colon-named root without rewriting Node root identity", async () => {
  const f = await fixture("sage-inspection:encoded-");
  await writeFile(join(f.root, "index.html"), "proposed\n");
  const raw = pathToFileURL(f.root).href.replace(
    /sage-inspection:/,
    "sage-inspection%3A",
  );
  f.owner.rawRootUri = raw;
  const bufferUri = raw + "/index.html";
  ui.documents = [
    {
      uri: { toString: () => bufferUri },
      version: 2,
      isDirty: true,
      isClosed: false,
      eol: 1,
      ...positions("human\n"),
      getText: () => "human\n",
    },
  ];
  const result = await inspectInterruptedJob(f.job, f.owner);
  expect(result.root).toBe("verified");
  expect(result.targets[0].buffer).toMatchObject({
    status: "observed",
    hash: digest("human\n"),
    dirty: true,
    version: 2,
  });
});

it("a Core receipt conflicting with a local intent stays conflicting even when the local observation is missing", async () => {
  const f = await fixture();
  const intent = {
    binding: f.job.binding,
    scope: "code.create" as const,
    operation_id: "op",
    effect_id: "effect",
    ordinal: 0,
    target: "index.html" as const,
    expected_hash: digest("proposed\n"),
  };
  await f.owner.journal.intent(intent);
  const receipt = parseCodeReceipt({
    ...intent,
    expected_hash: digest("different"),
    status: "partial",
    observed_hash: null,
    observed_length: null,
  });
  const result = await inspectInterruptedJob(
    { ...f.job, receipts: [receipt] },
    f.owner,
  );
  expect(inspectionText(result)).toContain(
    "conflicting intent/receipt identity",
  );
});
it.each(["matched", "conflicting"])(
  "compares %s local/Core receipts without manufacturing acknowledgments",
  async (kind) => {
    const f = await fixture();
    const intent = {
      binding: f.job.binding,
      scope: "code.create" as const,
      operation_id: "op",
      effect_id: "effect",
      ordinal: 0,
      target: "index.html" as const,
      expected_hash: digest("proposed\n"),
    };
    await f.owner.journal.intent(intent);
    const receipt = parseCodeReceipt({
      ...intent,
      status: "created",
      observed_hash: intent.expected_hash,
      observed_length: 9,
    });
    await f.owner.journal.observed(receipt);
    await writeFile(join(f.root, "index.html"), "proposed\n");
    const core =
      kind === "matched"
        ? receipt
        : parseCodeReceipt({ ...receipt, observed_hash: digest("other") });
    const result = await inspectInterruptedJob(
      { ...f.job, receipts: [core] },
      f.owner,
    );
    expect(inspectionText(result)).toContain(
      kind === "matched" ? "matching observations" : "conflicting observations",
    );
    if (kind === "matched")
      expect(inspectionText(result)).not.toContain(
        "completion receipt missing",
      );
    else expect(inspectionText(result)).toContain("completion receipt missing");
  },
);
it.each(["closed", "eol", "oversize", "version", "removed", "dirty"])(
  "a %s logical buffer is unavailable and preserved",
  async (fault) => {
    const f = await fixture();
    await writeFile(join(f.root, "index.html"), "proposed\n");
    const document = {
      uri: { toString: () => pathToFileURL(join(f.root, "index.html")).href },
      version: 1,
      isDirty: false,
      isClosed: fault === "closed",
      eol: fault === "eol" ? 2 : 1,
      ...positions(fault === "oversize" ? "a".repeat(32001) : "proposed\n"),
      getText() {
        if (fault === "version") document.version++;
        if (fault === "removed") ui.documents = [];
        if (fault === "dirty") document.isDirty = true;
        return fault === "oversize" ? "a".repeat(32001) : "proposed\n";
      },
    };
    ui.documents = [document];
    const result = await inspectInterruptedJob(f.job, f.owner);
    expect(result.targets[0].buffer.status).toBe("unavailable");
    expect(result.targets[0].disk.status).toBe("observed");
  },
);
it.each(["pair-loss", "clock-rollback", "deadline", "final-native"])(
  "%s invalidates current observations after an awaited probe",
  async (fault) => {
    const f = await fixture();
    let probes = 0;
    const now = Date.now();
    ui.probe = () => {
      probes++;
      if (fault === "pair-loss") f.invalidate();
      if (fault === "clock-rollback")
        vi.spyOn(Date, "now").mockReturnValue(now - 1);
      if (fault === "deadline")
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30000);
      if (fault === "final-native" && probes === 2) ui.native = "changed";
    };
    const result = await inspectInterruptedJob(f.job, f.owner);
    expect(result.root).toBe("unverified");
    expect(result.targets).toEqual([]);
  },
);
it("opaque pending view gives compatible-version guidance without claiming source-free contents", async () => {
  const { pendingText } = await import("../../src/reconcile");
  const text = pendingText({
    name: "pending-" + "a".repeat(32),
    classification: "unsafe",
    digest: null,
    mtime: null,
    identity: null,
  });
  expect(text).toContain("not validated source-free metadata");
  expect(text).toContain("compatible extension version");
});

it("original display deadline clears the fixed view without closing a human tab", async () => {
  const f = await fixture(),
    result = await inspectInterruptedJob(f.job, f.owner);
  const view = new InspectionView();
  views.push(view);
  await view.show(result, f.owner.guard);
  vi.useFakeTimers();
  // A second display starts one fresh result lease; advancing never renews that lease.
  await view.show(result, f.owner.guard);
  await vi.advanceTimersByTimeAsync(1800000);
  expect(
    ui.providers.get("sage-inspection")!({
      toString: () => "sage-inspection:/interrupted-job.txt",
    }),
  ).toBe("Inspection dismissed or expired.");
  expect(ui.tabs).toEqual([]);
  vi.useRealTimers();
});
it("a source-free display that expires during document-open never reaches showTextDocument", async () => {
  const f = await fixture(),
    result = await inspectInterruptedJob(f.job, f.owner),
    view = new InspectionView();
  views.push(view);
  ui.open = async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1800000);
  };
  await expect(view.show(result, f.owner.guard)).rejects.toThrow();
  expect(ui.shown).toEqual([]);
  expect(
    ui.providers.get("sage-inspection")!({
      toString: () => "sage-inspection:/another.txt",
    }),
  ).toBe("Inspection unavailable.");
});
it("raw folder URI with an unpaired query stays metadata-only", async () => {
  const f = await fixture();
  f.owner.rawRootUri += "?other";
  const result = await inspectInterruptedJob(f.job, f.owner);
  expect(result.root).toBe("unverified");
  expect(result.targets).toEqual([]);
  expect(ui.reads).toEqual([]);
});

it.each(["bom", "utf16"])(
  "%s raw disk encoding remains independent of strict visible logical buffer text",
  async (encoding) => {
    const f = await fixture();
    const raw =
      encoding === "bom"
        ? Buffer.from("\ufeffproposed\n", "utf8")
        : Buffer.from("proposed\n", "utf16le");
    await writeFile(join(f.root, "index.html"), raw);
    const before = await lstat(join(f.root, "index.html"));
    const document = {
      uri: { toString: () => pathToFileURL(join(f.root, "index.html")).href },
      version: 4,
      isClosed: false,
      isDirty: true,
      eol: 1,
      ...positions("proposed\n"),
      getText: () => "proposed\n",
    };
    ui.documents = [document];
    const result = await inspectInterruptedJob(f.job, f.owner);
    expect(result.targets[0].disk).toMatchObject({
      status: "observed",
      hash: createHash("sha256").update(raw).digest("hex"),
      matches: [],
    });
    expect(result.targets[0].buffer).toMatchObject({
      status: "observed",
      hash: digest("proposed\n"),
      dirty: true,
      version: 4,
      matches: ["proposed"],
    });
    expect(inspectionText(result)).toContain(
      "actual editor encoding/BOM unverified",
    );
    expect((await lstat(join(f.root, "index.html"))).mtimeMs).toBe(
      before.mtimeMs,
    );
    expect(document.isDirty).toBe(true);
    expect(document.version).toBe(4);
  },
);
it("valid pending summary exposes bounded receipt facts and original expiry without raw bytes", async () => {
  const f = await fixture();
  await f.owner.journal.intent({
    binding: f.job.binding,
    scope: "code.create",
    operation_id: "pending-op",
    effect_id: "pending-effect",
    ordinal: 0,
    target: "index.html",
    expected_hash: digest("proposed\n"),
  });
  const fs = await import("node:fs/promises");
  await fs.rename(
    join(f.storage, "operation-pending-op.json"),
    join(f.storage, "pending-" + "c".repeat(32)),
  );
  const entry = (await f.owner.journal.inspectPending()).entries[0];
  const { pendingText } = await import("../../src/reconcile");
  expect(entry.classification).toBe("supported_v1");
  expect(pendingText(entry)).toContain(
    "Validated version1 source-free metadata",
  );
  expect(pendingText(entry)).toContain("local observation missing");
  expect(pendingText(entry)).toContain(entry.operation!.expires_at);
  expect(pendingText(entry)).not.toContain("proposed\n");
});

it.each(["missing-hash", "missing-length", "conflicting-hash"])(
  "a %s completion receipt never suppresses current proposed-content uncertainty",
  async (fault) => {
    const f = await fixture();
    await writeFile(join(f.root, "index.html"), "proposed\n");
    const receipt = parseCodeReceipt({
      binding: f.job.binding,
      scope: "code.create",
      operation_id: "op",
      effect_id: "effect",
      ordinal: 0,
      target: "index.html",
      expected_hash: digest("proposed\n"),
      status: "created",
      observed_hash:
        fault === "missing-hash"
          ? null
          : fault === "conflicting-hash"
            ? digest("other")
            : digest("proposed\n"),
      observed_length: fault === "missing-length" ? null : 9,
    });
    const result = await inspectInterruptedJob(
      { ...f.job, receipts: [receipt] },
      f.owner,
    );
    expect(inspectionText(result)).toContain(
      "Observed proposed content; completion receipt missing.",
    );
  },
);

it("an incomplete recorded test receipt explicitly remains unknown", async () => {
  const f = await fixture();
  const receipt = parseCodeReceipt({
    binding: f.job.binding,
    scope: "code.test",
    operation_id: "test-op",
    effect_id: "test-effect",
    ordinal: 0,
    expected_hash: "a".repeat(64),
    status: "passed",
    environment_hash: "b".repeat(64),
    executable_hash: "c".repeat(64),
    executable_version: "26.12.1",
    exit_code: 0,
    signal: null,
    cancel_requested: false,
    timeout: false,
    overflow: false,
    output_digest: null,
  });
  const result = await inspectInterruptedJob(
    { ...f.job, receipts: [receipt] },
    f.owner,
  );
  expect(inspectionText(result)).toContain("Test outcome: unknown;");
});

it("oversized open-buffer metadata refuses before copying any logical source", async () => {
  const f = await fixture();
  const getText = vi.fn(() => "proposed\n");
  ui.documents = [
    {
      uri: { toString: () => pathToFileURL(join(f.root, "index.html")).href },
      version: 1,
      isDirty: true,
      isClosed: false,
      eol: 1,
      positionAt: (offset: number) => ({ line: 0, character: offset }),
      offsetAt: (position: { character: number }) => position.character,
      getText,
    },
  ];
  const result = await inspectInterruptedJob(f.job, f.owner);
  expect(getText).not.toHaveBeenCalled();
  expect(result.targets[0].buffer.status).toBe("unavailable");
});

it("the bounded metadata preflight permits exactly 32000 astral logical code points", async () => {
  const f = await fixture(),
    text = "😀".repeat(32000);
  ui.documents = [
    {
      uri: { toString: () => pathToFileURL(join(f.root, "index.html")).href },
      version: 3,
      isDirty: true,
      isClosed: false,
      eol: 1,
      ...positions(text),
      getText: () => text,
    },
  ];
  const result = await inspectInterruptedJob(f.job, f.owner);
  expect(result.targets[0].buffer).toMatchObject({
    status: "observed",
    length: 128000,
    hash: digest(text),
    version: 3,
    dirty: true,
  });
});
