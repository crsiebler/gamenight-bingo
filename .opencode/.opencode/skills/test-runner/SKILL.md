---
name: test-runner
description: Executes tests, analyzes coverage, and debugs test failures in JavaScript/TypeScript repositories using Vitest.
---

## What I do

- Run the Vitest test suite (all or individual files)
- Generate and analyze code coverage reports
- Help debug failing tests and explain error outputs
- Advise on common test/data setup patterns for JS/TS
- Assess code quality using coverage and test output

## When to use me

Use this when you need to execute tests, check coverage, or troubleshoot test failures in a JavaScript/TypeScript project using Vitest. This includes running all tests, single test files, or debugging specific test issues.

## Procedure

1. (Optional) Ensure correct Node version (`nvm use` if required by project)
2. Run all tests: `npm test`
3. Run tests with coverage: `npm test -- --coverage` or `npx vitest run --coverage`
4. Review code coverage summary in the console and open the coverage report (e.g., `coverage/index.html` in your browser)
5. To run a specific test file: `npx vitest run path/to/file.test.ts`
6. Debug failures by reviewing Vitest error messages and stack traces
7. Fix code or tests based on issues identified by Vitest outputs

## Related Guidelines

- Follow test naming and structure conventions in this project
- Use mocks, test doubles, and setup/teardown in Vitest (`beforeEach`, `afterAll`, etc.)
- Ensure pre-commit checks (e.g., lint-staged, husky, eslint) pass before commits
- Refer to AGENTS.md for organizational and style conventions
