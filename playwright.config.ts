import { defineConfig, devices } from "@playwright/test";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const useStableChrome = process.env["PLAYWRIGHT_BROWSER_CHANNEL"] === "chrome";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  reporter: "list",
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3100",
  },
  ...(testDatabaseUrl === undefined
    ? {}
    : {
        webServer: {
          command:
            "bun run --cwd apps/web build && bun run --cwd apps/web start --hostname 127.0.0.1 --port 3100",
          url: "http://127.0.0.1:3100/api/v1/patterns",
          env: { DATABASE_URL: testDatabaseUrl },
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(useStableChrome ? { channel: "chrome" as const } : {}),
      },
    },
  ],
});
