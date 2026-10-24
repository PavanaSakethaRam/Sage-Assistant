import { defineConfig } from "@playwright/test";
// Playwright sets FORCE_COLOR on workers; remove the inherited conflicting flag.
delete process.env.NO_COLOR;
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  retries: 0,
  reporter: "line",
  use: { trace: "off", screenshot: "off", video: "off" },
});
