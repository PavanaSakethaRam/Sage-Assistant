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
  messageHeld: false,
  messages: [] as string[],
}));
vi.mock("vscode", () => ({
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
    showInputBox: async () => editor.ticket,
    showWarningMessage: async () => editor.choice,
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
  for (const args of [
    ["--case", "arbitrary"],
    ["--case", "context"],
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
  activate({ subscriptions } as unknown as import("vscode").ExtensionContext);
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
