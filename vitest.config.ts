import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["desktop/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "desktop/main/**/*.ts",
        "desktop/shared/**/*.ts",
        "desktop/preload/**/*.ts",
      ],
      thresholds: { statements: 80, branches: 75 },
    },
  },
});
