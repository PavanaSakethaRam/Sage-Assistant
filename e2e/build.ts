import { build } from "vite";
import { resolve } from "node:path";
const output = resolve(".cache/e2e");
await build({
  configFile: "vite.main.config.ts",
  logLevel: "silent",
  resolve: {
    alias: [
      {
        find: /^\.\/core-launch$/,
        replacement: resolve("e2e/fixtures/core-launch.ts"),
      },
    ],
  },
  build: { outDir: `${output}/build` },
});
await build({
  configFile: "vite.preload.config.ts",
  logLevel: "silent",
  build: { outDir: `${output}/build` },
});
await build({
  configFile: "vite.renderer.config.ts",
  logLevel: "silent",
  build: { outDir: `${output}/renderer/main_window` },
});
await build({
  configFile: false,
  logLevel: "silent",
  build: {
    outDir: output,
    emptyOutDir: false,
    lib: {
      entry: "e2e/fixtures/bootstrap.ts",
      formats: ["cjs"],
      fileName: () => "bootstrap.cjs",
    },
    rolldownOptions: { external: ["electron", /^node:/] },
  },
});
