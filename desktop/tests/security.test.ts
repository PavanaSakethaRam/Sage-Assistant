import { expect, it } from "vitest";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createWindowOptions,
  createTrust,
  isTrustedSender,
  validateExternalUrl,
  guardWindow,
  guardSession,
} from "../main/security";
import { handleRequest } from "../main/ipc";
const rendererRoot = resolve("/app/ui");
const trust = createTrust({ packaged: true, rendererDir: rendererRoot });
const url = pathToFileURL(join(rendererRoot, "index.html")).href;
const sender = { id: 1 };
const frame = { url };
const event = { sender, senderFrame: frame };
it("creates a sandboxed window with absolute bundled preload", () => {
  expect(createWindowOptions("/app/preload.cjs").webPreferences).toMatchObject({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    preload: "/app/preload.cjs",
  });
});
it("allows exactly the owned local main frame and static UI subtree", () => {
  expect(
    isTrustedSender(event, { webContents: sender, mainFrame: frame }, trust),
  ).toBe(true);
  for (const bad of [
    { sender: { id: 2 }, senderFrame: frame },
    { sender, senderFrame: { url } },
    { sender, senderFrame: { url: "https://example.com/" } },
    { sender, senderFrame: null },
  ])
    expect(
      isTrustedSender(bad, { webContents: sender, mainFrame: frame }, trust),
    ).toBe(false);
  expect(
    trust.resourceAllowed(
      pathToFileURL(join(rendererRoot, "assets/a.js")).href,
    ),
  ).toBe(true);
  for (const bad of [
    "file:///app/secret",
    "file:///app/ui-evil/a.js",
    "file:///app/ui/%2e%2e/secret",
    "file://remote/app/ui/a.js",
    "https://example.com/a",
    "data:text/plain,x",
  ])
    expect(trust.resourceAllowed(bad)).toBe(false);
  expect(() =>
    createTrust({
      packaged: true,
      rendererDir: "/app/ui",
      devServerUrl: "http://localhost:5173",
    }),
  ).toThrow();
  const dev = createTrust({
    packaged: false,
    rendererDir: "/app/ui",
    devServerUrl: "http://localhost:5173/",
  });
  expect(dev.resourceAllowed("http://localhost:5173/a.js")).toBe(true);
  expect(dev.resourceAllowed("http://localhost:5174/a.js")).toBe(false);
  expect(dev.documentAllowed("http://localhost:5173/evil")).toBe(false);
  expect(() =>
    createTrust({
      packaged: false,
      rendererDir: "/app/ui",
      devServerUrl: "https://evil.test/",
    }),
  ).toThrow();
});
it("blocks navigation, new windows, webviews, permissions and remote resource traffic", () => {
  const listeners = new Map<
    string,
    (event: { preventDefault(): void }) => void
  >();
  let open: (() => unknown) | undefined;
  guardWindow({
    on: (name, cb) => listeners.set(name, cb),
    setWindowOpenHandler: (cb) => {
      open = cb;
    },
  });
  let prevented = 0;
  for (const key of [
    "will-navigate",
    "will-frame-navigate",
    "will-attach-webview",
    "will-redirect",
  ])
    listeners.get(key)!({
      preventDefault: () => {
        prevented++;
      },
    });
  expect(prevented).toBe(4);
  expect(open!()).toEqual({ action: "deny" });
  let network:
    | ((
        details: { url: string },
        cb: (result: { cancel: boolean }) => void,
      ) => void)
    | undefined;
  let check: (() => boolean) | undefined;
  let permission:
    | ((_a: unknown, _b: unknown, cb: (allowed: boolean) => void) => void)
    | undefined;
  guardSession(
    {
      webRequest: {
        onBeforeRequest: (cb) => {
          network = cb;
        },
      },
      setPermissionCheckHandler: (cb) => {
        check = cb;
      },
      setPermissionRequestHandler: (cb) => {
        permission = cb;
      },
    },
    trust,
  );
  let cancelled = false;
  network!({ url: "https://evil.test/" }, (r) => {
    cancelled = r.cancel;
  });
  expect(cancelled).toBe(true);
  expect(check!()).toBe(false);
  permission!(null, null, (allowed) => expect(allowed).toBe(false));
});
it("validates explicit external clicks and never forwards them or forged senders to core", async () => {
  const forwarded: unknown[] = [];
  const opened: string[] = [];
  const deps = {
    owner: { webContents: sender, mainFrame: frame },
    trust,
    core: {
      request: async (r: unknown) => {
        forwarded.push(r);
        return {
          version: 1,
          id: "a",
          kind: "response",
          result: { ai_mode: "local", reasoning_backend: null },
        } as const;
      },
    },
    openExternal: async (uri: string) => {
      opened.push(uri);
    },
  };
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,x",
    "https://user:pass@example.com/",
    "https://example.com/\n",
    "mailto:a@example.com",
    "https://example.com/%0aevil",
  ])
    expect(() => validateExternalUrl(bad)).toThrow();
  const request = {
    version: 1,
    id: "a",
    kind: "request",
    method: "external.open",
    params: { url: "https://example.com/path" },
  };
  expect(await handleRequest(event, request, deps)).toMatchObject({
    result: { status: "opened" },
  });
  expect(opened).toEqual(["https://example.com/path"]);
  expect(forwarded).toEqual([]);
  expect(
    await handleRequest(
      { sender: { id: 5 }, senderFrame: frame },
      request,
      deps,
    ),
  ).toMatchObject({ kind: "error", code: "invalid_request" });
  expect(
    await handleRequest(
      event,
      { ...request, method: "core.start", params: { executable: "/evil" } },
      deps,
    ),
  ).toMatchObject({ kind: "error", code: "invalid_request" });
  expect(
    await handleRequest(
      event,
      { ...request, method: "settings.get", params: {} },
      deps,
    ),
  ).toMatchObject({ result: { ai_mode: "local" } });
  expect(forwarded).toHaveLength(1);
});

