import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  reporter: "list",
  retries: 0,
  workers: 1,
});
