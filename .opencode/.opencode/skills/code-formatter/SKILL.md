---
name: code-formatter
description: Formats JavaScript/TypeScript code with Prettier, lints with ESLint CLI, and validates Bun + Vitest workflows
---

## What I do

- Format code using Prettier (respects .prettierrc and plugins)
- Lint code using ESLint CLI (`eslint`)
- Run pre-commit hooks via Husky and lint-staged to auto-format/lint staged files with Bun-first commands
- Validate tests with Vitest via Bun script (`bun run test`)
- Validate code style and formatting compliance

## When to use me

Use this skill for formatting, linting, and test command validation before every commit, after large code changes, or when preparing a PR/build. Husky and lint-staged enforce checks automatically on commit.

## Procedure

1. (Optional) Ensure correct Node version (`nvm use` if required by project)
2. Format code: `bunx prettier --write .`
3. Lint code: `bun run lint`
4. Run tests: `bun run test`
5. Canonical CI-safe test command:
   `bun run test -- --config vitest.config.mts --environment jsdom --globals --maxWorkers 1 --no-file-parallelism`
6. Important: **do not use `bun test`** in this repository. It runs Bun's test runner, not Vitest.
7. On commit, Husky will run lint-staged to format and lint staged files:
   - File types: js, jsx, ts, tsx
   - Commands run: `eslint --fix` and `prettier --write`
8. Fix any issues reported by Prettier, ESLint, Vitest, or the pre-commit hook
9. Autonomous loop note: if Vitest stalls in loop automation, skip loop-time tests and use lint + typecheck + build, then run Vitest manually.

## Related Guidelines

- Follow AGENTS.md code style guidelines
- Ensure all code passes Prettier, ESLint CLI, Vitest, and pre-commit (Husky/lint-staged) checks before commit or PR
- `.prettierrc` and `eslint.config.mjs` are automatically respected
- Mandatory pre-commit/CI checks must succeed for quality
