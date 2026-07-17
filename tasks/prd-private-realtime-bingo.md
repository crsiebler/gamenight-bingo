# PRD: Private Realtime 75-Ball Bingo

## Introduction/Overview

Build a private, Internet-hosted 75-ball Bingo application for friends and family. A host creates a lobby, chooses a theme, pattern, and manual or automatic call mode, then shares a short lobby code or invite URL. Players join from their own devices with a lobby-unique username. Accounts and chat are not required.

The server is authoritative for identity, presence, cards, draw order, calls, daubs, progress, winners, and round progression. A Secure HttpOnly SameSite cookie supports same-device rejoin to an active lobby for two minutes after disconnection. Reconnecting clients receive a complete authoritative snapshot. Durable state and idempotent commands must let one realtime process restart without repeating balls or diverging clients.

The TypeScript modular monolith uses Next.js 16 App Router, React 19, Tailwind CSS 4, a separate long-lived Node.js Socket.IO authority, PostgreSQL 16, Prisma behind repository interfaces, Zod contracts, and Bun scripts. Docker Compose supplies local PostgreSQL and an optional future Redis profile; web and game-server processes normally run through Bun outside Docker. The intended hosted architecture is one Railway realtime instance and one PostgreSQL database.

This PRD is written for junior developers and autonomous agents. Stories are dependency ordered and sized for one focused session. During implementation, dependency installation, dependency changes, configuration changes, and database migrations require confirmation under workspace policy.

## Goals

- Deliver complete private host and player journeys on current desktop and mobile browsers without accounts.
- Support explicit `manual | automatic` calling; automatic intervals are exactly 5, 10, 30, 60, or 120 seconds.
- Enforce standard 75-ball cards, unique cards per round, and a cryptographic nonrepeating draw order.
- Keep calls, daubs, presence, pauses, co-winners, and progression durable and server-authoritative.
- Restore exact active-lobby state from an authoritative snapshot after reconnect or single-instance restart.
- Encode, document, preview, and golden-test every approved source pattern without runtime/documentation drift.
- Provide all approved themes while preserving legibility, accessibility, privacy, and asset budgets.
- Make core gameplay keyboard-operable and screen-reader usable.
- Keep normal committed call-to-render latency below 250 ms.
- Ship with no critical security or accessibility findings and complete final product-owner acceptance.

## User Stories

### US-001: Commit the authorized project baseline

**Description:** As a developer, I want the intentional current repository state committed before implementation so that future work starts from a clean baseline.

**Acceptance Criteria:**

- [ ] Record that the user explicitly authorized retaining the deleted outdated Next.js scaffold, added PDFs under `docs/`, AI skills under `.opencode/`, and this PRD.
- [ ] Inspect `git status`, `git diff`, and `git log --oneline -10` before staging.
- [ ] Preserve all authorized deletions and additions; do not restore the old scaffold or remove the new files.
- [ ] Stage only the intended current baseline changes after verifying no secrets or unrelated files are included.
- [ ] Commit the baseline before any implementation with exactly `chore(project): establish clean project baseline`.
- [ ] Do not perform this commit while drafting or revising the PRD; this criterion instructs the later implementation workflow.
- [ ] No tests or typecheck are required because application code was intentionally removed.

### US-002: Create the project README

**Description:** As a contributor, I want a complete `README.md` so that I can understand and run the project.

**Acceptance Criteria:**

- [ ] Document the product/MVP, architecture, and prerequisites: Bun, Node.js, Docker with Compose, and authenticated GitHub CLI.
- [ ] Document setup, environment variables and defaults, Docker commands, web/game-server development commands, checks, and tests.
- [ ] Explain the workspace, pattern/theme packages, realtime snapshots/reconnect behavior, privacy/security, contributing rules, and `<type>(<scope>): <description>` commits.
- [ ] Include troubleshooting for unhealthy PostgreSQL, occupied ports, invalid environment configuration, unauthenticated `gh`, Socket.IO connection failures, and cleared cookies.
- [ ] Documentation link and command checks pass.
- [ ] Typecheck passes.

**Recommended Agents:** @documentation-engineer

### US-003: Add local Docker infrastructure

**Description:** As a developer, I want reproducible local data services so that application processes can run consistently.

**Acceptance Criteria:**

- [ ] After configuration confirmation, create `compose.yaml` with PostgreSQL 16, a named data volume, healthcheck, and configurable host port, database, username, and password.
- [ ] Add Redis only under an optional Compose profile reserved for future work; no MVP code or default command depends on Redis.
- [ ] Keep web and game-server processes running through Bun outside Docker by default.
- [ ] Document `docker compose up -d`, `docker compose ps`, and `docker compose down` in the README.
- [ ] Do not install dependencies or change configuration without required confirmation during execution.
- [ ] Compose configuration and PostgreSQL health tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @devops-engineer, @database-administrator

### US-004: Add project implementation guidance

**Description:** As a contributor, I want root agent guidance so that implementation rules are unambiguous.

**Acceptance Criteria:**

- [ ] Create root `AGENTS.md` covering overview, commands, domain boundaries, HTTP/realtime conventions, TDD, UI, accessibility, security/privacy, migrations, local operations, and confirmation requirements.
- [ ] Document persist-before-broadcast, command IDs, active-lobby event sequences, snapshot reconnects, and conventional commits.
- [ ] Documentation checks pass.
- [ ] Typecheck passes.

**Recommended Agents:** @documentation-engineer

### US-005: Rewrite project-local skills

**Description:** As an autonomous agent, I want project-specific skills so that generated work follows repository conventions.

**Acceptance Criteria:**

- [ ] Review skills under `.opencode/.opencode/skills` and make them relevant to Bingo after approval.
- [ ] Use Bun and Vitest, remove calculator and unrelated npm examples, and point to root `AGENTS.md`.
- [ ] Preserve user-authored content outside the approved scope.
- [ ] Skill reference and documented-command tests pass.
- [ ] Typecheck passes.

### US-006: Establish the modular workspace

**Description:** As a developer, I want clear package boundaries so that concerns remain separated.

**Acceptance Criteria:**

- [ ] After configuration confirmation, create `apps/web`, `apps/game-server`, and `packages/contracts`, `domain`, `database`, `patterns`, `themes`, `ui`, and `test-support`.
- [ ] Configure Bun workspace scripts and strict TypeScript; install/change dependencies only after confirmation.
- [ ] Mechanically prevent domain imports of React, Next.js, Prisma, and Socket.IO.
- [ ] Workspace-boundary tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @build-engineer, @typescript-pro

### US-007: Configure quality tooling and Git hooks

**Description:** As a developer, I want consistent checks so that defects are caught early.

**Acceptance Criteria:**

