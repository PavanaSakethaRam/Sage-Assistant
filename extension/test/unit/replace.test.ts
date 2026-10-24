import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  proposalHash,
  type CodeProposal,
  type CodeIntent,
  type CodeReceipt,
} from "../../../desktop/shared/coding-contracts";
import { rootIdentity } from "../../../desktop/shared/editor-bridge";
import {
  captureContext,
  contextOffer,
  releaseContext,
} from "../../src/context";
import * as reviewModule from "../../src/review";
import { ProposalReview } from "../../src/review";

type TestDocument = {
  uri: { toString(): string; fsPath: string; scheme: string };
  version: number;
  isDirty: boolean;
  isClosed: boolean;
  encoding: string;
  eol: number;
  text: string;
  getText(): string;
  positionAt(offset: number): { line: number; character: number };
  save(): Promise<boolean>;
};
const ui = vi.hoisted(() => ({
  choices: [] as (string | undefined)[],
  diffUris: [] as string[],
  diffs: [] as { left: string; right: string; title: string }[],
  providers: new Map<string, (uri: { toString(): string }) => string>(),
  confirm: true,
  beforeConfirm: undefined as (() => Promise<void>) | undefined,
  afterDiff: undefined as (() => void) | undefined,
  controls: [] as string[],
  documents: [] as TestDocument[],
  beforeEdit: undefined as (() => void) | undefined,
  afterEdit: undefined as (() => Promise<void>) | undefined,
  duringSave: undefined as (() => Promise<void>) | undefined,
  autoSave: "off",
  saveResult: true,
  editResult: true,
  edits: 0,
  saves: 0,
}));
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
    Range: class {
      constructor(...args: unknown[]) {
        void args;
      }
    },
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
      getConfiguration: () => ({ get: () => ui.autoSave }),
      openTextDocument: async (u: {
        toString(): string;
        fsPath: string;
        scheme: string;
      }) => {
        const existing = ui.documents.find(
          (d) => d.uri.toString() === u.toString(),
        );
        if (existing) return existing;
        const doc = {
          uri: u,
          version: 1,
          isDirty: false,
          isClosed: false,
          encoding: "utf8",
          eol: 1,
          text: await readFile(u.fsPath, "utf8"),
          getText() {
            return this.text;
          },
          positionAt: (offset: number) => ({ line: 0, character: offset }),
          async save() {
            ui.saves++;
            await ui.duringSave?.();
            if (ui.saveResult) {
              await writeFile(u.fsPath, this.text);
              this.isDirty = false;
            }
            return ui.saveResult;
          },
        };
        ui.documents.push(doc);
        return doc;
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
      showTextDocument: async (document: TestDocument) => ({
        document,
        edit: async (
          callback: (builder: {
            replace(range: unknown, text: string): void;
          }) => void,
        ) => {
          ui.edits++;
          ui.beforeEdit?.();
          let replacement: string | undefined;
          callback({
            replace: (_range: unknown, text: string) => {
              replacement = text;
            },
          });
          if (!ui.editResult) return false;
          if (replacement !== undefined) {
            document.text = replacement;
            document.version++;
            document.isDirty = true;
          }
          await ui.afterEdit?.();
          return replacement !== undefined;
        },
      }),
      tabGroups: { all: [], close: async () => true },
      showInformationMessage: async () => "Continue review",
      showWarningMessage: async () => {
        await ui.beforeConfirm?.();
        return ui.confirm ? "Apply and save this file" : undefined;
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
  ui.beforeEdit = ui.afterEdit = ui.duringSave = undefined;
  ui.autoSave = "off";
  ui.saveResult = true;
  ui.editResult = true;
  ui.edits = ui.saves = 0;
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { force: true, recursive: true })),
  );
});
async function fixture(additional = false, ageMs = 0) {
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
  await writeFile(join(root, "focus.js"), "// human baseline 😀\n");
  if (additional)
    await writeFile(join(root, "README.md"), "read only source\n");
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
    capturedAtMs: Date.now() - ageMs,
    rawRootUri: workspace.root_uri,
    nativeIdentity: "native",
    extensionPath: root,
    storagePath: root,
    mode: "replace_focus_file",
    target: "focus.js",
    names: additional ? ["focus.js", "README.md"] : ["focus.js"],
    diagnosticIds: [],
    guard: () => {
      if (!valid) throw Error("owner changed");
    },
  });
  const proposal: CodeProposal = {
    job_id: "job",
    revision: 1,
    explanation: "fixture",
    files: [
      {
        name: "focus.js",
        text: context.files[0].text + "// approved followup\n",
      },
    ],
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
          scope: "code.replace",
          operation_id: "operation",
          approved_hash: await proposalHash(proposal, context, "code.replace"),
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
    sourceText: context.files[0].text,
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
  ui.choices = ["Review focus.js", "Apply and save this file"];
}
it("human_followup_baseline_survives: literal diff and one saved replacement preserve fresh human text", async () => {
  const f = await fixture();
  approve();
  await f.review.show(f.context, f.proposal).catch(() => {});
  expect(await readFile(join(f.root, "focus.js"), "utf8")).toBe(
    f.proposal.files[0].text,
  );
  expect(ui.documents[0].getText()).toBe(f.proposal.files[0].text);
  expect(ui.diffs[0].left).toBe(f.sourceText);
  expect(f.receipts[0].status).toBe("applied_saved");
  expect(ui.edits).toBe(1);
  expect(ui.saves).toBe(1);
});
it.each(["dirty", "version", "closed", "autosave", "disk"])(
  "pre-effect %s change preserves human content with zero edits/save",
  async (mode) => {
    const f = await fixture();
    approve();
    ui.beforeConfirm = async () => {
      const doc = ui.documents[0];
      if (mode === "dirty") {
        doc.text += "// human\n";
        doc.isDirty = true;
        doc.version++;
      }
      if (mode === "version") doc.version += 2;
      if (mode === "closed") doc.isClosed = true;
      if (mode === "autosave") ui.autoSave = "afterDelay";
      if (mode === "disk")
        await writeFile(join(f.root, "focus.js"), "// external\n");
    };
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect(ui.edits).toBe(0);
    expect(ui.saves).toBe(0);
  },
);
it("stale_edit_during_callback_is_refused without saving or erasing human content", async () => {
  const f = await fixture();
  approve();
  ui.beforeEdit = () => {
    const d = ui.documents[0];
    d.text = "// human\n" + d.text;
    d.isDirty = true;
    d.version++;
  };
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(ui.documents[0].text).toBe("// human\n" + f.sourceText);
  expect(ui.saves).toBe(0);
  expect(f.receipts[0].status).toBe("needs_review");
  expect(
    (
      f
        .receipts[0] as import("../../../desktop/shared/coding-contracts").CodeFileReceipt
    ).observed_hash,
  ).toBe(f.context.files[0].disk_hash);
});
it.each(["human", "cancel", "disk"])(
  "after-edit %s prevents save and preserves buffer",
  async (mode) => {
    const f = await fixture();
    approve();
    ui.afterEdit = async () => {
      if (mode === "human") {
        ui.documents[0].text += "// human\n";
        ui.documents[0].version++;
      }
      if (mode === "cancel") f.invalidate();
      if (mode === "disk")
        await writeFile(join(f.root, "focus.js"), "// external\n");
    };
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect(ui.saves).toBe(0);
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0].status).toBe(
      mode === "cancel" ? "applied_unsaved" : "needs_review",
    );
  },
);
it("false save reserves applied_unsaved for approved dirty buffer and unchanged old disk", async () => {
  const f = await fixture();
  approve();
  ui.saveResult = false;
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(f.receipts[0].status).toBe("applied_unsaved");
  expect(
    (
      f
        .receipts[0] as import("../../../desktop/shared/coding-contracts").CodeFileReceipt
    ).observed_hash,
  ).toBe(f.context.files[0].disk_hash);
  expect(
    (
      f
        .receipts[0] as import("../../../desktop/shared/coding-contracts").CodeFileReceipt
    ).observed_length,
  ).toBe(Buffer.byteLength(f.sourceText));
  expect(ui.documents[0].isDirty).toBe(true);
  expect(ui.saves).toBe(1);
});
it("save_participant_changes_are_needs_review, including false save", async () => {
  const f = await fixture();
  approve();
  ui.saveResult = false;
  ui.duringSave = async () => {
    ui.documents[0].text += "// participant\n";
    ui.documents[0].version++;
  };
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(f.receipts[0].status).toBe("needs_review");
  expect(ui.saves).toBe(1);
});
it("cancel_during_save_records_observation after the only save settles", async () => {
  const f = await fixture();
  approve();
  ui.duringSave = async () => {
    f.invalidate();
  };
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(await readFile(join(f.root, "focus.js"), "utf8")).toBe(
    f.proposal.files[0].text,
  );
  expect(f.receipts).toHaveLength(1);
  expect(f.receipts[0].status).toBe("applied_saved");
  expect(ui.saves).toBe(1);
});
it.each([
  "false-edit",
  "throw-edit",
  "throw-save",
  "closed",
  "encoding",
  "eol",
  "human",
  "disk-bom",
  "disk-crlf",
  "identity",
  "lost-ack",
])("final observation %s is truthful and never retries", async (mode) => {
  const f = await fixture();
  approve();
  const doc = ui.documents[0];
  if (mode === "false-edit") ui.editResult = false;
  if (mode === "throw-edit")
    ui.beforeEdit = () => {
      throw Error("unknown edit");
    };
  if (mode === "throw-save")
    doc.save = async () => {
      ui.saves++;
      throw Error("unknown save");
    };
  if (mode === "lost-ack") f.loseObservation();
  ui.duringSave = async () => {
    if (mode === "closed") doc.isClosed = true;
    if (mode === "encoding") doc.encoding = "utf8bom";
    if (mode === "eol") doc.eol = 2;
    if (mode === "human") {
      doc.text += "// human pending\n";
      doc.version++;
    }
  };
  if (mode === "disk-bom" || mode === "disk-crlf")
    doc.save = async () => {
      ui.saves++;
      await writeFile(
        join(f.root, "focus.js"),
        mode === "disk-bom"
          ? "\ufeff" + doc.text
          : doc.text.replaceAll("\n", "\r\n"),
      );
      doc.isDirty = false;
      return true;
    };
  if (mode === "identity")
    doc.save = async () => {
      ui.saves++;
      const { unlink, symlink } = await import("node:fs/promises");
      await unlink(join(f.root, "focus.js"));
      await symlink("missing", join(f.root, "focus.js"));
      return true;
    };
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(f.receipts).toHaveLength(1);
  expect(ui.edits).toBe(1);
  expect(ui.saves).toBeLessThanOrEqual(1);
  const status = f.receipts[0].status;
  expect(status).toBe(
    mode === "closed" || mode === "identity" || mode === "throw-save"
      ? "needs_reconciliation"
      : mode === "lost-ack"
        ? "applied_saved"
        : "needs_review",
  );
});
it("closed/reopened instance constructor double refuses equal text and version", async () => {
  const f = await fixture();
  approve();
  ui.beforeConfirm = async () => {
    ui.documents[0] = { ...ui.documents[0] };
  };
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(ui.edits).toBe(0);
  expect(ui.saves).toBe(0);
});
it.each(["cancel", "expiry", "disconnect"])(
  "%s while diff open dispatches no intent or edit",
  async (mode) => {
    const f = await fixture();
    approve();
    ui.afterDiff = () => {
      if (mode === "expiry")
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1800000);
      else f.invalidate();
    };
    try {
      await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
      expect(f.intents).toEqual([]);
      expect(ui.edits).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  },
);
it("post-save safe ordinary replacement inode is observed as current without new write authority", async () => {
  const f = await fixture();
  approve();
  const doc = ui.documents[0];
  doc.save = async () => {
    ui.saves++;
    const { rename } = await import("node:fs/promises");
    await writeFile(join(f.root, ".owned-save"), doc.text);
    await rename(join(f.root, ".owned-save"), join(f.root, "focus.js"));
    doc.isDirty = false;
    return true;
  };
  await f.review.show(f.context, f.proposal);
  expect(f.receipts[0].status).toBe("applied_saved");
  expect(ui.saves).toBe(1);
});
it("an unknown thrown save result remains reconciliation even with unchanged old disk", async () => {
  const f = await fixture();
  approve();
  ui.documents[0].save = async () => {
    ui.saves++;
    throw Error("unknown outcome");
  };
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(f.receipts[0].status).toBe("needs_reconciliation");
  expect(ui.saves).toBe(1);
});
it("a human edit while observation ACK is pending prevents retained applied authority", async () => {
  const f = await fixture();
  approve();
  f.afterObserved(() => {
    ui.documents[0].text += "// ACK human\n";
    ui.documents[0].isDirty = true;
    ui.documents[0].version++;
  });
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(f.receipts).toHaveLength(1);
  expect(f.receipts[0].status).toBe("applied_saved");
  expect(ui.documents[0].text).toContain("// ACK human");
  expect(ui.saves).toBe(1);
});

