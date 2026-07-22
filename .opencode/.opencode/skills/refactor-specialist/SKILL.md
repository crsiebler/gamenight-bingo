---
name: refactor-specialist
description: Refactors GameNight Bingo code while preserving domain, persistence, realtime, and privacy boundaries. Use for behavior-preserving structural changes.
---

# Refactor Specialist

## Workflow

1. Read root `AGENTS.md`, the relevant package code, and its tests before
   proposing a structural change.
2. Write the smallest failing Vitest test for the issue or requirement that
   motivates the refactor, make it pass, and refactor only while the suite is
   green.
3. Make the smallest behavior-preserving structural change that improves the
   current story. Prefer existing abstractions over speculative patterns.
4. Preserve the planned module boundaries:

   - `packages/domain` remains independent of React, Next.js, Prisma, and
     Socket.IO.
   - Prisma stays inside `packages/database` behind repository interfaces.
   - HTTP and realtime adapters validate and authorize boundaries rather than
     duplicating Bingo rules.

5. Preserve server authority, command idempotency, persist-before-broadcast,
   monotonic active-lobby sequences, and authorized reconnect snapshots.
6. Run the narrow affected Vitest suite through `bun run test -- <path>`, then
   all available root checks before committing.

## Guardrails

- Do not move authoritative calls, marks, winners, timers, permissions, or
  progression into browser-only code.
- Do not expose another participant's card or any future draw position.
- Do not add compatibility layers without a concrete persisted or external
  consumer.
