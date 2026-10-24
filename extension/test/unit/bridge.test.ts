import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { localWorkspace } from "../../src/bridge";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("pairs only a trusted desktop local single-folder window and detects a changed root", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sage-window-")));
  roots.push(root);
  const state = {
    trusted: true,
    remoteName: undefined,
    uiKind: "desktop" as const,
    folders: [{ uri: pathToFileURL(root).href }],
  };
  const view = localWorkspace(state, "window");
  expect(view.root_uri).toBe(pathToFileURL(root).href);
  expect(view.root_file_id).toMatch(/^\d+-\d+$/u);
  for (const modified of [
    { ...state, trusted: false },
    { ...state, remoteName: "ssh-remote" },
    { ...state, remoteName: "wsl" },
    { ...state, remoteName: "dev-container" },
    { ...state, uiKind: "web" as const },
    { ...state, folders: [] },
    { ...state, folders: [...state.folders, ...state.folders] },
    { ...state, folders: [{ uri: "vscode-vfs://repo/path" }] },
    { ...state, folders: [{ uri: "file://server/share" }] },
  ])
    expect(() => localWorkspace(modified, "window")).toThrow();
  const file = join(root, "ordinary");
  await writeFile(file, "");
  expect(() =>
    localWorkspace(
      { ...state, folders: [{ uri: pathToFileURL(file).href }] },
      "window",
    ),
  ).toThrow();
  await rm(root, { recursive: true });
  expect(() => localWorkspace(state, "window")).toThrow();
});

import { vi } from "vitest";
const editor = vi.hoisted(() => ({
  trusted: true,
  root: "",
  remote: undefined as string | undefined,
  commands: new Map<string, () => Promise<void>>(),
  workspaceChanged: () => {},
  ticket: undefined as string | undefined,
  choice: undefined as string | undefined,
  input: undefined as (() => Promise<string | undefined>) | undefined,
  confirmation: undefined as (() => Promise<string | undefined>) | undefined,
  messageHeld: false,
  messages: [] as string[],
}));
vi.mock("../../src/root-probe", () => ({
  probeRoot: async () => "darwin-unit-root",
  validateRootSpelling: () => {},
}));
vi.mock("vscode", () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  Uri: {
    file: (path: string) => ({
      fsPath: path,
      toString: () => pathToFileURL(path).href,
    }),
  },
  TabInputText: class {},
  TabInputTextDiff: class {},
  UIKind: { Desktop: 1 },
  env: {
    get remoteName() {
      return editor.remote;
    },
    uiKind: 1,
  },
  workspace: {
    get isTrusted() {
      return editor.trusted;
    },
    get workspaceFolders() {
      return [{ uri: { toString: () => editor.root } }];
    },
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: (handler: () => void) => {
      editor.workspaceChanged = handler;
      return { dispose() {} };
    },
  },
  commands: {
    registerCommand: (name: string, handler: () => Promise<void>) => {
      editor.commands.set(name, handler);
      return {
        dispose() {
          editor.commands.delete(name);
        },
      };
    },
  },
  window: {
    tabGroups: {
      all: [],
      onDidChangeTabs: () => ({ dispose() {} }),
      close: async () => true,
    },
    showInputBox: async () => (editor.input ? editor.input() : editor.ticket),
    showWarningMessage: async () =>
      editor.confirmation ? editor.confirmation() : editor.choice,
    showInformationMessage: async (message: string) => {
      editor.messages.push(message);
      if (editor.messageHeld) await new Promise(() => {});
    },
    showErrorMessage: async (message: string) => {
      editor.messages.push(message);
    },
  },
}));
it("shell refuses activation in restricted or remote state and owns command disposal", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sage-shell-")));
  roots.push(root);
  editor.root = pathToFileURL(root).href;
  const { activate, deactivate } = await import("../../src/extension");
  const subscriptions: { dispose(): void }[] = [];
  const shell = {
    subscriptions,
    extensionPath: root,
    globalStorageUri: { fsPath: root },
  } as unknown as import("vscode").ExtensionContext;
  editor.trusted = false;
  expect(() => activate(shell)).toThrow();
  editor.trusted = true;
  editor.remote = "ssh-remote";
  expect(() => activate(shell)).toThrow();
  editor.remote = undefined;
  activate(shell);
  const command = editor.commands.get("sage.pairLocalEditor")!;
  editor.ticket = undefined;
  await command();
  editor.ticket = "bad-ticket";
  await command();
  expect(editor.messages.at(-1)).toMatch(/could not pair/u);
  editor.workspaceChanged();
  await deactivate();
  subscriptions.forEach((subscription) => subscription.dispose());
  expect(editor.commands.has("sage.pairLocalEditor")).toBe(false);
  editor.ticket = undefined;
});

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { validateVsix } from "../../../scripts/check_package";
it("rejects an actual VSIX carrying a test driver outside its seven-file allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-vsix-test-"));
  roots.push(root);
  const path = join(root, "bad.vsix");
  const python = resolve(
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const created = spawnSync(
    python,
    [
      "-c",
      "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('extension/test/driver/extension.cjs','private driver'); z.close()",
      path,
    ],
    { shell: false },
  );
  expect(created.status).toBe(0);
  await expect(validateVsix(path)).rejects.toThrow();
});

