import { defineConfig, type UserConfig } from "vite";
import { copyFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { buildRootProbe } from "./scripts/build-root-probe.ts";
export default defineConfig(async () => {
  const probe = await buildRootProbe();
  return {
    define: { __SAGE_ROOT_PROBE_SHA256__: JSON.stringify(probe.sha256) },
    plugins: [
      {
        name: "fixed-local-root-probe",
        closeBundle: async () => {
          const path = join("extension/dist", probe.name);
          await copyFile(probe.path, path);
          await chmod(path, 0o755);
        },
      },
    ],
    build: {
      outDir: "extension/dist",
      emptyOutDir: true,
      sourcemap: false,
      lib: {
        entry: "extension/src/extension.ts",
        formats: ["cjs"],
        fileName: () => "extension.cjs",
      },
      rolldownOptions: { external: ["vscode", /^node:/] },
    },
  } satisfies UserConfig;
});
