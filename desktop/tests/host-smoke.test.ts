/** Real sandbox/preload check, isolated state, no inspector or network/provider calls. */
import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { build } from "vite";
import electron from "electron";
import { assertNativeElectronContext } from "../../e2e/native-context";
it("loads the built CJS sandbox preload and serves validated IPC in a real Electron window", async () => {
  assertNativeElectronContext();
  const root = await mkdtemp(join(tmpdir(), "sage-electron-test-"));
  try {
    await build({ logLevel: "silent", configFile: "vite.main.config.ts" });
    await build({ logLevel: "silent", configFile: "vite.preload.config.ts" });
    await build({ logLevel: "silent", configFile: "vite.renderer.config.ts" });
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: root,
        emptyOutDir: false,
        lib: {
          entry: resolve("desktop/tests/fixtures/host-smoke.ts"),
          formats: ["cjs"],
          fileName: () => "smoke.cjs",
        },
        rolldownOptions: { external: ["electron", /^node:/] },
      },
    });
    const output = await new Promise<{
      code: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
    }>((done, reject) => {
      const child = spawn(
        electron as unknown as string,
        [join(root, "smoke.cjs"), root, resolve(".")],
        {
          env: {
            TMPDIR: root,
            TMP: root,
            TEMP: root,
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
            ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("Electron smoke timed out"));
      }, 20000);
      child.stdout.on("data", (b) => (stdout += String(b)));
      child.stderr.on("data", (b) => (stderr += String(b)));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        done({ code, signal, stdout, stderr });
      });
    });
    expect(output.stderr).not.toContain("Unable to load preload");
    expect(output.stderr).not.toContain("SYNTHETIC_SECRET");
    expect(output.code, JSON.stringify(output)).toBe(0);
    expect(output.stdout).toContain("SAGE_HOST_SMOKE_OK");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
