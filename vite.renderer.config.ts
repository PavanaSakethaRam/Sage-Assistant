import { defineConfig } from "vite";
export default defineConfig({
  root: "desktop/renderer",
  base: "./",
  plugins: [
    {
      name: "sage-development-csp",
      apply: "serve",
      // Main supplies the validated loopback CSP header. Built HTML keeps its meta.
      transformIndexHtml: (html) =>
        html.replace(
          /\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i,
          "",
        ),
    },
  ],
  build: { outDir: "../../.vite/renderer/main_window", emptyOutDir: true },
  server: { host: "127.0.0.1", strictPort: true },
});