- [ ] After approval, configure ESLint flat config, Prettier with the Tailwind plugin, Vitest, React Testing Library, and Playwright.
- [ ] Use Vitest rather than Bun's built-in test framework.
- [ ] Preserve the Husky pre-commit script exactly: `npx lint-staged || exit 1`, `npx tsc --noEmit || exit 1`, `bun run test || exit 1`.
- [ ] Fixture violations prove each configured check can fail.
- [ ] Tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @build-engineer, @test-automator

### US-008: Define and validate runtime configuration

**Description:** As an operator, I want validated defaults so that every process uses the same limits and timing.

**Acceptance Criteria:**

- [ ] Define code defaults: `MAX_PLAYERS_PER_LOBBY=25`, `MAX_ACTIVE_LOBBIES=100`, `LOBBY_IDLE_TTL_SECONDS=1800`, `PLAYER_RECONNECT_WINDOW_SECONDS=120`, `DISCONNECT_PAUSE_GRACE_SECONDS=10`, `REALTIME_TICKET_TTL_SECONDS=60`, and `CO_WINNER_WINDOW_MS=2000`.
- [ ] Allow environment overrides and validate all values at process startup with actionable, secret-free errors.
- [ ] Reject nonintegers, unsafe ranges, and inconsistent timing values before serving traffic.
- [ ] Share parsed configuration types without allowing domain code to read process environment directly.
- [ ] Default, override, and invalid-startup tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @backend-developer, @security-engineer

### US-009: Define shared contracts

**Description:** As a developer, I want versioned Zod contracts so that every boundary agrees on data shapes.

**Acceptance Criteria:**

- [ ] Define branded IDs and schemas for lobby/round state, participant session, cards, marks, calls, presence, timers, two-second co-winner results, snapshots, commands, and errors.
- [ ] Model call configuration as `{ mode: "manual" } | { mode: "automatic"; intervalSeconds: 5 | 10 | 30 | 60 | 120 }`.
- [ ] Include command IDs, schema versions, timestamps, and monotonic active-lobby event sequences where required.
- [ ] Define no event-history retrieval endpoint or realtime command.
- [ ] Parsing and malformed-payload tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @api-designer, @typescript-pro

### US-010: Document the canonical pattern catalog

**Description:** As a developer, I want human-reviewable canonical pattern documentation before runtime encoding.

**Acceptance Criteria:**

- [ ] Create `docs/bingo-pattern-catalog.md` with mask notation, exact/flexible classification, center behavior, duplicate masks, source aliases, PDF page/diagram references, and the rule against implicit rotation/reflection/translation.
- [ ] Include every source pattern from all four supplied PDFs and document `Full House` only as the source PDF alias for runtime/user-facing Blackout.
- [ ] Record these confirmed masks exactly, using slash-separated rows:
  - Q `#####/#...#/#...#/#..##/#####`
  - W `#...#/#...#/#.#.#/##.##/#...#`
  - 10 `#.###/#.#.#/#.#.#/#.#.#/#.###`
  - 11 `.#..#/##.##/.#..#/.#..#/.#..#`
  - 12 `#.###/#...#/#.###/#.#../#.###`
  - 13 `#.###/#...#/#.###/#...#/#.###`
  - 14 `#.#.#/#.#.#/#.###/#...#/#...#`
  - 15 `#.###/#.#../#.###/#...#/#.###`
  - 16 `#.###/#.#../#.###/#.#.#/#.###`
  - 17 `#.###/#.#.#/#...#/#...#/#...#`
  - 18 `#.###/#.#.#/#.###/#.#.#/#.###`
  - 19 `#.###/#.#.#/#.###/#...#/#...#`
- [ ] State that runtime canonical data later lives in `packages/patterns/src/catalog.ts` and generated/tested documentation must not diverge from it.
- [ ] Documentation completeness and mask-format tests pass.
- [ ] Typecheck passes.

### US-011: Generate valid Bingo cards

**Description:** As a player, I want a valid randomized card so that play follows 75-ball rules.

**Acceptance Criteria:**

- [ ] Generate a 5x5 B/I/N/G/O card using ranges 1-15, 16-30, 31-45, 46-60, and 61-75 with unique values per column.
- [ ] Make the center free and always satisfied; ensure cards are unique within a round.
- [ ] Accept injectable cryptographic randomness for deterministic tests.
- [ ] Unit and property-based invariant tests pass.
- [ ] Typecheck passes.

### US-012: Generate the draw order

**Description:** As a player, I want fair nonrepeating calls so that the round is valid.

**Acceptance Criteria:**

- [ ] Cryptographically shuffle every integer 1-75 exactly once.
- [ ] Commit exactly one next position and return a stable error when exhausted.
- [ ] Never expose uncalled positions to clients or logs.
- [ ] Unit and property-based permutation tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @security-engineer

### US-013: Implement canonical pattern semantics

**Description:** As a developer, I want runtime pattern data and matching rules so that wins are deterministic.

**Acceptance Criteria:**

- [ ] Implement `packages/patterns/src/catalog.ts` with stable ID, user-facing name, category, source reference/alias, version, mode, and 5x5 masks.
- [ ] Exact masks require every diagram cell, tolerate extra daubs, satisfy center, and never transform.
- [ ] One Line accepts any row, column, or diagonal; Two Lines accepts any two distinct lines, including intersecting lines; Blackout requires all noncenter cells.
- [ ] Provide only one runtime/user-facing Blackout entry for the source alias described in the documentation.
- [ ] A generated comparison test fails when documentation and runtime data diverge.
- [ ] Matcher, schema, and documentation parity tests pass.
- [ ] Typecheck passes.

### US-014: Encode and review shape patterns

**Description:** As a host, I want every approved shape available.

**Acceptance Criteria:**

- [ ] Encode Bunny Ears, Two Lines, Four Corners, Windmill, Outside Edge, Blackout, Airplane, Wine Glass, X, Turtle, Stairs, Bow Tie, Cross, Plus, Rectangle, Heart, Hat, Hour Glass, Pyramid, Checkerboard, Inside Square, Kite, Smiley Face, and Block of Nine from `docs/shapes-bingo-patterns.pdf`.
- [ ] Map both Two Lines diagrams to one flexible rule and map the PDF's alternate Blackout label through the documented source alias rather than a selectable entry.
- [ ] Complete cell-by-cell source review records.
- [ ] Count, ID, source, and mask tests pass.
- [ ] Typecheck passes.

### US-015: Preview and golden-test shapes

**Description:** As a reviewer, I want generated previews so that transcription errors are visible.

**Acceptance Criteria:**

- [ ] Generate thumbnails from canonical data and show name, ID, mode, source, and mask.
- [ ] Label both Two Lines diagrams as flexible-rule examples.
- [ ] Golden fixtures cover every runtime shape entry.
- [ ] Golden and thumbnail tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @frontend-developer, @test-automator

### US-016: Encode, preview, and test letters

**Description:** As a host, I want every approved letter pattern.

**Acceptance Criteria:**

