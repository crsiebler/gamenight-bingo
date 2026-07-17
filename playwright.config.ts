import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  reporter: "list",
  retries: 0,
  projects: [
    {
      name: "chromium",
      use: devices["Desktop Chrome"],
    },
  ],
});
