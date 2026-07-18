import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const webSource = fileURLToPath(new URL("./apps/web/src", import.meta.url));
const webAliases = [
  { find: /^@$/, replacement: `${webSource}/ui.ts` },
  { find: /^@\/atoms$/, replacement: `${webSource}/components/atoms/index.ts` },
  { find: /^@\/lib$/, replacement: `${webSource}/lib/index.ts` },
  { find: /^@\/molecules$/, replacement: `${webSource}/components/molecules/index.ts` },
  { find: /^@\/organisms$/, replacement: `${webSource}/components/organisms/index.ts` },
  { find: /^@\/templates$/, replacement: `${webSource}/components/templates/index.ts` },
  { find: /^@\/(.*)$/, replacement: `${webSource}/$1` },
];

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: webAliases },
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
        resolve: { alias: webAliases },
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
