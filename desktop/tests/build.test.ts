/** Characterize Forge's real Vite merge: both sources are named index.ts. */
import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type UserConfig } from "vite";
import main from "../../vite.main.config";
import preload from "../../vite.preload.config";
it("Forge composition emits distinct main and single CJS preload with only the permitted Electron import", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-forge-build-"));
  try {
    const base = dirname(
      createRequire(import.meta.url).resolve("@electron-forge/plugin-vite"),
    );
    for (const [target, config] of [
      ["main", main],
      ["preload", preload],
    ] as const) {
      const module = (await import(
        pathToFileURL(join(base, "config", `vite.${target}.config.js`)).href
      )) as { getConfig: (env: unknown, user: UserConfig) => UserConfig };
      const merged = module.getConfig(
        {
          root: resolve("."),
          mode: "production",
          command: "build",
          forgeConfig: { renderer: [{ name: "main_window" }] },
          forgeConfigSelf: { entry: `desktop/${target}/index.ts` },
        },
        config,
      );
      await build({
        ...merged,
        configFile: false,
        logLevel: "silent",
        build: { ...merged.build, outDir: root, emptyOutDir: false },
      });
    }
    expect(
      (await readFile(join(root, "main.cjs"), "utf8")).length,
    ).toBeGreaterThan(1000);
    const bundle = await readFile(join(root, "preload.cjs"), "utf8");
    expect(
      [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["electron"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
