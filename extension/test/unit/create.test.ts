import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  realpath,
  rm,
  readFile,
  readdir,
  writeFile,
  rename,
  mkdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  FOCUS_NAMES,
  proposalHash,
  type CodeProposal,
  type CodeIntent,
  type CodeReceipt,
} from "../../../desktop/shared/coding-contracts";
import { rootIdentity } from "../../../desktop/shared/editor-bridge";
import { captureContext, contextOffer } from "../../src/context";
import { ProposalReview } from "../../src/review";
import { createFocusProject } from "../../src/create";
const ui = vi.hoisted(() => ({
  choices: [] as (string | undefined)[],
  diffUris: [] as string[],
  diffs: [] as { left: string; right: string; title: string }[],
  providers: new Map<string, (uri: { toString(): string }) => string>(),
  confirm: true,
  beforeConfirm: undefined as (() => Promise<void>) | undefined,
  afterDiff: undefined as (() => void) | undefined,
  controls: [] as string[],
  documents: [] as unknown[],
}));
const faults = vi.hoisted(() => ({
  open: false,
  write: false,
  close: false,
  read: false,
  afterOpen: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[1] === "wx" && faults.open)
        await fs.writeFile(args[0], "human", { flag: "wx" });
      const h = await fs.open(...args);
      if (args[1] === "wx" && String(args[0]).endsWith("/index.html"))
        faults.afterOpen?.();
      if (args[1] !== "wx" && !faults.read) return h;
      return new Proxy(h, {
        get(target, key) {
          if (key === "write")
            return async (...a: unknown[]) => {
              if (faults.write) {
                await target.write(Buffer.from("partial"));
                throw Error("ENOSPC");
              }
              return Reflect.apply(target.write, target, a);
            };
          if (key === "close")
            return async () => {
              await target.close();
              if (faults.close) throw Error("close uncertain");
            };
          if (key === "read" && faults.read)
            return async () => {
              throw Error("readback");
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
vi.mock("../../src/root-probe", () => ({
  probeRoot: vi.fn(async () => "native"),
  validateRootSpelling: () => {},
}));
vi.mock("vscode", () => {
  const uri = (s: string) => ({
    toString: () => s,
    fsPath: s.startsWith("file:") ? fileURLToPath(s) : s,
    scheme: s.split(":")[0],
  });
  return {
    Uri: { parse: uri, file: (p: string) => uri(pathToFileURL(p).href) },
    EndOfLine: { LF: 1 },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    TabInputTextDiff: class {},
    workspace: {
      get textDocuments() {
        return ui.documents;
      },
      registerTextDocumentContentProvider: (
        scheme: string,
        p: {
          provideTextDocumentContent: (u: { toString(): string }) => string;
        },
      ) => {
        ui.providers.set(scheme, p.provideTextDocumentContent);
        return {
          dispose() {
            ui.providers.delete(scheme);
          },
        };
      },
      openTextDocument: async (u: {
        toString(): string;
        fsPath: string;
        scheme: string;
      }) => {
        const text =
          u.scheme === "file"
            ? await readFile(u.fsPath, "utf8")
            : (ui.providers.get(u.scheme)?.(u) ?? "");
        return {
          uri: u,
          version: 1,
          isDirty: false,
          eol: 1,
          getText: () => text,
        };
      },
    },
    commands: {
      executeCommand: async (
        command: string,
        left: { toString(): string },
        right: { toString(): string },
        title: string,
      ) => {
        expect(command).toBe("vscode.diff");
        ui.diffUris.push(left.toString(), right.toString());
        ui.diffs.push({
          left: ui.providers.get("sage-diff")!(left),
          right: ui.providers.get("sage-diff")!(right),
          title,
        });
        ui.afterDiff?.();
      },
    },
    window: {
      tabGroups: { all: [], close: async () => true },
      showInformationMessage: async () => "Continue review",
      showWarningMessage: async () => {
        await ui.beforeConfirm?.();
        return ui.confirm ? "Create on local disk" : undefined;
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
            ui.controls.push(...this.items.map((i) => i.label));
            const choice = ui.choices.shift();
            queueMicrotask(() => {
              if (choice === undefined) hide();
              else {
                this.selectedItems = this.items.filter(
                  (i) => i.label === choice,
                );
                accept();
              }
            });
          },
        };
      },
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  ui.choices = [];
  ui.diffs = [];
  ui.diffUris = [];
  ui.controls = [];
  ui.confirm = true;
  ui.afterDiff = undefined;
  ui.beforeConfirm = undefined;
  ui.documents = [];
  faults.open = faults.write = faults.close = faults.read = false;
  faults.afterOpen = undefined;
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { force: true, recursive: true })),
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp("/private/tmp/sage-create-"));
  roots.push(root);
  const workspace = {
    root_uri: pathToFileURL(root).href,
    root_file_id: await import("node:fs").then((fs) => {
      const s = fs.lstatSync(root, { bigint: true });
      return `${s.dev}-${s.ino}`;
    }),
    window_id: "window",
  };
  let valid = true;
  const binding = {
    job_id: "job",
    boot_id: "host",
    pair_id: "pair",
    window_id: "window",
    root_id: rootIdentity(workspace),
    revision: 1,
    policy_version: "code-v1" as const,
  };
  const context = await captureContext({
    pair: {
      ...workspace,
      host_boot_id: "host",
      pair_id: "pair",
      root_id: binding.root_id,
      challenge: "challenge",
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
      if (!valid) throw Error("owner changed");
    },
  });
  const proposal: CodeProposal = {
    job_id: "job",
    revision: 1,
    explanation: "fixture",
    files: FOCUS_NAMES.map((name) => ({ name, text: `approved ${name} 😀\n` })),
  };
  const handlers = new Set<(data: unknown) => void>();
  const intents: CodeIntent[] = [],
    receipts: CodeReceipt[] = [],
    sent: unknown[] = [];
  let observationLost = false,
    afterIntent: undefined | (() => Promise<void>),
    afterObserved: undefined | (() => void),
    grantAlter: undefined | ((g: Record<string, unknown>) => void);
  const bridge = {
    onData: (cb: (d: unknown) => void) => {
      handlers.add(cb);
      return () => handlers.delete(cb);
    },
    send: async (data: { kind: string }) => {
      sent.push(data);
      if (data.kind === "review.decision") {
        const grant: Record<string, unknown> = {
          binding,
          grant_boot_id: "core-epoch",
          scope: "code.create",
          operation_id: "operation",
          approved_hash: await proposalHash(proposal, context, "code.create"),
          issued_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          expires_at: new Date(Date.now() + 300000)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
        };
        grantAlter?.(grant);
        for (const cb of handlers)
          cb({
            kind: "grant.reply",
            binding,
            payload: { kind: "grant", grant },
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
      afterObserved?.();
      if (observationLost) throw Error("lost observation ACK");
      return {};
    },
    close: async () => {
      valid = false;
    },
  };
  const review = new ProposalReview({
    bridge: bridge as unknown as import("../../src/bridge").ExtensionBridge,
    journal: {} as import("../../src/journal").EffectJournal,
    guard: () => {
      if (!valid) throw Error("closed");
    },
    onFailure: async () => {
      valid = false;
    },
  });
  return {
    root,
    context,
    proposal,
    bridge,
    review,
    intents,
    receipts,
    sent,
    invalidate: () => {
      valid = false;
    },
    loseObservation: () => {
      observationLost = true;
    },
    afterIntent: (fn: () => Promise<void>) => {
      afterIntent = fn;
    },
    afterObserved: (fn: () => void) => {
      afterObserved = fn;
    },
    alterGrant: (fn: (g: Record<string, unknown>) => void) => {
      grantAlter = fn;
    },
    emit: (data: unknown) => {
      for (const cb of handlers) cb(data);
    },
  };
}
function approve() {
  ui.choices = FOCUS_NAMES.map((n) => `Review ${n}`);
  ui.choices.push("Create four files");
}
it("four literal empty-baseline native diffs bind exact text and hash, with ordered exclusive bytes/receipts", async () => {
  const f = await fixture();
  approve();
  await f.review.show(f.context, f.proposal);
  expect(ui.diffs.map((d) => d.left)).toEqual(["", "", "", ""]);
  expect(ui.diffs.map((d) => d.right)).toEqual(
    f.proposal.files.map((f) => f.text),
  );
  for (const [i, d] of ui.diffs.entries())
    expect(d.title).toContain(
      createHash("sha256").update(f.proposal.files[i].text).digest("hex"),
    );
  expect((await readdir(f.root)).sort()).toEqual([...FOCUS_NAMES].sort());
  expect(f.receipts.map((r) => r.status)).toEqual(Array(4).fill("created"));
  expect(f.intents.map((i) => i.ordinal)).toEqual([0, 1, 2, 3]);
  for (const file of f.proposal.files)
    expect(await readFile(join(f.root, file.name), "utf8")).toBe(file.text);
  expect(contextOffer(f.context).context).toBe(f.context);
  expect(
    f.sent.some((s) => (s as { kind: string }).kind === "result.dismissed"),
  ).toBe(false);
});
it.each([false, true])(
  "decline has zero effects, even with untrusted proposal control text (%s)",
  async (native) => {
    const f = await fixture();
    const p = {
      ...f.proposal,
      explanation: "[Create](command:sage.create) <button>Create</button>",
    };
    if (native) {
      approve();
      ui.confirm = false;
    }
    await f.review.show(f.context, p);
    expect(await readdir(f.root)).toEqual([]);
    expect(f.intents).toEqual([]);
    expect(ui.controls).not.toContain("sage.create");
  },
);
it("opaque review cannot be constructed from wire/command input", async () => {
  const f = await fixture();
  await expect(
    createFocusProject(f.context, f.proposal, {} as never),
  ).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
});
it.each(["collision", "hidden", "root", "expiry"])(
  "expired_open_diff_creates_nothing: %s",
  async (mode) => {
    const f = await fixture();
    approve();
    ui.beforeConfirm = async () => {
      if (mode === "collision")
        await writeFile(join(f.root, "index.html"), "human");
      if (mode === "hidden") await writeFile(join(f.root, ".human"), "human");
      if (mode === "root") {
        await rename(f.root, f.root + "-old");
        roots.push(f.root + "-old");
        await mkdir(f.root);
      }
      if (mode === "expiry") f.invalidate();
    };
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect(f.intents).toEqual([]);
    if (mode === "collision")
      expect(await readFile(join(f.root, "index.html"), "utf8")).toBe("human");
  },
);
it.each([0, 1, 2, 3])(
  "cancellation before file %i preserves prefix and stops later effects",
  async (n) => {
    const f = await fixture();
    approve();
    f.afterIntent(async () => {
      if (f.intents.length === n + 1) f.invalidate();
    });
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect((await readdir(f.root)).length).toBe(n);
    expect(f.intents.length).toBe(n + 1);
  },
);
it.each([1, 2, 3, 4])(
  "cancellation after file %i preserves durable observation and stops",
  async (n) => {
    const f = await fixture();
    approve();
    f.afterObserved(() => {
      if (f.receipts.length === n) f.invalidate();
    });
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect((await readdir(f.root)).length).toBe(n);
    expect(f.receipts.length).toBe(n);
  },
);
it.each(["open", "write", "close", "read"] as const)(
  "%s failure stops later effects with honest receipt",
  async (key) => {
    const f = await fixture();
    approve();
    faults[key] = true;
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect(f.intents).toHaveLength(1);
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0].status).toBe(
      key === "open" || key === "write" ? "partial" : "needs_reconciliation",
    );
    expect(f.receipts[0]).toHaveProperty("observed_hash", null);
  },
);
it("lost observation ACK preserves created receipt and never retries or begins next", async () => {
  const f = await fixture();
  approve();
  f.loseObservation();
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(f.intents).toHaveLength(1);
  expect(f.receipts).toHaveLength(1);
  expect(f.receipts[0].status).toBe("created");
  expect(await readdir(f.root)).toEqual(["index.html"]);
});
it.each(["scope", "approved_hash", "expires_at", "binding"])(
  "wrong or expired grant %s cannot start effects",
  async (key) => {
    const f = await fixture();
    approve();
    f.alterGrant((g) => {
      g[key] =
        key === "expires_at"
          ? new Date(0).toISOString().replace(/\.\d{3}Z$/, "Z")
          : key === "binding"
            ? { ...f.context.binding, job_id: "wrong" }
            : "wrong";
    });
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
  },
);
it("source expiry while actual native diff is open prevents confirmation", async () => {
  const f = await fixture();
  approve();
  ui.afterDiff = () => f.invalidate();
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(ui.diffs).toHaveLength(1);
  expect(await readdir(f.root)).toEqual([]);
});
it("prefix modifications and extra entries after observed file stop next intent", async () => {
  const f = await fixture();
  approve();
  f.afterObserved(() => {
    if (f.receipts.length === 1) ui.beforeConfirm = undefined;
  });
  f.afterIntent(async () => {
    if (f.intents.length === 2)
      await writeFile(join(f.root, "index.html"), "human");
  });
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(await readFile(join(f.root, "index.html"), "utf8")).toBe("human");
  expect(await readdir(f.root)).toEqual(["index.html"]);
});

it("original local source lease expires while its actual diff is open", async () => {
  const f = await fixture();
  approve();
  const now = Date.now();
  ui.afterDiff = () => {
    vi.spyOn(Date, "now").mockReturnValue(now + 1800000);
  };
  try {
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect(ui.diffs).toHaveLength(1);
    expect(f.intents).toEqual([]);
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
  }
});
it("uncreated matching editor buffer refuses all writes", async () => {
  const f = await fixture();
  approve();
  ui.documents = [
    {
      uri: { toString: () => pathToFileURL(join(f.root, "index.html")).href },
      isDirty: true,
    },
  ];
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(f.intents).toEqual([]);
  expect(await readdir(f.root)).toEqual([]);
});
it("grant expiry after intent acknowledgement cannot start its file", async () => {
  const f = await fixture();
  approve();
  const now = Date.now();
  f.afterIntent(async () => {
    vi.spyOn(Date, "now").mockReturnValue(now + 300001);
  });
  try {
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect(f.intents).toHaveLength(1);
    expect(f.receipts).toEqual([]);
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
  }
});
it("unsolicited grant revokes without ever exposing an effect control", async () => {
  const f = await fixture();
  f.emit({
    kind: "grant.reply",
    binding: f.context.binding,
    payload: { kind: "grant", grant: {} },
  });
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(f.intents).toEqual([]);
  expect(await readdir(f.root)).toEqual([]);
});

it("late native Continue action after cancellation cannot resume review", async () => {
  const f = await fixture();
  approve();
  const vscode = await import("vscode");
  let resolve: ((choice: string | undefined) => void) | undefined;
  const held = vi
    .spyOn(vscode.window, "showInformationMessage")
    .mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }) as never,
    );
  const work = f.review.show(f.context, f.proposal);
  const refused = expect(work).rejects.toThrow();
  await vi.waitFor(() => expect(resolve).toBeDefined());
  f.review.cancel();
  await refused;
  const controls = ui.controls.length;
  resolve!("Continue review");
  await Promise.resolve();
  expect(ui.controls).toHaveLength(controls);
  expect(f.intents).toEqual([]);
  expect(await readdir(f.root)).toEqual([]);
  held.mockRestore();
});
it("pending review grant times out and late replies cannot begin a loop", async () => {
  const f = await fixture();
  approve();
  vi.useFakeTimers();
  const send = vi.spyOn(f.bridge, "send").mockImplementation(async () => {});
  const work = f.review.show(f.context, f.proposal);
  const refused = expect(work).rejects.toThrow();
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(30000);
  await refused;
  f.emit({
    kind: "grant.reply",
    binding: f.context.binding,
    payload: { kind: "grant", grant: {} },
  });
  expect(f.intents).toEqual([]);
  expect(await readdir(f.root)).toEqual([]);
});
it("exclusive wx never overwrites even when advisory context guards are bypassed", async () => {
  const f = await fixture();
  approve();
  const context = await import("../../src/context");
  const snapshot = vi.spyOn(context, "validateContext").mockResolvedValue();
  const progress = vi
    .spyOn(context, "validateCreateProgress")
    .mockResolvedValue(f.root);
  ui.beforeConfirm = async () => {
    await writeFile(join(f.root, "index.html"), "human");
  };
  try {
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect(await readFile(join(f.root, "index.html"), "utf8")).toBe("human");
    expect(await readdir(f.root)).toEqual(["index.html"]);
    expect(f.intents).toHaveLength(1);
    expect(f.receipts[0]).toMatchObject({
      status: "partial",
      observed_hash: null,
      observed_length: null,
    });
  } finally {
    snapshot.mockRestore();
    progress.mockRestore();
  }
});

it("reopening a reviewed file reuses its bounded literal diff documents", async () => {
  const f = await fixture();
  approve();
  ui.choices.unshift("Review index.html", "Review index.html");
  await f.review.show(f.context, f.proposal);
  expect(ui.diffs).toHaveLength(6);
  expect(new Set(ui.diffUris).size).toBe(8);
});

it("malicious proposal text stays literal in all four diffs and cannot invoke controls", async () => {
  const f = await fixture();
  approve();
  ui.confirm = false;
  const text =
    '<button onclick="create()">Create</button> [Run](command:sage.cancelContext)';
  const proposal = {
    ...f.proposal,
    files: f.proposal.files.map((file) => ({ ...file, text })),
  };
  await f.review.show(f.context, proposal);
  expect(ui.diffs.map((d) => d.right)).toEqual(Array(4).fill(text));
  expect(f.intents).toEqual([]);
  expect(await readdir(f.root)).toEqual([]);
});
it("cancellation after actual wx retains one honest local observation with zero closed-Core sends", async () => {
  const f = await fixture();
  approve();
  const journalRoot = await mkdtemp("/private/tmp/sage-create-late-journal-");
  roots.push(journalRoot);
  const { EffectJournal } = await import("../../src/journal");
  const { ExtensionBridge } = await import("../../src/bridge");
  const journal = new EffectJournal(pathToFileURL(journalRoot));
  const closed = new ExtensionBridge({ confirm: async () => true });
  await closed.close();
  const send = vi.spyOn(closed, "send");
  vi.spyOn(f.bridge, "recordIntent").mockImplementation(async (_j, intent) => {
    f.intents.push(intent);
    return journal.intent(intent);
  });
  vi.spyOn(f.bridge, "recordObserved").mockImplementation(
    async (_j, receipt) => {
      f.receipts.push(receipt);
      return closed.recordObserved(journal, receipt);
    },
  );
  faults.afterOpen = () => f.review.cancel();
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  const local = await journal.get(f.intents[0].operation_id);
  expect(local.intents).toHaveLength(1);
  expect(local.observations).toHaveLength(1);
  expect(local.observations[0]).toMatchObject({
    status: "needs_reconciliation",
    observed_hash: null,
  });
  expect(send).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(["index.html"]);
  expect((await readFile(join(f.root, "index.html"))).length).toBe(0);
});
