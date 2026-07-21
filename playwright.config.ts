import { defineConfig, devices } from "@playwright/test";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const e2eDatabaseConfirmed = process.env["E2E_DATABASE_CONFIRMED_NONPRODUCTION"] === "true";
const useStableChrome = process.env["PLAYWRIGHT_BROWSER_CHANNEL"] === "chrome";
const runBrowserMatrix = process.env["PLAYWRIGHT_BROWSER_MATRIX"] === "all";
const matrixProjectName = process.env["PLAYWRIGHT_MATRIX_PROJECT"];

const browserMatrix = [
  {
    name: "chromium",
    use: devices["Desktop Chrome"],
  },
  {
    name: "chrome",
    use: { ...devices["Desktop Chrome"], channel: "chrome" as const },
  },
  {
    name: "edge",
    use: { ...devices["Desktop Edge"], channel: "msedge" as const },
  },
  {
    name: "firefox",
    use: devices["Desktop Firefox"],
  },
  {
    name: "webkit",
    use: devices["Desktop Safari"],
  },
  {
    name: "ios-webkit",
    use: devices["iPhone 15"],
  },
  {
    name: "android-chromium",
    use: devices["Pixel 7"],
  },
] as const;

const selectedMatrixProject = browserMatrix.find(({ name }) => name === matrixProjectName);

if (testDatabaseUrl !== undefined && !e2eDatabaseConfirmed) {
  throw new Error("Database-backed Playwright requires E2E_DATABASE_CONFIRMED_NONPRODUCTION=true.");
}

if (testDatabaseUrl !== undefined && runBrowserMatrix && selectedMatrixProject === undefined) {
  throw new Error(
    "Run each database-backed Playwright matrix project separately with PLAYWRIGHT_MATRIX_PROJECT set to one exact project name and a fresh database.",
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  reporter: "list",
  retries: 0,
  use: {
    baseURL: "http://localhost:3100",
  },
  ...(testDatabaseUrl === undefined
    ? {}
    : {
        webServer: [
          {
            command:
              "bun packages/database/scripts/assert-empty-e2e-database.ts && bun apps/game-server/src/index.ts",
            url: "http://127.0.0.1:4100/socket.io/?EIO=4&transport=polling",
            env: {
              DATABASE_URL: testDatabaseUrl,
              E2E_DATABASE_CONFIRMED_NONPRODUCTION: "true",
              GAME_SERVER_HOST: "127.0.0.1",
              GAME_SERVER_PORT: "4100",
              TEST_DATABASE_URL: testDatabaseUrl,
              WEB_ORIGIN: "http://localhost:3100",
            },
            reuseExistingServer: false,
            timeout: 120_000,
          },
          {
            command:
              "bun run --cwd apps/web build && bun run --cwd apps/web start --hostname 127.0.0.1 --port 3100",
            url: "http://127.0.0.1:3100/api/v1/patterns",
            env: {
              DATABASE_URL: testDatabaseUrl,
              NEXT_PUBLIC_GAME_SERVER_URL: "http://localhost:4100",
            },
            reuseExistingServer: false,
            timeout: 120_000,
          },
        ],
      }),
  projects: runBrowserMatrix
    ? selectedMatrixProject === undefined
      ? [...browserMatrix]
      : [selectedMatrixProject]
    : [
        useStableChrome
          ? browserMatrix.find(({ name }) => name === "chrome")!
          : browserMatrix.find(({ name }) => name === "chromium")!,
      ],
});