it.each(["buffer", "disk"])(
  "selected read-only %s changes stop saving and require fresh review",
  async (mode) => {
    const f = await fixture(true);
    approve();
    ui.afterEdit = async () => {
      if (mode === "buffer") {
        ui.documents[1].text += "human";
        ui.documents[1].version++;
        ui.documents[1].isDirty = true;
      } else
        await writeFile(join(f.root, "README.md"), "human read-only disk\n");
    };
    await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
    expect(ui.saves).toBe(0);
    expect(f.receipts[0].status).toBe("needs_review");
  },
);
it("lost intent ACK never edits or invents an observation", async () => {
  const f = await fixture();
  approve();
  vi.spyOn(f.bridge, "recordIntent").mockRejectedValue(Error("lost ACK"));
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(ui.edits).toBe(0);
  expect(f.receipts).toEqual([]);
});
it("disk metadata drift after fresh intent ACK refuses the edit itself", async () => {
  const f = await fixture();
  approve();
  f.afterIntent(async () => {
    const { utimes } = await import("node:fs/promises");
    await utimes(join(f.root, "focus.js"), new Date(0), new Date(0));
  });
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(ui.edits).toBe(0);
  expect(ui.saves).toBe(0);
  expect(f.receipts[0].status).toBe("needs_review");
});
it("same approved text with additional versions before edit promise resumption never saves", async () => {
  const f = await fixture();
  approve();
  ui.afterEdit = async () => {
    ui.documents[0].version += 2;
  };
  await f.review.show(f.context, f.proposal).catch(() => {});
  expect(ui.saves).toBe(0);
  expect(f.receipts[0].status).toBe("needs_review");
});
it("false save plus same-text edit/undo is needs_review rather than applied_unsaved", async () => {
  const f = await fixture();
  approve();
  ui.saveResult = false;
  ui.duringSave = async () => {
    ui.documents[0].version += 2;
  };
  await expect(f.review.show(f.context, f.proposal)).rejects.toThrow();
  expect(f.receipts[0].status).toBe("needs_review");
  expect(ui.saves).toBe(1);
});