import {
  inventory,
  revalidate,
  VERSION,
  COMMIT,
  platformName,
} from "../../../scripts/provision-vscode";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { selectedCase } from "../../../scripts/test-vscode";
it("deterministic editor cache validation rejects changed bytes, extra files and escaped links", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sage-vscode-cache-")),
  );
  roots.push(root);
  await mkdir(join(root, "app"));
  const executable = join(root, "app/code");
  await writeFile(executable, "owned-binary");
  const record = {
    version: VERSION,
    commit: COMMIT,
    platform: platformName(),
    executable: "app/code",
    inventory: await inventory(root),
  };
  await writeFile(join(root, "provenance.json"), JSON.stringify(record));
  expect(await revalidate(root)).toBe(executable);
  await writeFile(executable, "drift");
  await expect(revalidate(root)).rejects.toThrow();
  await writeFile(executable, "owned-binary");
  await writeFile(join(root, "extra"), "unexpected");
  await expect(revalidate(root)).rejects.toThrow();
  await rm(join(root, "extra"));
  await chmod(executable, 0o700);
  await expect(revalidate(root)).rejects.toThrow();
  await symlink(tmpdir(), join(root, "escape"));
  await expect(inventory(root)).rejects.toThrow();
  await rm(join(root, "escape"));
  await writeFile(
    join(root, "provenance.json"),
    JSON.stringify({ ...record, commit: "other" }),
  );
  await expect(revalidate(root)).rejects.toThrow();
});
it("fixed native case selection fails unknown or future cases instead of silently skipping", () => {
  expect(selectedCase([])).toBe("bridge");
  expect(selectedCase(["--case", "all"])).toBe("all");
  expect(selectedCase(["--case", "bridge"])).toBe("bridge");
  expect(selectedCase(["--case", "replace"])).toBe("replace");
  for (const args of [
    ["--case", "arbitrary"],
    ["--case", "bridge", "extra"],
    ["--other", "bridge"],
  ])
    expect(() => selectedCase(args)).toThrow();
  expect(() => platformName("linux", "x64")).toThrow();
  expect(() => platformName("darwin", "ia32")).toThrow();
  expect(platformName("win32", "x64")).toBe("win32-x64-archive");
  expect(platformName("darwin", "x64")).toBe("darwin");
});

