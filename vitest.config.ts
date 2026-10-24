import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "desktop/tests/**/*.test.{ts,tsx}",
      "extension/test/unit/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "desktop/main/**/*.ts",
        "desktop/shared/**/*.ts",
        "desktop/preload/**/*.ts",
        "desktop/renderer/**/*.{ts,tsx}",
        "extension/src/**/*.ts",
      ],
      thresholds: { statements: 80, branches: 75 },
    },
  },
});
