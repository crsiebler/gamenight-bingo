import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "apps/**/*.{test,spec}.ts",
            "packages/**/*.{test,spec}.ts",
            "tests/**/*.{test,spec}.ts",
          ],
          exclude: ["**/node_modules/**", "tests/e2e/**", "tests/fixtures/**"],
        },
      },
      {
        test: {
          name: "dom",
          environment: "jsdom",
          include: [
            "apps/**/*.{test,spec}.tsx",
            "packages/**/*.{test,spec}.tsx",
            "tests/**/*.{test,spec}.tsx",
          ],
          exclude: ["**/node_modules/**", "tests/e2e/**", "tests/fixtures/**"],
          setupFiles: ["./tests/setup-dom.ts"],
        },
      },
    ],
  },
});
