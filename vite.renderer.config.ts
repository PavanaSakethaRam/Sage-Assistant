import { defineConfig } from "vite";
export default defineConfig({
  root: "desktop/renderer",
  base: "./",
  build: { outDir: "../../.vite/renderer/main_window", emptyOutDir: true },
  server: { host: "127.0.0.1", strictPort: true },
});
