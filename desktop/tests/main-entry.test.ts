/** Breaks if main loses owned-window sender binding, progress fences or shutdown ownership. */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  window: undefined as unknown,
  progress: undefined as unknown,
  options: undefined as unknown,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  quit: vi.fn(),
  close: vi.fn(async () => {}),
  accountClose: vi.fn(async () => {}),
  unsubscribe: vi.fn(),
  coreRequest: vi.fn(),
  result: 1,
  fail: false,
  lifecycle: undefined as undefined | (() => void),
  generation: 1,
  running: true,
  dialog: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(),
  clipboard: vi.fn(),
  host: undefined as unknown,
  hostOptions: undefined as unknown,
  hostClose: vi.fn(async () => {}),
  hostConfirm: vi.fn(),
  view: null as unknown,
}));
class Window extends EventEmitter {
  static latest: Window;
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "" },
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  show = vi.fn();
  isDestroyed() {
    return this.destroyed;
  }
  async loadURL(url: string) {
    if (state.fail) throw Error("private-content");
    this.webContents.mainFrame.url = url;
  }
  constructor(public options: unknown) {
    super();
    Window.latest = this;
    state.window = this;
  }
}
vi.mock("electron", () => ({
  app: {
    enableSandbox: vi.fn(),
    whenReady: () => Promise.resolve(),
    isPackaged: false,
    getPath: () => process.cwd(),
    quit: state.quit,
    on: (name: string, callback: (...args: unknown[]) => void) =>
      state.listeners.set(name, callback),
  },
  BrowserWindow: Window,
  session: {
    fromPartition: () => ({
      webRequest: {
        onBeforeRequest: vi.fn(),
        onHeadersReceived: (
          callback: (details: object, done: (value: unknown) => void) => void,
        ) => callback({}, () => {}),
      },
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    }),
  },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, callback),
    removeHandler: (name: string) => state.handlers.delete(name),
  },
  shell: { openExternal: vi.fn(async () => {}) },
  dialog: { showMessageBox: (...args: unknown[]) => state.dialog(...args) },
  clipboard: { writeText: state.clipboard },
}));
vi.mock("../main/core-process", async (original) => ({
  ...(await original<object>()),
  startCore: () => ({
    request: state.coreRequest,
    onProgress: (callback: unknown) => {
      state.progress = callback;
      return state.unsubscribe;
    },
    selectAccount: vi.fn(),
    close: state.close,
    get running() {
      return state.running;
    },
    get launchGeneration() {
      return state.generation;
    },
    codingControl: vi.fn(),
    onLifecycle: (callback: () => void) => {
      state.lifecycle = callback;
      return vi.fn();
    },
  }),
}));
vi.mock("../main/editor-bridge", () => ({
  EditorBridgeHost: class {
    constructor(options: unknown) {
      state.host = this;
      state.hostOptions = options;
    }
    start = vi.fn(async () => ({
      version: 1,
      port: 12345,
      host_boot_id: "host-1",
      secret: "SYNTHETIC_PAIR_CAPABILITY",
    }));
    pairingAvailable = () => state.running;
    pairView = () => state.view;
    currentCodingJob = () => undefined;
    codingJobStatus = () => undefined;
    close = async () => {
      state.view = null;
      await state.hostClose();
    };
    confirm = state.hostConfirm;
  },
}));
vi.mock("../main/copilot-account", async (original) => ({
  ...(await original<object>()),
  AccountBroker: class {
    constructor(options: unknown) {
      state.options = options;
    }
    close = state.accountClose;
  },
}));
beforeEach(() => {
  vi.stubGlobal(
    "SAGE_EDITOR_EXTENSION_MARKER",
    "SAGE_EDITOR_EXTENSION_V1:bnVsbA==",
  );
  state.dialog.mockImplementation(async () => ({ response: state.result }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
  state.handlers.clear();
  state.listeners.clear();
  state.fail = false;
  state.view = null;
  state.running = true;
  state.generation = 1;
  state.dialog.mockImplementation(async () => ({ response: state.result }));
});
it("binds real IPC and progress to the live owned main frame, then closes account and core once", async () => {
  state.coreRequest.mockImplementation(async (request: { id: string }) => ({
    version: 1,
    kind: "response",
    id: request.id,
    result: { ai_mode: "assistant", reasoning_backend: "copilot" },
  }));
  expect((await import("../main/index")).editorExtensionMarker).toBe(
    "SAGE_EDITOR_EXTENSION_V1:bnVsbA==",
  );
  await vi.waitFor(() => expect(Window.latest.show).toHaveBeenCalledOnce());
  const window = Window.latest;
  expect(window.options).toMatchObject({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const handler = state.handlers.get("sage:request")!;
  const request = {
    version: 1,
    kind: "request",
    id: "entry",
    method: "settings.get",
    params: {},
  };
  expect(
    await handler(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      request,
    ),
  ).toMatchObject({ id: "entry", kind: "response" });
  expect(
    await handler(
      { sender: {}, senderFrame: window.webContents.mainFrame },
      request,
    ),
  ).toMatchObject({ kind: "error" });
  const progress = state.progress as (message: unknown) => void;
  progress({
    id: "entry",
    task_id: "task",
    version: 1,
    kind: "progress",
    status: "started",
  });
  expect(window.webContents.send).toHaveBeenCalledTimes(1);
  window.webContents.mainFrame.url = "https://evil.test/";
  progress({
    version: 1,
    id: "entry",
    kind: "progress",
    status: "started",
    task_id: "task",
  });
  window.destroyed = true;
  progress({
    version: 1,
    id: "entry",
    kind: "progress",
    status: "started",
    task_id: "task",
  });
  expect(window.webContents.send).toHaveBeenCalledTimes(1);
  const options = state.options as {
    enabled: () => Promise<boolean>;
    confirm: (login: string) => Promise<boolean>;
    select: (account: null) => unknown;
  };
  expect(await options.enabled()).toBe(true);
  state.coreRequest.mockResolvedValue({ kind: "error" });
  expect(await options.enabled()).toBe(false);
  state.result = 0;
  expect(await options.confirm("synthetic")).toBe(true);
  state.result = 1;
  expect(await options.confirm("synthetic")).toBe(false);
  options.select(null);
  window.emit("closed");
  expect(state.unsubscribe).toHaveBeenCalledOnce();
  expect(state.handlers.size).toBe(0);
  const preventDefault = vi.fn();
  state.listeners.get("before-quit")!({ preventDefault });
  state.listeners.get("before-quit")!({ preventDefault });
  await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
  expect(state.accountClose).toHaveBeenCalledOnce();
  expect(state.close.mock.invocationCallOrder[0]).toBeLessThan(
    state.accountClose.mock.invocationCallOrder[0],
  );
  expect(preventDefault).toHaveBeenCalledOnce();
  state.listeners.get("window-all-closed")!();
});
it("redacts a startup failure and still owns bounded shutdown", async () => {
  state.fail = true;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await import("../main/index")).editorExtensionMarker).toBe(
    "SAGE_EDITOR_EXTENSION_V1:bnVsbA==",
  );
  await vi.waitFor(() => expect(state.quit).toHaveBeenCalled());
  expect(error).toHaveBeenCalledWith("desktop_startup_failed");
  expect(JSON.stringify(error.mock.calls)).not.toContain("private-content");
  state.listeners.get("before-quit")!({ preventDefault: () => {} });
  await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
  error.mockRestore();
});

const testPair = {
  root_uri: "file:///private/owned/focus",
  root_file_id: "root-1",
  window_id: "window-1",
  host_boot_id: "host-1",
  pair_id: "pair-1",
  root_id: "root-1",
  challenge: "1234-5678",
  status: "awaiting_confirmation",
};
async function entry() {
  state.coreRequest.mockImplementation(async (r: { id: string }) => ({
    version: 1,
    kind: "response",
    id: r.id,
    result: { ai_mode: "local", reasoning_backend: null },
  }));
  expect((await import("../main/index")).editorExtensionMarker).toBe(
    "SAGE_EDITOR_EXTENSION_V1:bnVsbA==",
  );
  await vi.waitFor(() => expect(Window.latest.show).toHaveBeenCalledOnce());
  const w = Window.latest;
  return (method: string, params = {}) =>
    state.handlers.get("sage:request")!(
      { sender: w.webContents, senderFrame: w.webContents.mainFrame },
      {
        version: 1,
        kind: "request",
        id: method.replaceAll(".", "_"),
        method,
        params,
      },
    );
}
it("defaults native pairing to Cancel, never exposes ticket, and copies only explicit trusted choice", async () => {
  const invoke = await entry();
  state.result = 1;
  expect(await invoke("editor.pair")).toMatchObject({ result: null });
  expect(state.clipboard).not.toHaveBeenCalled();
  expect(state.dialog.mock.calls[0][1]).toMatchObject({
    defaultId: 1,
    cancelId: 1,
    buttons: ["Copy pairing ticket", "Cancel"],
  });
  state.result = 0;
  const result = await invoke("editor.pair");
  expect(result).toMatchObject({ result: null });
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PAIR_CAPABILITY");
  expect(state.clipboard).toHaveBeenCalledOnce();
  await invoke("editor.disconnect");
});
it("serializes pairing before await and rejects delayed Copy after generation revocation", async () => {
  const invoke = await entry();
  let resolve!: (value: { response: number }) => void;
  state.dialog.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = invoke("editor.pair");
  await vi.waitFor(() => expect(state.dialog).toHaveBeenCalledOnce());
  expect(await invoke("editor.pair")).toMatchObject({ result: null });
  state.running = false;
  state.lifecycle!();
  resolve({ response: 0 });
  expect(await first).toMatchObject({ result: null });
  expect(state.clipboard).not.toHaveBeenCalled();
  expect(state.hostClose).toHaveBeenCalled();
});
it("pins native confirmation to captured pair and discards old dialog after settings change", async () => {
  const invoke = await entry();
  state.result = 0;
  await invoke("editor.pair");
  state.view = testPair;
  let resolve!: (value: { response: number }) => void;
  state.dialog.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const confirm = invoke("editor.confirm");
  await vi.waitFor(() => expect(state.dialog).toHaveBeenCalledTimes(2));
  expect(state.dialog.mock.calls[1][1]).toMatchObject({
    defaultId: 1,
    cancelId: 1,
    detail: expect.stringContaining(testPair.root_uri),
  });
  await invoke("settings.update", { coding_backend: "none" });
  state.view = { ...testPair, pair_id: "pair-2" };
  resolve({ response: 0 });
  expect(await confirm).toMatchObject({ result: null });
  expect(state.hostConfirm).not.toHaveBeenCalled();
});
