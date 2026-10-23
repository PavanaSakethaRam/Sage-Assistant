import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("@playwright/test", async (load) => {
  const actual = await load<typeof import("@playwright/test")>();
  return { ...actual, _electron: { launch: vi.fn() } };
});
import { _electron } from "@playwright/test";
import { launch } from "../../e2e/harness";
const roots: string[] = [];
beforeEach(() => vi.stubEnv("CODEX_SANDBOX", ""));
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it.each([false, true])(
  "closes an acquired app after deferred firstWindow failure and preserves restart root=%s",
  async (restart) => {
    let fail!: (error: Error) => void;
    let acquired = false;
    let root = restart
      ? await mkdtemp(join(tmpdir(), "sage-e2e-restart-test-"))
      : "";
    if (root) roots.push(root);
    let closed = false;
    const error = new Error("original firstWindow failure");
    const pending = new Promise<never>((_, reject) => {
      fail = reject;
    });
    vi.mocked(_electron.launch).mockImplementation(async (options) => {
      root = options!.args![1];
      if (!restart) roots.push(root);
      return {
        firstWindow: () => {
          acquired = true;
          return pending;
        },
        close: async () => {
          closed = true;
          throw Error("cleanup failed");
        },
      } as never;
    });
    const result = launch(restart ? root : undefined);
    const rejection = expect(result).rejects.toBe(error);
    await vi.waitFor(() => expect(acquired).toBe(true));
    // Allow launch to acquire the owned app before the later initialization fails.
    await Promise.resolve();
    fail(error);
    await rejection;
    expect(closed).toBe(true);
    if (restart) await expect(access(root)).resolves.toBeUndefined();
    else await expect(access(root)).rejects.toThrow();
  },
);