- [ ] Encode A-Y from `docs/letter-bingo-patterns.pdf`, document Z as absent, and preserve Letter X/Letter O IDs independently of identical shape masks.
- [ ] Use the confirmed Q and W masks from canonical documentation.
- [ ] Generate source-linked thumbnails and golden fixtures for A-Y.
- [ ] Catalog, parity, golden, and thumbnail tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

### US-017: Encode, preview, and test numbers

**Description:** As a host, I want approved number patterns 0-19.

**Acceptance Criteria:**

- [ ] Encode 0-19 from `docs/number-bingo-patterns.pdf` with category-specific stable IDs.
- [ ] Use the confirmed 10-19 masks from canonical documentation without pending sign-off flags.
- [ ] Generate source-linked thumbnails and golden fixtures for every number.
- [ ] Catalog, parity, golden, and thumbnail tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

### US-018: Encode, preview, and test Christmas patterns

**Description:** As a host, I want the complete Christmas catalog.

**Acceptance Criteria:**

- [ ] Encode Christmas Tree, Tinsel, Reindeer, Skis, Wreath, Cross, Bell, Snow Boot, Mittens, Snow, Gift, and Snowmobile from `docs/christmas-bingo-patterns.pdf`.
- [ ] Preserve separate Christmas Cross and Christmas Snow IDs despite duplicate masks.
- [ ] Generate source-linked thumbnails and golden fixtures for every entry.
- [ ] Catalog, parity, golden, and thumbnail tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

### US-019: Audit the complete pattern catalog

**Description:** As a product owner, I want every source diagram accounted for before gameplay uses it.

**Acceptance Criteria:**

- [ ] Map every PDF diagram to a runtime entry, source alias, or flexible-rule example.
- [ ] Confirm distinct IDs for Cross/Plus/Christmas Cross, X/Letter X, Outside Edge/Letter O, and Checkerboard/Christmas Snow.
- [ ] Confirm Q, W, and 10-19 exactly match the approved masks and no transform/deduplication occurred.
- [ ] Audit fails for missing sources, IDs, aliases, parity, or golden fixtures.
- [ ] Catalog audit tests pass.
- [ ] Typecheck passes.

### US-020: Define the domain state machine

**Description:** As a developer, I want explicit states so that invalid commands cannot transition a game.

**Acceptance Criteria:**

- [ ] Define waiting, active, paused, co-winner-window, result, ended, and expired behavior.
- [ ] Permit One Line to Two Lines to Blackout only; Blackout and non-One-Line initial patterns are terminal.
- [ ] Model waiting/completed/abandoned inactivity and protect an active lobby with active calls or connections from expiry.
- [ ] Return stable errors for invalid transitions.
- [ ] State-transition tests pass.
- [ ] Typecheck passes.

### US-021: Model durable PostgreSQL state

**Description:** As an operator, I want active games to survive a realtime-process restart.

**Acceptance Criteria:**

- [ ] After migration confirmation, model lobbies, participants, hashed session tokens, rounds, cards, marks, draw order, calls, active-lobby events, command results, presence generations, co-winner sets, and inactivity timestamps.
- [ ] Add scoped uniqueness constraints for active codes, normalized usernames, cards, calls, sequences, and command IDs.
- [ ] Store no prior-round result history; keep Prisma in `packages/database` behind repository interfaces.
- [ ] PostgreSQL integration tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @postgres-pro, @database-optimizer

### US-022: Add serializable idempotent transactions

**Description:** As a player, I want concurrent commands to produce one deterministic state.

**Acceptance Criteria:**

- [ ] Use PostgreSQL Serializable transactions with bounded, observable retries.
- [ ] Persist state/events before broadcast and persist command results with monotonic active-lobby sequences.
- [ ] Duplicate command IDs return the original result without repeating effects.
- [ ] Concurrency, retry, ordering, and idempotency tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @postgres-pro, @backend-developer

### US-023: Generate secure lobby codes

**Description:** As a host, I want a short code that is easy to share.

**Acceptance Criteria:**

- [ ] Generate secure six-character codes from uppercase unambiguous Base32 excluding 0/O and 1/I.
- [ ] Normalize case-insensitive entry and retry collisions until unique among active lobbies.
- [ ] Treat codes only as locators and enforce the active-lobby limit.
- [ ] Property, normalization, collision, and limit tests pass.
- [ ] Typecheck passes.

### US-024: Normalize and reserve usernames

**Description:** As a participant, I want predictable lobby-unique naming.

**Acceptance Criteria:**

- [ ] Trim leading/trailing whitespace, collapse repeated internal whitespace, and retain the resulting original casing for display.
- [ ] Derive uniqueness as `username.trim().toLowerCase()` after whitespace collapse.
- [ ] Reject empty names and all control characters with stable validation errors.
- [ ] Enforce at most 25 participants using the configured default/override.
- [ ] Unicode, whitespace, collision, control-character, and limit tests pass.
- [ ] Typecheck passes.

### US-025: Issue same-device lobby sessions

**Description:** As a participant, I want a private same-device session without an account.

**Acceptance Criteria:**

- [ ] Issue an opaque Secure HttpOnly SameSite cookie and store only its cryptographic hash.
- [ ] Scope the session to the active lobby and prior participant; do not use device fingerprinting or collect unnecessary device attributes.
- [ ] If the cookie is missing or cleared, require joining as a new participant.
- [ ] Delete session data with the lobby.
- [ ] Cookie, hash, scope, and missing-cookie tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @security-engineer

### US-026: Implement two-minute same-device rejoin

**Description:** As a disconnected participant, I want to rejoin briefly from the same device.

**Acceptance Criteria:**

- [ ] During the configured 120-second window, a valid cookie offers `Rejoin as <username>` for the same active lobby.
- [ ] After 120 seconds, mark the participant departed, reject that cookie for the prior slot, and require a new join that waits for the next round when one is active.
- [ ] Do not support cross-device slot reclaim or reclaim of expired/deleted lobbies.
- [ ] Fake-timer, departed-slot, cleared-cookie, and active-round waiting tests pass.
- [ ] Typecheck passes.

### US-027: Implement lobby entry HTTP APIs

**Description:** As a client, I want versioned lobby endpoints.

**Acceptance Criteria:**

- [ ] Add `/api/v1` endpoints for pattern catalog, create lobby, join lobby, same-device session status/rejoin, and authorized snapshot.
- [ ] Apply normalized username uniqueness and independent create/join/rejoin rate limits.
- [ ] Return stable errors and `Cache-Control: no-store` for private responses.
- [ ] Define no endpoint for expired/old lobby restoration or event-history retrieval.
- [ ] HTTP contract, authorization, rate-limit, and privacy tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @api-designer, @security-engineer

### US-028: Issue single-use realtime tickets

**Description:** As a client, I want a temporary credential for one authenticated Socket.IO connection.

**Acceptance Criteria:**

