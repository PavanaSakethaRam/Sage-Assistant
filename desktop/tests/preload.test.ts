import { expect, it, vi } from "vitest";
import type { SageApi } from "../shared/contracts";
const captured = vi.hoisted(() => ({
  api: undefined as SageApi | undefined,
  listeners: new Map<string, (_event: unknown, value: unknown) => void>(),
  calls: 0,
  wrong: false,
}));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: SageApi) => {
      if (name !== "sage") throw Error("wrong global");
      captured.api = api;
    },
  },
  ipcRenderer: {
    invoke: async (_channel: string, request: { id: string }) => {
      captured.calls++;
      return {
        version: 1,
        id: captured.wrong ? "wrong" : request.id,
        kind: "response",
        result: { ai_mode: "local", reasoning_backend: null },
      };
    },
    on: (
      channel: string,
      listener: (_event: unknown, value: unknown) => void,
    ) => captured.listeners.set(channel, listener),
    removeListener: (channel: string) => captured.listeners.delete(channel),
  },
}));
it("only exposes closed requests and progress values without raw Electron events", async () => {
  await import("../preload/index");
  const api = captured.api!;
  expect(Object.keys(api)).toEqual(["request", "onProgress"]);
  expect(
    await api.request({
      version: 1,
      id: "a",
      kind: "request",
      method: "settings.get",
      params: {},
    }),
  ).toMatchObject({ id: "a", result: { ai_mode: "local" } });
  await expect(
    api.request({
      version: 1,
      id: "a",
      kind: "request",
      method: "settings.get",
      params: { executable: "/evil" },
    } as never),
  ).rejects.toThrow();
  expect(captured.calls).toBe(1);
  captured.wrong = true;
  await expect(
    api.request({
      version: 1,
      id: "a",
      kind: "request",
      method: "settings.get",
      params: {},
    }),
  ).rejects.toThrow("Invalid response");
  captured.wrong = false;
  const progress: unknown[] = [];
  const unsubscribe = api.onProgress((p) => progress.push(p));
  captured.listeners.get("sage:progress")!(
    { secret: "event" },
    { version: 1, id: "a", kind: "progress", status: "started", task_id: "t" },
  );
  captured.listeners.get("sage:progress")!(
    { secret: "event" },
    { token: "bad" },
  );
  expect(progress).toEqual([
    { version: 1, id: "a", kind: "progress", status: "started", task_id: "t" },
  ]);
  unsubscribe();
  expect(captured.listeners.size).toBe(0);
  expect(() => api.onProgress(null as never)).toThrow();
});
