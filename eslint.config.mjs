import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/coverage/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "tests/fixtures/quality/**",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
]);