- [ ] Issue a ticket through `/api/v1` using the HttpOnly cookie, scoped to one participant and lobby.
- [ ] Expire it after the configured 60 seconds and atomically consume it on one Socket.IO connection.
- [ ] Require a new ticket from the cookie for every reconnect.
- [ ] Never log ticket plaintext or return it in snapshots/errors.
- [ ] Expiry, single-use, scope, reconnect, and redaction tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @security-engineer, @websocket-engineer

### US-029: Implement round-control HTTP APIs

**Description:** As a client, I want versioned fallback command endpoints.

**Acceptance Criteria:**

- [ ] Add configure, create/start/pause/resume/call-next/continue/end round, and own-card mark endpoints.
- [ ] Require command IDs, enforce host/own-card authorization, and return the committed sequence/idempotent result.
- [ ] Validate manual versus automatic configuration and reject unsupported intervals.
- [ ] Contract and authorization tests pass.
- [ ] Typecheck passes.

### US-030: Establish authenticated Socket.IO

**Description:** As a participant, I want secure low-latency updates.

**Acceptance Criteria:**

- [ ] Run a separate long-lived Node.js Socket.IO authority authenticated by a consumed realtime ticket.
- [ ] Support versioned heartbeat, configure, round-control, mark, and resync commands.
- [ ] Support full snapshot, presence, call, mark result, near-win, co-winner, stage, round-end, ack, and error events; define no chat or event-history retrieval command.
- [ ] Authentication and contract tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @websocket-engineer, @security-engineer

### US-031: Restore authoritative snapshots

**Description:** As a reconnecting participant, I want exact active state restored.

**Acceptance Criteria:**

- [ ] Send a full authorized snapshot after every reconnect except transport-level recovery of a very brief interruption.
- [ ] Restore exact own card, marks, calls, stage, participants, call mode/timer, pause reason, and result.
- [ ] Use event sequences only for active connection ordering/idempotency and discard them with the lobby.
- [ ] Never expose another player's card or future draw positions.
- [ ] Disconnect and single-process-restart snapshot tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @websocket-engineer, @test-automator

### US-032: Aggregate participant presence

**Description:** As a host, I want presence to count people rather than tabs.

**Acceptance Criteria:**

- [ ] Track authenticated heartbeats and aggregate all connections for one session as one participant.
- [ ] Mark absence only after the last connection is gone and persist presence generations.
- [ ] Broadcast sequenced presence changes.
- [ ] Multi-client and multiple-tab tests pass.
- [ ] Typecheck passes.

### US-033: Pause after participant absence

**Description:** As a disconnected participant, I want calling paused after a grace period.

**Acceptance Criteria:**

- [ ] Apply configured 10-second grace after the last connection and pause if absence remains.
- [ ] Host absence always pauses and cannot be overridden.
- [ ] Reconnect never automatically resumes; persist pause reason and generation.
- [ ] Fake-timer and multi-client tests pass.
- [ ] Typecheck passes.

### US-034: Override a current player absence

**Description:** As a host, I want to override one normal player's current absence generation.

**Acceptance Criteria:**

- [ ] Permit only host-authorized override of a normal player's current generation, never host absence.
- [ ] Reconnect then disconnect creates a new generation unaffected by an old override.
- [ ] Override does not resume calls automatically.
- [ ] Generation and authorization tests pass.
- [ ] Typecheck passes.

### US-035: Configure call mode and create a round

**Description:** As a host, I want manual or automatic calling with a valid configuration.

**Acceptance Criteria:**

- [ ] Accept `{ mode: "manual" }` with no interval and `{ mode: "automatic", intervalSeconds }` only for 5, 10, 30, 60, or 120.
- [ ] Reject a manual interval, a missing automatic interval, and every unsupported interval.
- [ ] Default pattern to One Line and transactionally generate unique cards/private order for joined players.
- [ ] Configuration and round-creation tests pass.
- [ ] Typecheck passes.

### US-036: Queue players joining active rounds

**Description:** As a late player, I want to wait safely for the next round.

**Acceptance Criteria:**

- [ ] Mark active-round joiners as waiting with no card, mark, or win eligibility.
- [ ] Show only authorized lobby/game state and include them in the next round.
- [ ] Apply the same behavior to a participant joining anew after the two-minute window.
- [ ] Late-join integration tests pass.
- [ ] Typecheck passes.

### US-037: Call balls manually and automatically

**Description:** As a host, I want reliable calls in either mode.

**Acceptance Criteria:**

- [ ] Manual mode never schedules and advances only through host `Call Next`.
- [ ] Automatic mode schedules from its validated interval; host `Call Next` remains idempotent and cannot race the timer into duplicate positions.
- [ ] Persist call/history before broadcast; block calls while paused, in the co-winner window, ended, or exhausted.
- [ ] Recover automatic timing after one realtime-process restart without repeating a ball.
- [ ] Timer, manual-mode, concurrency, restart, and no-repeat tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @backend-developer, @test-automator

### US-038: Validate and persist daubs

**Description:** As a player, I want valid marks to survive reconnects.

**Acceptance Criteria:**

- [ ] Mark only called numbers on the authenticated player's active card; center remains satisfied.
- [ ] Make repeated mark commands idempotent and persist valid marks before mark-result broadcast.
- [ ] Stable errors make no state change.
- [ ] Validation, authorization, and persistence tests pass.
- [ ] Typecheck passes.

### US-039: Calculate progress and near-win

**Description:** As a player, I want optional feedback when one required called number remains.

**Acceptance Criteria:**

- [ ] Calculate from authoritative calls/marks for exact and flexible patterns.
- [ ] Define near-win as exactly one required called number away and emit it privately.
- [ ] Disabling feedback does not alter winner validation.
- [ ] Matcher and near-win tests pass.
- [ ] Typecheck passes.

### US-040: Settle the two-second co-winner window

**Description:** As a player, I want completions from the latest call resolved fairly.

**Acceptance Criteria:**

- [ ] The first valid completion immediately pauses calls and opens the configured 2000 ms two-second co-winner window.
- [ ] Include all valid completions attributable to the same latest called ball that arrive during the window.
- [ ] Permit no call during the window; persist and broadcast the complete winner set after it closes.
- [ ] Use deterministic ordering for presentation without excluding co-winners.
- [ ] Fake-timer and multi-client co-winner tests pass.
- [ ] Typecheck passes.

### US-041: Continue One Line rounds

**Description:** As a host, I want to continue One Line to Two Lines and Blackout.

**Acceptance Criteria:**

- [ ] Offer end or Two Lines after One Line and end or Blackout after Two Lines.
- [ ] Preserve cards, daubs, calls, history, and draw order; clear only stage winner state.
- [ ] Blackout and every non-One-Line initial exact pattern end on win.
- [ ] Progression tests pass.
- [ ] Typecheck passes.

### US-042: Start another round without result history

