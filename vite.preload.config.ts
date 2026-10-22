import { defineConfig } from "vite";
export default defineConfig({
  build: {
    outDir: ".vite/build",
    emptyOutDir: false,
    lib: {
      entry: "desktop/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    rolldownOptions: {
      external: ["electron"],
      output: {
        codeSplitting: false,
        entryFileNames: "preload.cjs",
        chunkFileNames: "preload.cjs",
      },
    },
  },
});