it("pairing command completes after consent without waiting for notification dismissal", async () => {
  const { EditorBridgeHost } =
    await import("../../../desktop/main/editor-bridge");
  const root = await realpath(await mkdtemp(join(tmpdir(), "sage-command-")));
  roots.push(root);
  editor.root = pathToFileURL(root).href;
  editor.trusted = true;
  editor.remote = undefined;
  const host = new EditorBridgeHost({
    onData: () => {
      throw Error("Unexpected source");
    },
    onPair: (view) => {
      void host.confirm(view.pair_id);
    },
  });
  const ticket = await host.start();
  editor.ticket = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  editor.choice = "Pair this folder";
  editor.messageHeld = true;
  const { activate, deactivate } = await import("../../src/extension");
  const subscriptions: { dispose(): void }[] = [];
  activate({
    subscriptions,
    extensionPath: root,
    globalStorageUri: { fsPath: root },
  } as unknown as import("vscode").ExtensionContext);
  try {
    const completed = await Promise.race([
      editor.commands.get("sage.pairLocalEditor")!().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 150)),
    ]);
    expect(completed).toBe(true);
  } finally {
    editor.messageHeld = false;
    editor.ticket = undefined;
    editor.choice = undefined;
    subscriptions.forEach((item) => item.dispose());
    await deactivate();
    await host.close();
  }
});

import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function commandFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sage-command-owner-")),
  );
  roots.push(root);
  editor.root = pathToFileURL(root).href;
  editor.trusted = true;
  editor.remote = undefined;
  editor.choice = "Pair this folder";
  editor.messages = [];
  const shell = await import("../../src/extension");
  const subscriptions: { dispose(): void }[] = [];
  shell.activate({
    subscriptions,
    extensionPath: root,
    globalStorageUri: { fsPath: root },
  } as unknown as import("vscode").ExtensionContext);
  const sockets = new Set<Socket>();
  const observe = (event: unknown) => {
    const { socket } = event as { socket: Socket };
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  channel("net.server.socket").subscribe(observe);
  const hosts: import("../../../desktop/main/editor-bridge").EditorBridgeHost[] =
    [];
  async function host() {
    const { EditorBridgeHost } =
      await import("../../../desktop/main/editor-bridge");
    const paired =
      deferred<import("../../../desktop/shared/editor-bridge").PairView>();
    let pairs = 0;
    const server = new EditorBridgeHost({
      onData: () => {
        throw Error("Unexpected source");
      },
      onPair: (view) => {
        pairs++;
        paired.resolve(view);
        void server.confirm(view.pair_id).catch(() => {});
      },
    });
    hosts.push(server);
    const ticket = Buffer.from(JSON.stringify(await server.start())).toString(
      "base64url",
    );
    return { server, ticket, paired: paired.promise, pairs: () => pairs };
  }
  return {
    sockets,
    command: editor.commands.get("sage.pairLocalEditor")!,
    host,
    deactivate: shell.deactivate,
    dispose: () => subscriptions.forEach((item) => item.dispose()),
    async cleanup() {
      editor.input = undefined;
      editor.confirmation = undefined;
      editor.ticket = undefined;
      editor.choice = undefined;
      subscriptions.forEach((item) => item.dispose());
      await shell.deactivate();
      await Promise.all(hosts.map((item) => item.close()));
      channel("net.server.socket").unsubscribe(observe);
    },
  };
}
it("owns the whole pairing command before a pending ticket and closes its only authenticated socket", async () => {
  const fixture = await commandFixture();
  const first = await fixture.host(),
    second = await fixture.host();
  const input = deferred<string | undefined>();
  let prompts = 0;
  editor.input = () =>
    ++prompts === 1 ? input.promise : Promise.resolve(second.ticket);
  const older = fixture.command();
  try {
    await vi.waitFor(() => expect(prompts).toBe(1));
    await fixture.command();
    input.resolve(first.ticket);
    await older;
    await first.paired;
    expect(fixture.sockets.size).toBe(1);
    expect(prompts).toBe(1);
    expect(second.pairs()).toBe(0);
    await fixture.deactivate();
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0));
  } finally {
    input.resolve(undefined);
    await older;
    await fixture.cleanup();
  }
});
it.each(["dispose", "deactivate"] as const)(
  "%s during a pending ticket prevents a later connection",
  async (stop) => {
    const fixture = await commandFixture();
    const host = await fixture.host();
    const input = deferred<string | undefined>();
    let prompted = false;
    editor.input = () => {
      prompted = true;
      return input.promise;
    };
    const command = fixture.command();
    try {
      await vi.waitFor(() => expect(prompted).toBe(true));
      await fixture[stop]();
      input.resolve(host.ticket);
      await command;
      expect(host.pairs()).toBe(0);
      expect(
        editor.messages.some((message) => message.startsWith("Sage paired")),
      ).toBe(false);
    } finally {
      input.resolve(undefined);
      await command;
      await fixture.cleanup();
    }
  },
);
it.each(["dispose", "deactivate"] as const)(
  "%s during confirmation closes the socket and refuses late approval",
  async (stop) => {
    const fixture = await commandFixture();
    const host = await fixture.host();
    const approval = deferred<string | undefined>();
    let prompted = false;
    editor.ticket = host.ticket;
    editor.confirmation = () => {
      prompted = true;
      return approval.promise;
    };
    const command = fixture.command();
    try {
      await host.paired;
      expect(fixture.sockets.size).toBe(1);
      await vi.waitFor(() => expect(prompted).toBe(true));
      await fixture[stop]();
      approval.resolve("Pair this folder");
      await command;
      await vi.waitFor(() => expect(fixture.sockets.size).toBe(0));
      expect(
        editor.messages.some((message) => message.startsWith("Sage paired")),
      ).toBe(false);
    } finally {
      approval.resolve(undefined);
      await command;
      await fixture.cleanup();
    }
  },
);
it("a cancelled older prompt cannot pair or close a newer authenticated client", async () => {
  const fixture = await commandFixture();
  const oldHost = await fixture.host(),
    newHost = await fixture.host();
  const input = deferred<string | undefined>();
  let prompted = false;
  editor.input = () => {
    prompted = true;
    return input.promise;
  };
  const older = fixture.command();
  try {
    await vi.waitFor(() => expect(prompted).toBe(true));
    editor.workspaceChanged();
    editor.input = undefined;
    editor.ticket = newHost.ticket;
    await fixture.command();
    await newHost.paired;
    input.resolve("bad-ticket");
    await older;
    expect(oldHost.pairs()).toBe(0);
    expect(fixture.sockets.size).toBe(1);
    expect(
      editor.messages.filter((message) => message.startsWith("Sage paired")),
    ).toHaveLength(1);
    await fixture.deactivate();
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0));
  } finally {
    input.resolve(undefined);
    await older;
    await fixture.cleanup();
  }
});