**Description:** As a host, I want a fresh round in the same lobby.

**Acceptance Criteria:**

- [ ] Retain eligible participants and include waiting players.
- [ ] Generate new cards/order and empty daubs/history.
- [ ] Replace the previous result state rather than offering prior-round history.
- [ ] New-round tests pass.
- [ ] Typecheck passes.

### US-043: Expire inactive lobbies

**Description:** As a participant, I want private data minimized after a lobby is abandoned or complete.

**Acceptance Criteria:**

- [ ] Delete waiting, completed, or abandoned lobbies after configured 1800 seconds without qualifying activity.
- [ ] Never delete a currently active lobby with active calls or connections.
- [ ] Cascade deletion to cards, marks, calls, active-lobby events, sessions, participants, and related state.
- [ ] Provide no restoration of expired/old lobbies and make cleanup idempotent/observable.
- [ ] Inactivity, active-protection, cascade, and retry tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @postgres-pro, @security-engineer

### US-044: Adapt GroundsControl references into accessible UI foundations

**Description:** As a frontend developer, I want reviewed reference concepts adapted locally without a runtime dependency.

**Acceptance Criteria:**

- [ ] Run `gh auth status` before attempting access and stop with actionable guidance if GitHub CLI is not authenticated.
- [ ] Review these exact pages:
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/components/atoms/Button/Button.tsx`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/components/atoms/Text/Text.tsx`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/components/atoms/TextArea/TextArea.tsx`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/components/atoms/Select/Select.tsx`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/components/atoms/Select/Option.tsx`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/components/atoms/LinkButton/LinkButton.tsx`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/components/atoms/Input/Input.tsx`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/components/atoms/JsonLd/JsonLd.tsx`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/eslint.config.mjs`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/tsconfig.json`
  - `https://github.com/crsiebler/groundscontrol.com/blob/main/.prettierrc`
- [ ] Fetch raw private content only with the authenticated pattern `gh api "repos/crsiebler/groundscontrol.com/contents/<path>?ref=main" -H "Accept: application/vnd.github.raw+json"`.
- [ ] Adapt concepts into local atoms/molecules/organisms/templates/pages, correct semantic/accessibility issues, and add no GroundsControl runtime dependency.
- [ ] Configure aliases `@/atoms`, `@/molecules`, `@/organisms`, `@/templates`, `@/lib`, and `@`.
- [ ] Component and accessibility tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @react-specialist, @accessibility-tester

### US-045: Build public landing and create flow

**Description:** As a host, I want to create a lobby from a clear public page.

**Acceptance Criteria:**

- [ ] Build mobile-first landing/create UI with host username, theme, pattern defaulted to One Line, and call mode.
- [ ] Use an accessible Select or button group: manual shows no interval; automatic limits choices to 5/10/30/60/120.
- [ ] Add public WebApplication/SoftwareApplication JsonLd matching visible HowTo content with no private data.
- [ ] Form, configuration, metadata, and accessibility tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @nextjs-developer, @accessibility-tester

### US-046: Build join and same-device rejoin flows

**Description:** As a player, I want to enter a spoken code or rejoin from the same device.

**Acceptance Criteria:**

- [ ] Support typed/pasted case-insensitive code entry and normalized username with accessible errors.
- [ ] Offer `Rejoin as <username>` only while the valid cookie remains within the two-minute window.
- [ ] After departure, missing cookie, or cleared cookie, show new join; active-round new players wait.
- [ ] Invite URLs prefill code but never authenticate identity.
- [ ] Form, timer, privacy, and accessibility tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

### US-047: Build sharing and lobby pages

**Description:** As a participant, I want clear sharing, presence, and readiness.

**Acceptance Criteria:**

- [ ] Provide large code, Copy Code, Copy Invite URL, native share when available, and accessible fallbacks; URLs contain no credentials.
- [ ] Show each participant once with host, connected, grace, absent, departed, and waiting states.
- [ ] Show theme, pattern, call mode/interval, and host-only configuration/start controls.
- [ ] Mark private pages `noindex`, `nofollow`, `noarchive`, and `no-store`.
- [ ] Clipboard, presence, authorization, and accessibility tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

### US-048: Build the accessible Bingo card

**Description:** As a player, I want touch, keyboard, and screen-reader marking.

**Acceptance Criteria:**

- [ ] Render semantic B/I/N/G/O headers and 25 related cells with free, called, marked, uncalled, and unavailable text semantics.
- [ ] Support keyboard navigation/activation, visible focus, mobile touch targets, and no color-only meaning.
- [ ] Reject uncalled daubs with clear feedback.
- [ ] Component, keyboard, and accessibility tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @react-specialist, @accessibility-tester

### US-049: Build live call and status UI

**Description:** As a participant, I want calls and connection state to remain clear.

**Acceptance Criteria:**

- [ ] Show current letter/number, chronological call grid, pattern preview/progress, call mode, and automatic countdown when applicable.
- [ ] Announce only new calls in a controlled live region and apply sequenced events idempotently.
- [ ] Show connected, reconnecting, offline, snapshot-syncing, grace, paused, co-winner-window, and recovered states.
- [ ] Identify pause reason and explain that reconnect does not resume calls.
- [ ] UI, sequence, timer, and accessibility tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

### US-050: Build live host controls

**Description:** As a host, I want safe controls for valid round actions.

**Acceptance Criteria:**

- [ ] Show start, pause, resume, Call Next, continue, end, and player-absence override only when authorized/valid.
- [ ] In manual mode make Call Next the sole advance path; in automatic mode show interval/countdown and still prevent duplicate pending commands.
- [ ] Disable controls through ack/error, label continuation target, never override host absence, and confirm end-round.
- [ ] UI, authorization, mode, and command tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @frontend-developer, @accessibility-tester

### US-051: Build winner and result states

**Description:** As a participant, I want clear and respectful outcomes.

**Acceptance Criteria:**

- [ ] Show the two-second co-winner window before displaying the complete co-winner set.
- [ ] Provide celebratory winner and respectful other-player result scenes with valid continuation/end actions.
- [ ] Communicate outcomes without depending on sound, motion, or color and expose no previous-round browser.
- [ ] Result, progression, and accessibility tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

### US-052: Add privacy notice and expired state

**Description:** As a participant, I want clear data-minimization behavior.

**Acceptance Criteria:**

- [ ] Explain that private lobbies use a necessary same-device cookie, collect no unnecessary device data, and use no third-party analytics on private routes.
- [ ] Explain the two-minute rejoin window, 30-minute inactive-lobby deletion, and deletion of associated game/session data.
- [ ] Show a terminal expired state with new-lobby/join navigation and no old-lobby restoration action.
- [ ] Keep notice concise, accessible, and consistent with actual cookie/data behavior.
- [ ] Privacy-copy, expired-state, analytics-absence, and accessibility tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @security-engineer, @accessibility-tester

