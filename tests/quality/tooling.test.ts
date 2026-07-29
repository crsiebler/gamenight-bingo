import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(root, "tests/fixtures/quality");

function runTool(name: string, args: string[]) {
  const executable = join(root, "node_modules/.bin", name);
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 30_000,
  });

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

function expectConfiguredFailure(
  name: string,
  args: string[],
  expectedDiagnostic: string | RegExp,
) {
  const result = runTool(name, args);

  expect(result.status, result.output).not.toBeNull();
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toMatch(expectedDiagnostic);
}

describe("quality-tool failure fixtures", () => {
  it("proves ESLint rejects an enabled-rule violation", () => {
    expectConfiguredFailure(
      "eslint",
      ["--no-ignore", join(fixtureRoot, "eslint/invalid.ts"), "--max-warnings=0"],
      "@typescript-eslint/no-unused-vars",
    );
  });

  it("proves Prettier and its Tailwind plugin reject unsorted classes", () => {
    expectConfiguredFailure(
      "prettier",
      [
        "--check",
        join(fixtureRoot, "prettier/invalid-tailwind-order.tsx"),
        "--ignore-path",
        join(fixtureRoot, "prettier/empty.ignore"),
      ],
      "Code style issues found",
    );
  });

  it("proves TypeScript rejects an invalid assignment", () => {
    expectConfiguredFailure(
      "tsc",
      ["--project", join(fixtureRoot, "typescript/tsconfig.json"), "--pretty", "false"],
      "TS2322",
    );
  });

  it("proves Vitest reports a failing assertion", () => {
    expectConfiguredFailure(
      "vitest",
      ["run", "--config", join(fixtureRoot, "vitest/vitest.config.ts")],
      "intentional Vitest failure",
    );
  });

  it("proves React Testing Library reports an inaccessible query", () => {
    expectConfiguredFailure(
      "vitest",
      ["run", "--config", join(fixtureRoot, "react-testing-library/vitest.config.ts")],
      /Unable to find an accessible element with the role "button"/,
    );
  });

  it("proves Playwright reports a failing assertion", () => {
    expectConfiguredFailure(
      "playwright",
      ["test", "--config", join(fixtureRoot, "playwright/playwright.config.ts")],
      "intentional Playwright failure",
    );
  });
});

describe("pre-commit hook", () => {
  it("preserves the required commands and executable mode", () => {
    const hookPath = join(root, ".husky/pre-commit");
    const requiredHook = [
      "npx lint-staged || exit 1",
      "npx tsc --noEmit || exit 1",
      "bun run test || exit 1",
      "",
    ].join("\n");

    expect(readFileSync(hookPath, "utf8")).toBe(requiredHook);

    if (process.platform !== "win32") {
      expect(statSync(hookPath).mode & 0o111).not.toBe(0);
    }
  });
});
