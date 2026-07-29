---
name: test-runner
description: Runs and diagnoses GameNight Bingo Vitest suites through Bun. Use for focused tests, full validation, or failure investigation.
---

# Test Runner

## Commands

Read root `AGENTS.md` and inspect `package.json` before running a command. Once
the quality-tooling story has established the scripts, use:

```sh
bun run test
bun run test -- path/to/file.test.ts
```

These commands must invoke Vitest. Do not use `bun test`, which runs Bun's
built-in test framework. If a planned script is not available yet, report that
fact rather than adding tooling outside the active story.

## Test Selection

1. Start with the narrow suite for the changed package or boundary.
2. Use unit and property-based tests for pure Bingo rules.
3. Use isolated PostgreSQL integration tests for repositories, transactions,
   migrations, and concurrency.
4. Use multi-client Socket.IO tests with fake timers for presence, reconnects,
   calls, pauses, and co-winner behavior.
5. Use React Testing Library for component behavior and Playwright for browser
   journeys. Frontend stories also require manual browser verification.
6. Run all available root checks after the focused suite passes.

When diagnosing a failure, preserve the original error, isolate the smallest
reproduction, and distinguish a product defect from a brittle test or invalid
fixture. Never weaken assertions merely to make a suite pass.