### US-053: Define theme moodboards and tokens

**Description:** As a designer, I want a legible foundation for every approved theme.

**Acceptance Criteria:**

- [ ] Define moodboards and semantic palettes for Animals, Nature, original generic Superheroes, Pirates, Ghosts, Sports, Christmas, Halloween, July 4th, Valentine's Day, and Birthday.
- [ ] Specify card, text, focus, state, ball, and result tokens plus high-contrast/reduced-motion behavior.
- [ ] Document original, respectful, non-infringing direction.
- [ ] Contrast-token tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @ui-designer, @accessibility-tester

### US-054: Create themed visual assets

**Description:** As a player, I want original themed visuals without reduced clarity.

**Acceptance Criteria:**

- [ ] Create original vector daubers/icons, optional efficient sprite sheets, call-ball treatments, card decoration, and win/other-player-won scenes for every theme.
- [ ] Include suitable hero swoop, floating ghost, cartoon pirate cannon/walk-plank, and baseball strikeout concepts without protected assets or hostile loss treatment.
- [ ] Provide static, reduced-motion, high-contrast, and decorative-load-failure fallbacks.
- [ ] Keep active selected-theme visuals at or below 500 KB compressed and lazy-load nonselected themes.
- [ ] Visual, contrast, budget, and fallback tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

### US-055: Produce and integrate theme audio

**Description:** As a participant, I want optional controlled theme sounds.

**Acceptance Criteria:**

- [ ] Provide original/licensed call, daub, near-win, win, and respectful other-player-won audio per theme.
- [ ] Achieve consistent perceived volume with no clipping; no formal LUFS certification is required.
- [ ] Start only after user gesture, provide persistent mute/volume, keep selected-theme audio at or below 1 MB after opt-in, and lazy-load nonselected themes.
- [ ] Core gameplay works when audio fails and meaning never depends on sound.
- [ ] Audio gating, budget, mute, volume, and fallback tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

### US-056: Optimize and document assets

**Description:** As a maintainer, I want fast, traceable assets.

**Acceptance Criteria:**

- [ ] Create suitable AVIF/WebP variants and document fallbacks.
- [ ] Record source, author, license, modification, and approval for every nongenerated asset.
- [ ] Enforce 500 KB selected-theme visual and 1 MB opt-in audio budgets, lazy loading, and decorative failure behavior in automated checks.
- [ ] Budget, fallback, and provenance tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @performance-engineer

### US-057: Add gameplay, browser, and recovery test suites

**Description:** As a developer, I want cross-layer regressions detected automatically.

**Acceptance Criteria:**

- [ ] Add unit/property tests for cards, draws, patterns, progress, modes, co-winners, expiry, and transitions.
- [ ] Add PostgreSQL tests for repositories/transactions and Socket.IO multi-client tests for tickets, snapshots, presence, pause, co-winners, and restart.
- [ ] Add Playwright host/player journeys for the latest two stable Chrome, Edge, Firefox, and Safari plus current iOS Safari and Android Chrome, using available browser/device automation and documented manual coverage where Playwright cannot execute a native engine.
- [ ] All test suites pass.
- [ ] Typecheck passes.

**Recommended Agents:** @test-automator, @websocket-engineer

### US-058: Add accessibility and theme regression tests

**Description:** As a disabled user, I want every theme and core journey usable.

**Acceptance Criteria:**

- [ ] Test keyboard create/join/lobby/card/host/result flows and names, roles, live regions, focus, and errors.
- [ ] Audit all page states and every theme's text, card, dauber, focus, result, high-contrast, reduced-motion, mute, and asset-failure behavior.
- [ ] No critical accessibility violation remains.
- [ ] Accessibility and visual tests pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @accessibility-tester, @test-automator

### US-059: Harden security and privacy

**Description:** As a participant, I want private identity and game state protected.

**Acceptance Criteria:**

- [ ] Validate/limit all inputs and enforce host, participant, own-card, lobby, and round authorization.
- [ ] Add origin, CSRF, cookie, transport, header, cache, enumeration, and rate-limit protections.
- [ ] Redact session tokens, realtime tickets, private cards, and future draw order from diagnostics.
- [ ] Verify no third-party analytics execute on private routes and no unnecessary device attributes are persisted.
- [ ] No critical security finding remains.
- [ ] Injection, bypass, ticket-reuse, rate-limit, privacy, and leak tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @security-engineer, @security-auditor

### US-060: Verify single-instance load and latency

**Description:** As an operator, I want measured performance for the intended MVP architecture.

**Acceptance Criteria:**

- [ ] Test defaults of 25 players per lobby and 100 active lobbies against one realtime instance and one PostgreSQL database.
- [ ] Measure commit-to-render, command-to-commit, and snapshot reconnect percentiles.
- [ ] Meet normal committed call-to-render below 250 ms with no repeated balls, dropped committed events, or divergent snapshots.
- [ ] Load and performance tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @performance-engineer, @test-automator

### US-061: Add basic health and privacy-safe logging

**Description:** As an operator, I want enough diagnostics for a single-instance MVP without collecting private data.

**Acceptance Criteria:**

- [ ] Add basic health/readiness endpoints for web, game server, and PostgreSQL dependency state.
- [ ] Add structured correlation logs for commands, event sequences, transaction retries, disconnect pauses, and restart restoration.
- [ ] Exclude session tokens, realtime tickets, cards, future draw order, and unnecessary device data.
- [ ] Health and redaction tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @sre-engineer, @security-engineer

### US-062: Verify single-instance restart behavior

**Description:** As a participant, I want an active game to survive a realtime-process restart.

**Acceptance Criteria:**

- [ ] Restart the one realtime process in an automated nonproduction test while PostgreSQL remains available.
- [ ] Reconnect clients with new single-use tickets and full snapshots.
- [ ] Prove exact cards, marks, calls, stage, call mode, pause state, and co-winner result are restored without repeated calls.
- [ ] Restart integration tests pass.
- [ ] Typecheck passes.

**Recommended Agents:** @test-automator, @websocket-engineer

### US-063: Prepare final manual acceptance handoff

**Description:** As a product owner, I want a concise manual checklist after automated checks pass so that I can accept the MVP.

**Acceptance Criteria:**

- [ ] Prepare a checklist for create/join, manual calls, automatic calls at each allowed interval, no repeats, daubing, and near-win.
- [ ] Cover the two-second co-winner window, One Line to Two Lines to Blackout, and a terminal exact pattern.
- [ ] Cover disconnect pause, two-minute same-device rejoin, departed/new waiting player behavior, and single-instance restart restoration.
- [ ] Cover desktop/mobile, keyboard/screen-reader basics, every theme, mute/volume, reduced motion, high contrast, and decorative-asset failure.
- [ ] Record prerequisite automated commands and require them to pass before handoff.
- [ ] Product owner performs and records final manual acceptance; implementation agents do not self-approve it.
- [ ] Handoff documentation checks pass.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @test-automator, @accessibility-tester

