import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["desktop/tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: [
        "desktop/main/**/*.ts",
        "desktop/shared/**/*.ts",
        "desktop/preload/**/*.ts",
        "desktop/renderer/**/*.{ts,tsx}",
      ],
      thresholds: { statements: 80, branches: 75 },
    },
  },
});
