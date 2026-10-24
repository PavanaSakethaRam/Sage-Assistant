import { defineConfig } from "vite";
export default defineConfig({
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
});