## Functional Requirements

1. **FR-001:** Hosts and players create/join private lobbies without accounts; no chat is provided.
2. **FR-002:** Lobby codes are secure, unique among active lobbies, six uppercase case-insensitive unambiguous Base32 characters excluding 0/O and 1/I.
3. **FR-003:** Codes/invite URLs locate lobbies but do not authenticate identity; create, join, rejoin, and ticket issuance are rate-limited.
4. **FR-004:** The UI supports spoken entry, Copy Code, Copy Invite URL, and native share with fallback.
5. **FR-005:** Username display is the trimmed, whitespace-collapsed original; uniqueness is its lowercase form; empty/control-character names are rejected.
6. **FR-006:** Default capacity is 25 players per lobby and 100 active lobbies, configurable through validated environment values.
7. **FR-007:** An opaque Secure HttpOnly SameSite cookie, stored server-side only as a hash, identifies a prior participant in one active lobby.
8. **FR-008:** No device fingerprinting, unnecessary device collection, cross-device slot reclaim, or third-party private-route analytics is permitted.
9. **FR-009:** A valid same-device cookie offers `Rejoin as <username>` for 120 seconds after disconnect.
10. **FR-010:** After 120 seconds the participant is departed and the old slot cannot be reclaimed; missing/cleared cookies require a new join.
11. **FR-011:** New joins during an active round, including post-window former participants, wait for the next round.
12. **FR-012:** Realtime tickets expire after 60 seconds, are single-use for one participant/lobby Socket.IO connection, are reacquired through the cookie, and are never logged.
13. **FR-013:** Authenticated heartbeats aggregate multiple tabs as one participant.
14. **FR-014:** Losing all connections starts a configurable 10-second grace, after which absence pauses calls.
15. **FR-015:** Host absence cannot be overridden; host may override only a normal player's current absence generation.
16. **FR-016:** Reconnect/override never resumes calls automatically; a new disconnect creates a new generation.
17. **FR-017:** Every reconnect normally receives a complete authorized snapshot; only very brief Socket.IO transport interruption may use transport recovery.
18. **FR-018:** Event sequences provide active-connection ordering/idempotency and are deleted with the lobby; application event-history retrieval is not supported.
19. **FR-019:** Runtime defaults are exactly the seven environment defaults specified in US-008 and are validated at startup.
20. **FR-020:** Call mode is `manual | automatic`; manual has no interval and never schedules.
21. **FR-021:** Automatic mode requires exactly 5, 10, 30, 60, or 120 seconds; clients limit choices and servers reject every invalid combination/value.
22. **FR-022:** Manual calls advance only through host Call Next; timer/manual concurrency cannot duplicate draw positions.
23. **FR-023:** Cards are randomized 5x5 B/I/N/G/O grids with ranges 1-15/16-30/31-45/46-60/61-75, unique column values, and an always-satisfied free center.
24. **FR-024:** Cards are unique within a round.
25. **FR-025:** Each round has a private cryptographic permutation of 1-75; exactly one unique ball is persisted and broadcast at a time with no repeats.
26. **FR-026:** Current ball and chronological call history are visible.
27. **FR-027:** Players daub only called values on their own card; marks are server-validated, idempotent, persisted, and restored.
28. **FR-028:** Winners and near-win are server-validated; near-win means exactly one required called number away and feedback is optional/private.
29. **FR-029:** The first valid completion pauses calls and opens a 2000 ms two-second co-winner window for completions attributable to the latest ball.
30. **FR-030:** No call occurs during that window; the complete deterministic co-winner set is persisted then broadcast.
31. **FR-031:** Flexible One Line accepts any row, column, or diagonal; Two Lines accepts any two distinct lines, including intersections.
32. **FR-032:** Exact masks require source cells, tolerate extra daubs, satisfy center, and never rotate, reflect, or translate.
33. **FR-033:** One Line may continue to Two Lines then Blackout while preserving cards, marks, calls, history, and draw order; Blackout ends.
34. **FR-034:** Any non-One-Line initial exact pattern is terminal on win.
35. **FR-035:** New rounds retain eligible players but generate new cards/order and empty daubs/history; no prior-round result history is exposed.
36. **FR-036:** `docs/bingo-pattern-catalog.md` and `packages/patterns/src/catalog.ts` contain all source mappings, notation, modes, center rules, aliases, masks, references, and transformation rules without divergence.
37. **FR-037:** Shapes include Bunny Ears, Two Lines, Four Corners, Windmill, Outside Edge, Blackout, Airplane, Wine Glass, X, Turtle, Stairs, Bow Tie, Cross, Plus, Rectangle, Heart, Hat, Hour Glass, Pyramid, Checkerboard, Inside Square, Kite, Smiley Face, and Block of Nine.
38. **FR-038:** The source PDF term `Full House` is documentation-only as an alias to Blackout; Blackout is the sole user/domain/runtime entry.
39. **FR-039:** Both source Two Lines diagrams are examples of the flexible rule.
40. **FR-040:** Letters include A-Y with Z absent; numbers include 0-19 and use the confirmed Q/W/10-19 masks in US-010.
41. **FR-041:** Christmas includes Christmas Tree, Tinsel, Reindeer, Skis, Wreath, Cross, Bell, Snow Boot, Mittens, Snow, Gift, and Snowmobile.
42. **FR-042:** Separate IDs remain for Cross/Plus/Christmas Cross, X/Letter X, Outside Edge/Letter O, and Checkerboard/Christmas Snow.
43. **FR-043:** Every runtime pattern has a source review, canonical-data thumbnail, preview, and golden fixture.
44. **FR-044:** `/api/v1` exposes pattern catalog, create/join/session-status/rejoin, realtime ticket, snapshot, configure, round controls, and own-card mark only as specified.
45. **FR-045:** Versioned realtime contracts cover heartbeat, configure, controls, mark, resync, snapshots, presence, calls, mark result, near-win, co-winners, stages, round end, ack, and error; no chat exists.
46. **FR-046:** Mutations use idempotent command IDs, active-lobby monotonic sequences, persist-before-broadcast, and PostgreSQL Serializable transactions with bounded retries.
47. **FR-047:** PostgreSQL is durable truth; Prisma remains behind repository interfaces and domain imports no React, Next.js, Prisma, or Socket.IO.
48. **FR-048:** Waiting, completed, and abandoned lobbies expire after 1800 inactive seconds, while active lobbies with active calls or connections are protected.
49. **FR-049:** Lobby deletion cascades cards, marks, calls, events, participants, and sessions; expired/old lobbies cannot be restored.
50. **FR-050:** Local Compose uses PostgreSQL 16 with named volume/healthcheck/configurable settings and optional future Redis profile; MVP does not depend on Redis.
51. **FR-051:** The UI uses accessible atoms/molecules/organisms/templates/pages, required aliases, and locally adapted GroundsControl references without a runtime dependency.
52. **FR-052:** Pages include public landing/create/join, host/player lobby, live game, result, expired, and same-device rejoin states in mobile-first layouts.
53. **FR-053:** Card, calls, history, progress, mode/timer, connection/pause, co-winner state, and controls are keyboard/screen-reader accessible.
54. **FR-054:** JsonLd is public only and matches visible HowTo; private pages are noindex/nofollow/noarchive/no-store.
55. **FR-055:** Themes are Animals, Nature, original Superheroes, Pirates, Ghosts, Sports, Christmas, Halloween, July 4th, Valentine's Day, and Birthday.
56. **FR-056:** Every theme includes semantic tokens, readable card, obvious dauber, ball treatment, daub animation, win/respectful other-player AV, and high-contrast/reduced-motion fallbacks.
57. **FR-057:** Assets are original/non-infringing; audio starts after user gesture with mute/volume and consistent perceived volume/no clipping.
58. **FR-058:** Selected-theme visuals are at most 500 KB compressed, opt-in theme audio at most 1 MB, nonselected themes are lazy-loaded, and decorative failures never block gameplay.
59. **FR-059:** Suitable raster assets use AVIF/WebP and every nongenerated asset has provenance/licensing records.
60. **FR-060:** Supported browsers are the latest two stable Chrome, Edge, Firefox, and Safari plus current iOS Safari and Android Chrome.
61. **FR-061:** Private routes use no third-party analytics; privacy notice explains necessary cookie, two-minute window, inactivity deletion, and data minimization.
62. **FR-062:** Testing uses Vitest, RTL, Playwright, property tests, PostgreSQL integration, Socket.IO multi-client, accessibility, load, restart, and security suites.
63. **FR-063:** Strict TypeScript, ESLint flat config, Prettier Tailwind plugin, and the exact requested Husky script are required.
64. **FR-064:** Basic health/readiness and privacy-safe structured logs support the one-realtime-instance/one-PostgreSQL architecture.
65. **FR-065:** Normal committed call-to-render latency is below 250 ms at 25 players/lobby and 100 active lobbies under the approved test profile.
66. **FR-066:** Final product-owner manual acceptance follows passing standard automated criteria and covers the checklist in US-063.
67. **FR-067:** Installs, dependency/configuration changes, and migrations require confirmation; authorized baseline work is committed before implementation.