it("handles native account requests locally, denies input and clears selection before local mode", async () => {
  const calls: string[] = [];
  const deps = {
    owner: { webContents: sender, mainFrame: frame },
    trust,
    openExternal: async () => {},
    core: {
      request: async (r: import("../shared/contracts").CoreRequest) => {
        calls.push(r.method);
        return {
          version: 1 as const,
          kind: "response" as const,
          id: r.id,
          result: { ai_mode: "local" as const, reasoning_backend: null },
        };
      },
    },
    account: {
      beginModeTransition: () => {
        calls.push("begin");
        return () => {
          calls.push("finish");
        };
      },
      choose: async () => {
        calls.push("choose");
        return { status: "selected" as const };
      },
      disconnect: async () => {
        calls.push("disconnect");
        return { status: "cleared" as const };
      },
    },
  };
  const account = (method: string, params: unknown = {}) => ({
    version: 1,
    kind: "request",
    id: method.replaceAll(".", "-"),
    method,
    params,
  });
  expect(
    await handleRequest(event, account("copilot.chooseAccount"), deps),
  ).toMatchObject({ result: { status: "selected" } });
  expect(
    await handleRequest(event, account("copilot.disconnect"), deps),
  ).toMatchObject({ result: { status: "cleared" } });
  expect(
    await handleRequest(
      event,
      account("copilot.chooseAccount", { login: "evil" }),
      deps,
    ),
  ).toMatchObject({ code: "invalid_request" });
  expect(
    await handleRequest(
      event,
      account("settings.update", { ai_mode: "local" }),
      deps,
    ),
  ).toMatchObject({ result: { ai_mode: "local" } });
  await handleRequest(
    event,
    account("settings.update", {
      coding_backend: "copilot",
      coding_model: null,
    }),
    deps,
  );
  expect(calls).toEqual([
    "choose",
    "disconnect",
    "begin",
    "disconnect",
    "settings.update",
    "finish",
    "begin",
    "settings.update",
    "finish",
  ]);
});
it("permits Vite injected styles only in validated loopback development trust", () => {
  const dev = createTrust({
    packaged: false,
    rendererDir: "/app/ui",
    devServerUrl: "http://127.0.0.1:5173/",
  });
  expect(dev.csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(dev.csp).toContain(
    "connect-src http://127.0.0.1:5173 ws://127.0.0.1:5173",
  );
  expect(trust.csp).toContain("style-src 'self';");
  expect(trust.csp).not.toContain("unsafe-inline");
  expect(trust.csp).toContain("connect-src 'none'");
  for (const devServerUrl of [
    "http://evil.test/",
    "http://user@localhost:5173/",
    "http://localhost:5173/path",
    "http://localhost:5173/?anything",
    "https://localhost:5173/",
  ]) {
    expect(() =>
      createTrust({ packaged: false, rendererDir: "/app/ui", devServerUrl }),
    ).toThrow();
  }
});

it("routes only trusted closed editor gestures and cached active reads without a second Core poll", async () => {
  const { default: corpus } =
    await import("../../tests/fixtures/coding-contracts.json");
  const job = corpus.cases.find(
    (row) => row.kind === "job_view" && row.valid,
  )!.value;
  const calls: string[] = [];
  const deps = {
    owner: { webContents: sender, mainFrame: frame },
    trust,
    core: {
      request: async (request: { id: string; method: string }) => {
        calls.push(request.method);
        return {
          version: 1 as const,
          id: request.id,
          kind: "error" as const,
          code: "not_found" as const,
        };
      },
    },
    openExternal: async () => {},
    editor: {
      request: async () => {
        calls.push("native");
        return null;
      },
      invalidate: async () => {
        calls.push("invalidate");
      },
      cached: (id: string) =>
        id === "active" ? (job as never) : id === "expired" ? null : undefined,
    },
  };
  const request = (method: string, params = {}) => ({
    version: 1,
    kind: "request",
    id: "a",
    method,
    params,
  });
  expect(
    await handleRequest(event, request("editor.pair"), deps),
  ).toMatchObject({ result: null });
  expect(calls).toEqual(["native"]);
  for (const method of [
    "coding.review",
    "coding.test",
    "coding.apply",
    "host_coding",
    "codingControl",
  ])
    expect(await handleRequest(event, request(method), deps)).toMatchObject({
      code: "invalid_request",
    });
  expect(
    await handleRequest(
      event,
      request("editor.confirm", { approved: true }),
      deps,
    ),
  ).toMatchObject({ code: "invalid_request" });
  expect(
    await handleRequest(
      { sender: {}, senderFrame: frame },
      request("editor.pair"),
      deps,
    ),
  ).toMatchObject({ code: "invalid_request" });
  expect(
    await handleRequest(
      event,
      request("coding.get", { job_id: "active" }),
      deps,
    ),
  ).toMatchObject({ result: job });
  expect(
    await handleRequest(
      event,
      request("coding.get", { job_id: "expired" }),
      deps,
    ),
  ).toMatchObject({ code: "not_found" });
  expect(calls).toEqual(["native"]);
  await handleRequest(
    event,
    request("coding.get", { job_id: "historical" }),
    deps,
  );
  expect(calls).toEqual(["native", "coding.get"]);
  await handleRequest(
    event,
    request("settings.update", { coding_backend: "none" }),
    deps,
  );
  expect(calls.slice(-2)).toEqual(["invalidate", "settings.update"]);
});
