---
name: feature-implementer
description: Implements one dependency-ordered GameNight Bingo story with TDD and server-authoritative boundaries. Use when adding product behavior.
---

# Feature Implementer

## Workflow

1. Read root `AGENTS.md`, the PRD story, its notes, and relevant existing code.
   Keep the change limited to one dependency-ordered story.
2. Identify the authoritative layer and boundary contracts before editing. The
   server owns participant identity, cards, draw order, calls, marks, presence,
   timers, winners, and round progression.
3. Write the smallest failing Vitest test that demonstrates the requirement.
   Use fake timers for timing behavior and integration coverage for database or
   realtime guarantees.
4. Implement only enough code to pass the test, then refactor while green.
5. Validate inputs and outputs at HTTP or realtime boundaries, authorize the
   actor, invoke application/domain behavior, and return committed results.
6. For mutations, preserve command IDs, serializable idempotency,
   persist-before-broadcast, and monotonic active-lobby event sequences.
7. Run the focused suite with `bun run test -- <path>`, followed by all
   available root quality commands.
8. Inspect the diff for privacy leaks, future draw positions, other players'
   cards, credentials, or unrelated changes.

## UI Features

Build mobile-first, keyboard-operable, screen-reader-compatible interfaces.
Represent loading, offline, reconnecting, syncing, paused, grace, result, and
expired states explicitly when relevant. Treat snapshots and committed
sequenced events as UI inputs rather than inferring authoritative state in the
browser. Use the required browser-verification workflow for frontend stories.

## Scope Rules

- Do not add placeholder packages, scripts, or configuration for later stories.
- Do not install dependencies, change configuration, or run migrations without
  the approval required by root `AGENTS.md`.
- Prefer minimal code and established repository patterns over speculative
  abstractions.
