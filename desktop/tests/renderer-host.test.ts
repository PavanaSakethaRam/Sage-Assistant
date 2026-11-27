import { it, expect } from "vitest";
import type { SageApi } from "../shared/contracts";
import { call, validRequest } from "../renderer/host";
it("rejects invalid renderer input before crossing the narrow bridge", async () => {
  let calls = 0;
  const api: SageApi = {
    request: async () => {
      calls++;
      throw Error("Unexpected bridge");
    },
    onProgress: () => () => {},
  };
  await expect(
    call(api, "notes.propose", { title: "bad\u0000", body: "body" }),
  ).rejects.toThrow("Invalid contract");
  expect(calls).toBe(0);
  expect(validRequest("notes.propose", { title: "okay", body: "\uFEFF" })).toBe(
    true,
  );
  expect(validRequest("notes.propose", { title: "okay", body: "\u2003" })).toBe(
    false,
  );
});
it("rejects mismatched and malformed replies rather than accepting data under a different request", async () => {
  const api: SageApi = {
    request: async () => ({
      version: 1,
      id: "wrong",
      kind: "response",
      result: { ai_mode: "local", reasoning_backend: null },
    }),
    onProgress: () => () => {},
  };
  await expect(call(api, "settings.get", {}, "expected")).rejects.toThrow(
    "Response correlation failed",
  );
  api.request = async () => ({
    version: 1,
    id: "expected",
    kind: "response",
    result: { ai_mode: "local", reasoning_backend: "copilot" },
  });
  await expect(call(api, "settings.get", {}, "expected")).rejects.toThrow(
    "Invalid contract",
  );
});
it("surfaces closed host failure codes", async () => {
  const api: SageApi = {
    request: async (r) => ({
      version: 1,
      id: r.id,
      kind: "error",
      code: "busy",
    }),
    onProgress: () => () => {},
  };
  await expect(
    call(api, "notes.list", { limit: 20, offset: 0 }),
  ).rejects.toThrow("busy");
});
