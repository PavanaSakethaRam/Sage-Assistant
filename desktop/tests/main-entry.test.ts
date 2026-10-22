/** Breaks if main loses owned-window sender binding, progress fences or shutdown ownership. */
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
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
  dialog: { showMessageBox: async () => ({ response: state.result }) },
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
  }),
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
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.handlers.clear();
  state.listeners.clear();
  state.fail = false;
});
it("binds real IPC and progress to the live owned main frame, then closes account and core once", async () => {
  state.coreRequest.mockImplementation(async (request: { id: string }) => ({
    version: 1,
    kind: "response",
    id: request.id,
    result: { ai_mode: "assistant", reasoning_backend: "copilot" },
  }));
  await import("../main/index");
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
    status: "pending",
  });
  expect(window.webContents.send).toHaveBeenCalledTimes(1);
  window.webContents.mainFrame.url = "https://evil.test/";
  progress({});
  window.destroyed = true;
  progress({});
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
  expect(preventDefault).toHaveBeenCalledOnce();
  state.listeners.get("window-all-closed")!();
});
it("redacts a startup failure and still owns bounded shutdown", async () => {
  state.fail = true;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../main/index");
  await vi.waitFor(() => expect(state.quit).toHaveBeenCalled());
  expect(error).toHaveBeenCalledWith("desktop_startup_failed");
  expect(JSON.stringify(error.mock.calls)).not.toContain("private-content");
  state.listeners.get("before-quit")!({ preventDefault: () => {} });
  await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
  error.mockRestore();
});
