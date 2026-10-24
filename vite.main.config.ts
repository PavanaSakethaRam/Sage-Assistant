import { defineConfig } from "vite";
import { resolve } from "node:path";
import {
  extensionMarker,
  readExtensionIdentity,
} from "./desktop/main/extension-export.ts";
export default defineConfig({
  define: {
    SAGE_EDITOR_EXTENSION_MARKER: JSON.stringify(
      extensionMarker(
        readExtensionIdentity(
          resolve("build/editor-extension.json"),
          resolve(".runtime/package"),
          true,
        ),
      ),
    ),
  },
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