## Non-Goals

- Public matchmaking, discoverable lobbies, accounts, profiles, chat, voice, reactions, or long-term statistics/history.
- Cross-device identity reclaim, old/expired lobby restoration, device fingerprinting, or unnecessary device data.
- Client-authoritative calls, timers, marks, winners, presence, or future draw-order exposure.
- Real-money play, prizes, wagering, payments, player-created patterns, transformations, or non-75-ball variants.
- Native mobile apps or offline play.
- Redis dependency, multiple realtime replicas, horizontal/multi-region scaling, or multi-instance coordination in MVP.
- Required Three.js/WebGL or protected characters, franchises, teams, logos, and copied assets.
- Long-lived completed-lobby storage or prior-round result browsing.
- A dedicated hosted deployment phase beyond the intended Railway architecture.
- Unconfirmed installation, dependency/configuration change, migration, or destruction/restoration of user work.

## Design Considerations

- Prioritize mobile play while supporting larger host screens. Keep current ball, call mode/timer, pause state, card, and controls prominent.
- Use accessible Select/button-group controls that cannot express a manual interval or unsupported automatic interval.
- Make codes large, high-contrast, easy to speak, enter, copy, and share.
- Show same-device rejoin explicitly without implying account ownership or cross-device portability.
- Display chronological history without reordering away call sequence.
- Generate pattern previews from canonical runtime data and expose source aliases only in documentation/review contexts.
- Use persistent text-supported states for connection, grace, pause, waiting, co-winner window, snapshot sync, and expiry.
- Provide semantic card cells, generous touch targets, visible focus, and controlled live announcements.
- Treat near-win, sound, animation, and decorative assets as optional enhancements.
- Celebrate winners while keeping other-player-won scenes respectful.
- Validate all themes on the stated browser matrix, mobile/desktop, zoom, reduced motion, high contrast, mute, and asset failure.

## Technical Considerations

- Use TypeScript strict mode, Bun scripts, Next.js 16 App Router, React 19, Tailwind CSS 4, and a separate long-lived Node.js Socket.IO server.
- Run web/game server outside Docker during normal development; use Compose for PostgreSQL 16 and optional future-profile Redis.
- Use the specified workspace packages, Zod boundaries, and mechanical domain isolation.
- Use PostgreSQL durable truth with Prisma confined to repositories, Serializable transactions, bounded retries, idempotent command results, active-lobby sequences, and persist-before-broadcast.
- Reconstruct automatic timing from persisted state after the single realtime process restarts and prevent duplicate commits transactionally.
- Authenticate each Socket.IO connection with a 60-second single-use ticket obtained via the scoped HttpOnly cookie.
- Send full authorized snapshots on reconnect; sequences order active events and disappear with lobby data.
- Validate all seven environment defaults at startup and target one Railway realtime instance with one PostgreSQL database.
- Apply cookie, CSRF/origin, payload, rate-limit, authorization, private-cache, data-minimization, and redaction controls.
- Use Vitest rather than Bun's test framework, plus RTL, Playwright, property testing, isolated PostgreSQL, and multi-client Socket.IO tests.
- Support latest two stable Chrome/Edge/Firefox/Safari and current iOS Safari/Android Chrome.
- Enforce selected-theme visual/audio budgets, lazy loading, provenance, and fallbacks; CSS/SVG/Canvas are sufficient for MVP.
- Preserve the exact Husky commands even though they invoke `npx`.

## Success Metrics

- Complete host/player desktop and mobile journeys work from creation through repeated rounds in manual and automatic modes.
- Automated tests observe no repeated balls, duplicate cards, invalid daubs, unsupported intervals, or divergent authoritative snapshots.
- Same-device rejoin works within two minutes; post-window participants join anew and wait during active rounds.
- A single realtime-process restart restores exact active state without lost marks or repeated calls.
- Every source pattern has an approved canonical mapping, generated preview, and passing golden/parity test.
- The two-second co-winner set is deterministic and includes all same-latest-ball completions in the window.
- Keyboard-only and screen-reader users complete core host/player journeys.
- Every theme meets legibility, reduced-motion, high-contrast, mute, budget, lazy-load, and failure-fallback requirements.
- Normal committed call-to-render latency is below 250 ms at the default capacity profile.
- No critical security or accessibility finding remains.
- Inactive lobby deletion removes associated private state and never deletes an active lobby with calls/connections.
- Product owner completes and records the final manual acceptance checklist after automated checks pass.

## Open Questions

None for MVP.