it("original lease expiry clears owned source capsules before an unresolved save settles", async () => {
  const f = await fixture();
  approve();
  let owner: ReturnType<typeof reviewModule.consumeLocalReview> | undefined,
    settle: (() => void) | undefined;
  const consume = reviewModule.consumeLocalReview;
  const spy = vi
    .spyOn(reviewModule, "consumeLocalReview")
    .mockImplementation((...args) => {
      owner = consume(...args);
      return owner;
    });
  ui.duringSave = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
    });
  const work = f.review.show(f.context, f.proposal).catch(() => {});
  await vi.waitFor(() => expect(settle).toBeDefined());
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1800001);
  try {
    expect(() => contextOffer(f.context)).toThrow();
    expect(() => owner!.context.files[0].text).toThrow(/expired source/i);
    expect(() => owner!.proposal.files[0].text).toThrow(/expired source/i);
    expect(() => owner!.proposal.explanation).toThrow(/expired source/i);
    expect(f.receipts).toHaveLength(0);
    expect(ui.saves).toBe(1);
  } finally {
    releaseContext(f.context);
    await f.review.dispose();
    settle!();
    await work;
    clock.mockRestore();
    spy.mockRestore();
  }
  expect(f.receipts).toHaveLength(1);
  expect(f.receipts[0].status).toBe("applied_saved");
  expect(
    f.sent.some((s) => (s as { kind: string }).kind === "journal.observed"),
  ).toBe(false);
});

