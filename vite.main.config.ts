import { defineConfig } from "vite";
export default defineConfig({
  build: {
    outDir: ".vite/build",
    emptyOutDir: false,
    lib: {
      entry: "desktop/main/index.ts",
      formats: ["cjs"],
      fileName: () => "main.cjs",
    },
    rolldownOptions: { external: ["electron", /^node:/] },
  },
});
