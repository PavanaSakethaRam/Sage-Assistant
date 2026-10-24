import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  link,
  symlink,
  rename,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { localWorkspace } from "../../src/bridge";
import {
  captureContext,
  validateContext,
  releaseContext,
  contextOffer,
  type ContextSelection,
} from "../../src/context";
import { rootIdentity } from "../../../desktop/shared/editor-bridge";
const editor = vi.hoisted(() => ({
  documents: new Map<string, unknown>(),
  encodeUris: false,
  version: 1,
  text: "",
  dirty: false,
  eol: 1,
  diagnosticReads: 0,
  diagnostics: [] as {
    message: string;
    range: { start: { line: number; character: number } };
  }[],
  opened: [] as string[],
  afterOpen: undefined as (() => void) | undefined,
  rootUri: "",
  commands: new Map<string, () => Promise<void>>(),
  choices: [] as (string[] | null)[],
  providers: new Map<
    string,
    { provideTextDocumentContent: (uri: { toString(): string }) => string }
  >(),
  tabs: [] as { input: unknown }[],
  closed: [] as unknown[],
  sent: [] as unknown[],
  picker: undefined as
    | {
        accept: () => void;
        hide: () => void;
        disposed: boolean;
        items: { label: string }[];
        selectedItems: { label: string }[];
      }
    | undefined,
  active: undefined as unknown,
}));
vi.mock("../../src/bridge", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/bridge")>();
  return {
    ...original,
    ExtensionBridge: class {
      closed = false;
      onData() {
        return () => {};
      }
      constructor(
        private options: {
          onClose: () => void;
          confirm: (view: unknown) => Promise<boolean>;
        },
      ) {}
      async pair(_ticket: string, workspace: unknown) {
        const w = workspace as {
          root_uri: string;
          root_file_id: string;
          window_id: string;
        };
        const pair = {
          ...w,
          host_boot_id: "boot",
          pair_id: "pair",
          root_id: rootIdentity(w),
          challenge: "x",
          status: "paired",
        };
        await this.options.confirm(pair);
        return pair;
      }
      async send(value: unknown) {
        if (this.closed) throw Error("Closed");
        editor.sent.push(value);
      }
      async close() {
        if (!this.closed) {
          this.closed = true;
          this.options.onClose();
        }
      }
    },
  };
});
vi.mock("vscode", () => {
  const uri = (value: string) => ({
    toString: () => value,
    scheme: new URL(value).protocol.slice(0, -1),
    fsPath: new URL(value).pathname,
  });
  class TabInputText {
    constructor(public uri: { toString(): string }) {}
  }
  return {
    UIKind: { Desktop: 1 },
    env: { uiKind: 1, remoteName: undefined },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    Uri: {
      file: (p: string) => {
        const value = new URL("file://" + p).href;
        return uri(
          editor.encodeUris
            ? value.slice(0, 7) + value.slice(7).replaceAll(":", "%3A")
            : value,
        );
      },
      parse: uri,
    },
    TabInputText,
    TabInputTextDiff: class {},
    EndOfLine: { LF: 1 },
    commands: {
      registerCommand: (name: string, handler: () => Promise<void>) => {
        editor.commands.set(name, handler);
        return { dispose: () => editor.commands.delete(name) };
      },
    },
    workspace: {
      isTrusted: true,
      get workspaceFolders() {
        return [{ uri: uri(editor.rootUri) }];
      },
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      registerTextDocumentContentProvider: (
        name: string,
        provider: {
          provideTextDocumentContent: (uri: { toString(): string }) => string;
        },
      ) => {
        editor.providers.set(name, provider);
        return { dispose: () => editor.providers.delete(name) };
      },
      openTextDocument: async (value: {
        toString(): string;
        scheme?: string;
      }) => {
        editor.opened.push(value.toString());
        editor.afterOpen?.();
        const old = editor.documents.get(value.toString());
        if (old) return old;
        const document = {
          uri: value,
          get version() {
            return editor.version;
          },
          get isDirty() {
            return editor.dirty;
          },
          get eol() {
            return editor.eol;
          },
          getText: () =>
            value.scheme === "sage-context"
              ? editor.providers
                  .get("sage-context")!
                  .provideTextDocumentContent(value)
              : editor.text,
        };
        editor.documents.set(value.toString(), document);
        return document;
      },
    },
    languages: {
      getDiagnostics: () => {
        editor.diagnosticReads++;
        return editor.diagnostics;
      },
    },
    window: {
      get activeTextEditor() {
        return editor.active;
      },
      showInputBox: async () => "fixture-ticket",
      showWarningMessage: async () => "Pair this folder",
      showInformationMessage: async () => {},
      showErrorMessage: async () => {},
      showTextDocument: async (document: { uri: { toString(): string } }) => {
        editor.active = { document };
        editor.tabs.push({ input: new TabInputText(document.uri) });
      },
      tabGroups: {
        get all() {
          return [{ tabs: editor.tabs }];
        },
        onDidChangeTabs: () => ({ dispose() {} }),
        close: async (tabs: unknown[]) => {
          editor.closed.push(...tabs);
          editor.tabs = editor.tabs.filter((t) => !tabs.includes(t));
          return true;
        },
      },
      createQuickPick: () => {
        let accept = () => {},
          hide = () => {};
        const picker = {
          items: [] as { label: string }[],
          selectedItems: [] as { label: string }[],
          disposed: false,
          onDidAccept: (cb: () => void) => {
            accept = cb;
            return { dispose() {} };
          },
          onDidHide: (cb: () => void) => {
            hide = cb;
            return { dispose() {} };
          },
          accept: () => accept(),
          hide: () => hide(),
          dispose() {
            this.disposed = true;
          },
          show() {
            editor.picker = this;
            const choice = editor.choices.shift();
            if (choice !== undefined)
              queueMicrotask(() => {
                if (choice === null) hide();
                else {
                  this.selectedItems = this.items.filter((item) =>
                    choice.includes(item.label),
                  );
                  accept();
                }
              });
          },
        };
        return picker;
      },
    },
  };
});
vi.mock("../../src/root-probe", () => ({
  probeRoot: vi.fn(async () => "darwin-native-1"),
  validateRootSpelling: (p: string) => {
    if (!p.startsWith("/") || p.includes("/../")) throw Error("root");
  },
}));
const roots: string[] = [];
afterEach(async () => {
  editor.documents.clear();
  vi.useRealTimers();
  editor.text = "";
  editor.encodeUris = false;
  editor.dirty = false;
  editor.eol = 1;
  editor.version = 1;
  editor.diagnostics = [];
  editor.diagnosticReads = 0;
  editor.opened = [];
  editor.afterOpen = undefined;
  editor.sent = [];
  editor.choices = [];
  editor.tabs = [];
  editor.closed = [];
  editor.active = undefined;
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function selection(create = false): Promise<ContextSelection> {
  const root = await realpath(await mkdtemp("/private/tmp/sage-context-"));
  roots.push(root);
  const workspace = localWorkspace(
    {
      trusted: true,
      remoteName: undefined,
      uiKind: "desktop",
      folders: [{ uri: pathToFileURL(root).href }],
    },
    "window",
  );
  return {
    pair: {
      ...workspace,
      host_boot_id: "boot",
      pair_id: "pair",
      root_id: rootIdentity(workspace),
      challenge: "challenge",
      status: "paired",
    },
    binding: {
      job_id: "job",
      boot_id: "boot",
      pair_id: "pair",
      window_id: "window",
      root_id: rootIdentity(workspace),
      revision: 1,
      policy_version: "code-v1",
    },
    generation: 0,
    rawRootUri: pathToFileURL(root).href,
    nativeIdentity: "darwin-native-1",
    extensionPath: root,
    storagePath: root,
    mode: create ? "create_focus_project" : "replace_focus_file",
    ...(create ? {} : { target: "focus.js" as const }),
    names: create ? [] : ["focus.js"],
    diagnosticIds: [],
    guard: () => {},
  };
}
it("reject_nonempty_create_root_including_hidden_entries", async () => {
  const s = await selection(true);
  const root = new URL(s.rawRootUri);
  await writeFile(new URL(".keep", root.href + "/"), "human");
  await expect(captureContext(s)).rejects.toThrow();
  expect(await readFile(new URL(".keep", root.href + "/"), "utf8")).toBe(
    "human",
  );
  expect(editor.opened).toEqual([]);
});
it("preserve_utf8_lf_without_conversion", async () => {
  const s = await selection();
  editor.text = "const emoji = '😀';\n";
  await writeFile(
    join(new URL(s.rawRootUri).pathname, "focus.js"),
    editor.text,
  );
  const c = await captureContext(s);
  expect(c.files[0].text).toBe(editor.text);
  expect(c.files[0].document_version).toBe(1);
  await validateContext(c);
  editor.version++;
  await expect(validateContext(c)).rejects.toThrow();
});
it.each([
  Buffer.from("a\r\nb"),
  Buffer.from("\ufeffa"),
  Buffer.from([0xff]),
  Buffer.from("😀".repeat(32001)),
])("refuses unconverted invalid source bytes %j", async (bytes) => {
  const s = await selection();
  editor.text = bytes.toString();
  await writeFile(join(new URL(s.rawRootUri).pathname, "focus.js"), bytes);
  await expect(captureContext(s)).rejects.toThrow();
});
it("accepts astral boundary and rejects dirty or editor/disk conflicts", async () => {
  const s = await selection();
  editor.text = "😀".repeat(32000);
  await writeFile(
    join(new URL(s.rawRootUri).pathname, "focus.js"),
    editor.text,
  );
  expect((await captureContext(s)).files[0].text).toBe(editor.text);
  for (const dirty of [true, false]) {
    editor.dirty = dirty;
    if (!dirty) editor.text = "different";
    await expect(captureContext(s)).rejects.toThrow();
  }
});
it("bind_windows_alias_and_workspace_generation", async () => {
  const s = await selection(true);
  let generation = 0;
  s.guard = () => {
    if (generation !== s.generation) throw Error("generation");
  };
  editor.afterOpen = () => {
    generation++;
  };
  const c = await captureContext(s);
  generation++;
  await expect(validateContext(c)).rejects.toThrow();
  await expect(
    captureContext({ ...s, rawRootUri: "file://server/share" }),
  ).rejects.toThrow();
});
it("refuses linked targets and a root switched after pairing", async () => {
  const s = await selection();
  const root = new URL(s.rawRootUri).pathname;
  await writeFile(join(root, "other"), "x");
  await symlink(join(root, "other"), join(root, "focus.js"));
  await expect(captureContext(s)).rejects.toThrow();
  await rm(join(root, "focus.js"));
  await link(join(root, "other"), join(root, "focus.js"));
  await expect(captureContext(s)).rejects.toThrow();
  await rename(root, root + "-old");
  roots.push(root + "-old");
  await writeFile(root, "switched");
  await expect(captureContext(s)).rejects.toThrow();
});
it("selects diagnostics explicitly, counts their text and anchors expiry to capture", async () => {
  const s = await selection();
  editor.text = "x";
  await writeFile(
    join(new URL(s.rawRootUri).pathname, "focus.js"),
    editor.text,
  );
  editor.diagnostics = [
    {
      message: "selected message",
      range: { start: { line: 0, character: 1 } },
    },
  ];
  const c = await captureContext({ ...s, diagnosticIds: ["focus.js:0"] });
  expect(c.diagnostics).toEqual(["focus.js:1:2: selected message"]);
  const offer = contextOffer(c);
  expect(contextOffer(c)).toEqual(offer);
  releaseContext(c);
  await expect(validateContext(c)).rejects.toThrow();
  await expect(
    captureContext({ ...s, diagnosticIds: ["README.md:0"] }),
  ).rejects.toThrow();
  editor.diagnostics[0].message = "x".repeat(64000);
  await expect(
    captureContext({ ...s, diagnosticIds: ["focus.js:0"] }),
  ).rejects.toThrow();
});
it("revalidates after editor await and never validates a model-supplied clone", async () => {
  const s = await selection();
  editor.text = "x";
  await writeFile(
    join(new URL(s.rawRootUri).pathname, "focus.js"),
    editor.text,
  );
  let changed = false;
  s.guard = () => {
    if (changed) throw Error("workspace");
  };
  editor.afterOpen = () => {
    changed = true;
  };
  await expect(captureContext(s)).rejects.toThrow();
  changed = false;
  editor.afterOpen = undefined;
  const c = await captureContext(s);
  await expect(validateContext(structuredClone(c))).rejects.toThrow();
});

async function controller() {
  const s = await selection();
  editor.rootUri = s.rawRootUri;
  editor.text = "selected source 😀\n";
  await writeFile(
    join(new URL(s.rawRootUri).pathname, "focus.js"),
    editor.text,
  );
  const storage = await realpath(
    await mkdtemp("/private/tmp/sage-controller-storage-"),
  );
  roots.push(storage);
  const { activate, deactivate } = await import("../../src/extension");
  const subscriptions: { dispose(): void }[] = [];
  activate({
    subscriptions,
    extensionPath: storage,
    globalStorageUri: { fsPath: storage },
  } as unknown as import("vscode").ExtensionContext);
  await editor.commands.get("sage.pairLocalEditor")!();
  return {
    capture: editor.commands.get("sage.captureContext")!,
    send: editor.commands.get("sage.sendContext")!,
    cancel: editor.commands.get("sage.cancelContext")!,
    cleanup: async () => {
      await deactivate();
      subscriptions.forEach((s) => s.dispose());
    },
    preview: () => [...editor.providers.values()][0],
  };
}
it("explicit local controls select source, preview locally, then send once after a fresh gesture", async () => {
  const c = await controller();
  try {
    editor.choices = [
      ["Replace one focus file"],
      ["focus.js"],
      [],
      ["No diagnostics"],
    ];
    await c.capture();
    expect(editor.sent).toEqual([]);
    const preview = (
      editor.active as {
        document: { uri: { toString(): string }; getText(): string };
      }
    ).document;
    expect(preview.getText()).toContain(editor.text);
    const unrelated = { input: { unrelated: true } };
    editor.tabs.push(unrelated);
    editor.choices = [["Send selected context to local Sage"]];
    await c.send();
    expect(editor.sent).toHaveLength(1);
    const offer = editor.sent[0] as {
      payload: {
        context: import("../../../desktop/shared/coding-contracts").CodeContext;
      };
    };
    expect(offer.payload.context.files.map((f) => f.name)).toEqual([
      "focus.js",
    ]);
    await c.send();
    expect(editor.sent).toHaveLength(1);
    await c.cancel();
    expect(preview.getText()).toBe("Disclosure expired or cancelled.");
    expect(editor.tabs).toContain(unrelated);
    expect(editor.closed).toHaveLength(1);
  } finally {
    await c.cleanup();
  }
});
it("cancel invalidates a pending disclosure confirmation before cleanup and rejects a late accept", async () => {
  const c = await controller();
  try {
    editor.choices = [
      ["Replace one focus file"],
      ["focus.js"],
      [],
      ["No diagnostics"],
    ];
    await c.capture();
    const pending = c.send();
    await vi.waitFor(() =>
      expect(editor.picker?.items[0].label).toBe(
        "Send selected context to local Sage",
      ),
    );
    const picker = editor.picker!;
    await c.cancel();
    picker.selectedItems = [picker.items[0]];
    picker.accept();
    await pending;
    expect(editor.sent).toEqual([]);
    expect(picker.disposed).toBe(true);
  } finally {
    await c.cleanup();
  }
});
it("expiry hides pending controls, clears selected text and prevents a late send", async () => {
  const c = await controller();
  try {
    editor.choices = [
      ["Replace one focus file"],
      ["focus.js"],
      [],
      ["No diagnostics"],
    ];
    vi.useFakeTimers();
    const creating = c.capture();
    await creating;
    const preview = (editor.active as { document: { getText(): string } })
      .document;
    const pending = c.send();
    await vi.waitFor(() =>
      expect(editor.picker?.items[0].label).toBe(
        "Send selected context to local Sage",
      ),
    );
    await vi.advanceTimersByTimeAsync(1800000);
    await pending;
    expect(editor.sent).toEqual([]);
    expect(preview.getText()).toBe("Disclosure expired or cancelled.");
  } finally {
    vi.useRealTimers();
    await c.cleanup();
  }
});

it("does not read diagnostics when none were explicitly selected", async () => {
  const s = await selection();
  editor.text = "x";
  await writeFile(
    join(new URL(s.rawRootUri).pathname, "focus.js"),
    editor.text,
  );
  const captured = await captureContext(s);
  await validateContext(captured);
  expect(editor.diagnosticReads).toBe(0);
});
it("expires source-bearing diagnostic selection while its native picker is still pending", async () => {
  const c = await controller();
  let creating: Promise<void> | undefined;
  try {
    editor.diagnostics = [
      {
        message: "selected diagnostic source",
        range: { start: { line: 0, character: 0 } },
      },
    ];
    editor.choices = [
      ["Replace one focus file"],
      ["focus.js"],
      [],
      ["Select diagnostics"],
    ];
    vi.useFakeTimers();
    creating = c.capture();
    await vi.waitFor(() =>
      expect(editor.picker?.items[0].label).toContain(
        "selected diagnostic source",
      ),
    );
    const picker = editor.picker!;
    await vi.advanceTimersByTimeAsync(1800000);
    expect(picker.disposed).toBe(true);
    await creating;
    expect(editor.sent).toEqual([]);
  } finally {
    await c.cancel();
    await creating;
    vi.useRealTimers();
    await c.cleanup();
  }
});

it("accepts an encoded colon URI for the same exact original native folder and document", async () => {
  const s = await selection();
  const root = join(new URL(s.rawRootUri).pathname, "owner:folder");
  await mkdir(root);
  const workspace = localWorkspace(
    {
      trusted: true,
      remoteName: undefined,
      uiKind: "desktop",
      folders: [{ uri: pathToFileURL(root).href }],
    },
    "window",
  );
  s.pair = { ...s.pair, ...workspace, root_id: rootIdentity(workspace) };
  s.binding = { ...s.binding, root_id: s.pair.root_id };
  s.rawRootUri = pathToFileURL(root).href.replace(":folder", "%3Afolder");
  editor.encodeUris = true;
  editor.text = "colon source 😀\n";
  await writeFile(join(root, "focus.js"), editor.text);
  const context = await captureContext(s);
  expect(context.root_uri).toBe(s.pair.root_uri);
  await validateContext(context);
  for (const segment of ["unused/../", "unused/%2e%2e/"])
    await expect(
      captureContext({
        ...s,
        rawRootUri: s.rawRootUri.replace(
          "/owner%3Afolder",
          `/${segment}owner%3Afolder`,
        ),
      }),
    ).rejects.toThrow();
});

it("refuses a selected document changed during the final native await", async () => {
  const s = await selection();
  editor.text = "x";
  await writeFile(
    join(new URL(s.rawRootUri).pathname, "focus.js"),
    editor.text,
  );
  const context = await captureContext(s);
  const { probeRoot } = await import("../../src/root-probe");
  let checks = 0;
  vi.mocked(probeRoot).mockImplementation(async () => {
    if (++checks === 2) editor.version++;
    return "darwin-native-1";
  });
  try {
    await expect(validateContext(context)).rejects.toThrow();
  } finally {
    vi.mocked(probeRoot).mockResolvedValue("darwin-native-1");
  }
});

function expectedSummary(
  hash: string,
  files: readonly string[],
  fileHash: string,
  creation = false,
): string[] {
  const lines = [
    `Mode: ${creation ? "create_focus_project" : "replace_focus_file"}`,
    `Selected manifest (${files.length} existing): ${files.join(", ") || "none"}`,
    `Target: ${creation ? "new empty project" : "focus.js"}`,
    `Read-only scope: ${creation ? "none" : files.filter((name) => name !== "focus.js").join(", ") || "none"}`,
  ];
  if (creation)
    lines.push(
      "Creation outputs: index.html, focus.js, focus.test.mjs, README.md",
    );
  lines.push(
    `Context SHA256 (1/2): ${hash.slice(0, 32)}`,
    `Context SHA256 (2/2): ${hash.slice(32)}`,
  );
  for (const name of files)
    lines.push(
      `${name} source: 18 code points`,
      `${name} text SHA256 (1/2): ${fileHash.slice(0, 32)}`,
      `${name} text SHA256 (2/2): ${fileHash.slice(32)}`,
      `${name} disk SHA256 (1/2): ${fileHash.slice(0, 32)}`,
      `${name} disk SHA256 (2/2): ${fileHash.slice(32)}`,
    );
  lines.push(
    `Source: ${creation ? 0 : 36} code points`,
    `Selected diagnostics: ${creation ? 0 : 24} code points (${creation ? 0 : 1} selected)`,
    `Provider-visible metadata: ${creation ? 20 : 43} code points`,
    `Total: ${creation ? 20 : 103} / 64000 code points`,
  );
  return lines;
}
it.each([false, true])(
  "shows the exact immutable disclosure summary in preview and final expirable control (empty creation %s)",
  async (creation) => {
    const c = await controller();
    let pending: Promise<void> | undefined;
    try {
      const root = new URL(editor.rootUri).pathname;
      if (creation) {
        await rm(join(root, "focus.js"));
        editor.choices = [["Create focus project"]];
      } else {
        await writeFile(join(root, "README.md"), editor.text);
        editor.diagnostics = [
          {
            message: "selected 😀",
            range: { start: { line: 0, character: 1 } },
          },
        ];
        editor.choices = [
          ["Replace one focus file"],
          ["focus.js"],
          ["README.md"],
          ["Select diagnostics"],
          ["focus.js:1:2: selected 😀"],
        ];
      }
      await c.capture();
      const preview = (editor.active as { document: { getText(): string } })
        .document;
      const text = preview.getText();
      const hash = /Context hash: ([0-9a-f]{64})/.exec(text)![1];
      const { createHash } = await import("node:crypto");
      const fileHash = createHash("sha256")
        .update("selected source 😀\n")
        .digest("hex");
      const expected = expectedSummary(
        hash,
        creation ? [] : ["focus.js", "README.md"],
        fileHash,
        creation,
      );
      expect(text).toContain(expected.join("\n"));
      expect(editor.sent).toEqual([]);
      pending = c.send();
      await vi.waitFor(() =>
        expect(editor.picker?.items[0].label).toBe(
          "Send selected context to local Sage",
        ),
      );
      const picker = editor.picker!;
      expect(picker.items.map((item) => item.label)).toEqual([
        "Send selected context to local Sage",
        "Keep local",
        ...expected,
      ]);
      for (const item of picker.items.slice(2)) {
        expect(item).toMatchObject({ alwaysShow: true });
        expect(item.label).not.toContain("selected 😀");
        expect(item.label).not.toContain("selected source");
      }
      await c.cancel();
      picker.selectedItems = [picker.items[0]];
      picker.accept();
      await pending;
      expect(editor.sent).toEqual([]);
      expect(preview.getText()).toBe("Disclosure expired or cancelled.");
    } finally {
      await c.cancel();
      await pending;
      await c.cleanup();
    }
  },
);