it("original capture timer revokes source while native-save promise remains held", async () => {
  vi.useFakeTimers();
  const f = await fixture(false, 1799000);
  approve();
  let owner: ReturnType<typeof reviewModule.consumeLocalReview> | undefined,
    settle: (() => void) | undefined;
  const consume = reviewModule.consumeLocalReview;
  const spy = vi
    .spyOn(reviewModule, "consumeLocalReview")
    .mockImplementation((...args) => {
      owner = consume(...args);
      return owner;
    });
  ui.duringSave = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
    });
  const work = f.review.show(f.context, f.proposal).catch(() => {});
  await vi.waitFor(() => expect(settle).toBeDefined());
  await vi.advanceTimersByTimeAsync(1001);
  try {
    expect(() => owner!.context.files[0].text).toThrow(/expired source/i);
    expect(() => owner!.proposal.files[0].text).toThrow(/expired source/i);
    expect(() => owner!.proposal.explanation).toThrow(/expired source/i);
    for (const raw of ui.diffUris)
      expect(ui.providers.get("sage-diff")!({ toString: () => raw })).toBe(
        "Review expired or cancelled.",
      );
    expect(f.receipts).toHaveLength(0);
    expect(ui.saves).toBe(1);
  } finally {
    settle!();
    await work;
    spy.mockRestore();
  }
  expect(f.receipts).toHaveLength(1);
  expect(f.receipts[0].status).toBe("applied_saved");
  expect(
    f.sent.some((row) => (row as { kind: string }).kind === "journal.observed"),
  ).toBe(false);
});