it("retains command ownership while local confirmation is pending", async () => {
  const fixture = await commandFixture();
  const first = await fixture.host(),
    second = await fixture.host();
  const approval = deferred<string | undefined>();
  let prompts = 0;
  editor.ticket = first.ticket;
  editor.input = async () => {
    prompts++;
    return editor.ticket;
  };
  editor.confirmation = () => approval.promise;
  const older = fixture.command();
  try {
    await first.paired;
    editor.ticket = second.ticket;
    await fixture.command();
    approval.resolve("Pair this folder");
    await older;
    expect(prompts).toBe(1);
    expect(second.pairs()).toBe(0);
    expect(fixture.sockets.size).toBe(1);
    await fixture.deactivate();
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0));
  } finally {
    approval.resolve(undefined);
    await older;
    await fixture.cleanup();
  }
});
it("a cancelled older confirmation cannot close a newer paired client", async () => {
  const fixture = await commandFixture();
  const first = await fixture.host(),
    second = await fixture.host();
  const approval = deferred<string | undefined>();
  editor.ticket = first.ticket;
  editor.confirmation = () => approval.promise;
  const older = fixture.command();
  try {
    await first.paired;
    editor.workspaceChanged();
    await older;
    editor.confirmation = undefined;
    editor.ticket = second.ticket;
    await fixture.command();
    await second.paired;
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(1));
    approval.resolve("Pair this folder");
    await new Promise<void>((done) => setImmediate(done));
    expect(fixture.sockets.size).toBe(1);
    expect(
      editor.messages.filter((message) => message.startsWith("Sage paired")),
    ).toHaveLength(1);
    await fixture.deactivate();
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0));
  } finally {
    approval.resolve(undefined);
    await older;
    await fixture.cleanup();
  }
});

it("closes the previous paired socket even when the next workspace guard fails", async () => {
  const fixture = await commandFixture();
  const host = await fixture.host();
  editor.ticket = host.ticket;
  try {
    await fixture.command();
    await host.paired;
    expect(fixture.sockets.size).toBe(1);
    editor.trusted = false;
    await fixture.command();
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0));
    expect(editor.messages.at(-1)).toMatch(/could not pair/u);
  } finally {
    editor.trusted = true;
    await fixture.cleanup();
  }
});

it("registers explicit capture, send and cancellation controls without source release at readiness", async () => {
  const fixture = await commandFixture();
  try {
    expect(editor.commands.has("sage.captureContext")).toBe(true);
    expect(editor.commands.has("sage.sendContext")).toBe(true);
    expect(editor.commands.has("sage.cancelContext")).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

it("rejects an original dot-segment folder URI before requesting a pairing ticket", async () => {
  const fixture = await commandFixture();
  let prompts = 0;
  editor.root = editor.root.replace(/\/([^/]+)$/u, "/unused/../$1");
  editor.input = async () => {
    prompts++;
    return undefined;
  };
  try {
    await fixture.command();
    expect(prompts).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

import { ExtensionBridge } from "../../src/bridge";
import { EffectJournal } from "../../src/journal";
import { BINDING, HASH } from "../../../desktop/tests/coding-fixtures";
import type {
  CodeIntent,
  CodeFileReceipt,
  CodeBinding,
} from "../../../desktop/shared/coding-contracts";
it("closed bridge retains only an exact preexisting intent observation locally and sends no frame", async () => {
  const root = await realpath(
    await mkdtemp("/private/tmp/sage-closed-observed-"),
  );
  roots.push(root);
  const journal = new EffectJournal(pathToFileURL(root));
  const intent: CodeIntent = {
    binding: BINDING as CodeBinding,
    operation_id: "closed-operation",
    effect_id: "closed-effect",
    scope: "code.create",
    target: "index.html",
    ordinal: 0,
    expected_hash: HASH,
  };
  await journal.intent(intent);
  const bridge = new ExtensionBridge({
    confirm: async () => true,
    guard: () => {
      throw Error("cancelled");
    },
  });
  const sent = vi.spyOn(bridge, "send");
  const receipt: CodeFileReceipt = {
    ...intent,
    scope: "code.create",
    status: "needs_reconciliation",
    observed_hash: null,
    observed_length: null,
  };
  await expect(
    bridge.recordObserved(journal, {
      ...receipt,
      binding: { ...receipt.binding, job_id: "wrong" },
    }),
  ).rejects.toThrow();
  expect((await journal.get(intent.operation_id)).observations).toHaveLength(0);
  await bridge.close();
  await expect(bridge.recordObserved(journal, receipt)).rejects.toThrow();
  expect((await journal.get(intent.operation_id)).observations).toHaveLength(1);
  await expect(
    bridge.recordObserved(journal, { ...receipt, status: "partial" }),
  ).rejects.toThrow();
  expect((await journal.get(intent.operation_id)).observations).toHaveLength(1);
  expect(sent).not.toHaveBeenCalled();
  await expect(
    bridge.recordIntent(journal, {
      ...intent,
      effect_id: "next",
      ordinal: 1,
      target: "focus.js",
    }),
  ).rejects.toThrow();
  expect((await journal.get(intent.operation_id)).intents).toHaveLength(1);
});
