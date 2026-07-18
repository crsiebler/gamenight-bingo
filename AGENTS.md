# GameNight Bingo Agent Guide

This file applies to the entire repository. Read it with `README.md` and
`tasks/prd-private-realtime-bingo.md`; the PRD is the product source of truth,
and its user stories are dependency ordered. Keep each change focused on one
story and preserve user work outside that scope.

## Project Overview

GameNight Bingo is a private, accountless, Internet-hosted 75-ball Bingo game.
The server is authoritative for participant identity, presence, cards, draw
order, calls, daubs, progress, winners, timers, and round progression.

The target is a TypeScript modular monolith with two runtime processes:

- `apps/web`: Next.js App Router UI and versioned HTTP API.
- `apps/game-server`: long-lived Node.js Socket.IO game authority.
- PostgreSQL: durable application truth, accessed through repositories.
- Docker Compose: local PostgreSQL and an optional future-only Redis profile.

The workspace now provides strict TypeScript, domain-boundary, lint, formatting,
Vitest, React Testing Library, and Playwright checks. Application runtimes land
in later stories. Do not create placeholder behavior, scripts, or configuration
ahead of their story.

## Commands

Run commands from the repository root. The currently available workspace and
local service commands are:

```sh
bun install --frozen-lockfile
bun run test:workspace-boundaries
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run test:e2e
docker compose up -d
docker compose ps
docker compose down
docker compose --profile redis up -d
```

The default Compose stack starts only PostgreSQL. Web and game-server processes
run through Bun outside Docker as their runtime implementation stories land.

The web command is available; the game-server command remains a contract until
its runtime story lands:

```sh
bun run dev:web
bun run dev:game-server
```

Until a command exists, run the safest relevant validation for the files being
changed and document why unavailable checks were not run. Do not add tooling
early solely to make a later command executable.

## Domain Boundaries

The planned workspace responsibilities are:

- `packages/contracts`: versioned Zod schemas and shared boundary types.
- `packages/domain`: framework-independent Bingo rules and transitions.
- `packages/database`: Prisma and PostgreSQL repository implementations.
- `packages/patterns`: canonical masks, matching, source references, and previews.
- `packages/themes`: semantic theme tokens and asset metadata.
- `packages/ui`: shared accessible presentation components.
- `packages/test-support`: reusable fixtures, builders, and integration helpers.

Versioned wire schemas live under `packages/contracts/src/v1` and use strict
objects at every nested boundary. Put `schemaVersion` on top-level messages,
parse opaque IDs through branded schemas, keep client commands intent-only, and
shape snapshots so other cards, credentials, future draws, and event history
cannot be represented.

`packages/domain` must not import React, Next.js, Prisma, or Socket.IO. Keep
database details behind repository interfaces. HTTP and realtime adapters must
validate boundary contracts, authorize the actor, invoke application/domain
behavior, and return committed results rather than duplicate domain rules.
Domain randomization accepts injected `CryptographicRandomBytes`; runtime
adapters provide the secure byte source, tests provide deterministic sources,
and bounded integer selection must avoid modulo bias.
Run `bun run test:workspace-boundaries` after changing workspace manifests or
domain imports; its AST-based guard covers static, type-only, dynamic, CommonJS,
JSDoc, and triple-slash module references with normalized path separators rather
than relying on text matching. The guard also requires each workspace's real
`tsc` command over all `src` files without local strictness downgrades or
`noCheck`, including inherited or implicit source exclusions verified against
TypeScript's parsed file set. Parsed configuration diagnostics are blocking,
parsed effective options must retain `noEmit`, and output paths must stay
outside workspace `src`; the guard also rejects unchecked JavaScript or
`@ts-nocheck` in domain source. It fails closed on parse
errors and rejects escaping filesystem references or symlink traversal from
domain source.
Relative domain source references must remain under `packages/domain/src`, and
shared/domain TypeScript configuration plus the domain manifest may not define
inherited, implicit, or explicit module aliases and resolution redirects such as
`rootDirs` or `moduleSuffixes`; root and nested domain package targets must also
resolve inside `packages/domain/src`. Bare imports and package-valued type/AMD
directives must use declared dependencies (except Node built-ins and the domain
self-reference), may not traverse package paths, and remain subject to forbidden
framework type-package checks. Direct-loader checks unwrap TypeScript-transparent
and comma expressions, follow composed `bind`/`call`/`apply` CommonJS loaders,
and reject unmodeled direct loader values; symlink checks cover TypeScript's
declaration and JavaScript-extension resolution candidates. The workspace guard
permits exactly the `apps/*` and `packages/*` root workspace globs and rejects
unexpected package directories matched by them.

The server remains authoritative. Never move validation of calls, marks,
winners, presence, timers, permissions, or progression into a browser-only
path. Never expose another participant's card or any future draw position.
Domain transitions return discriminated result errors for expected state
rejections; reserve thrown `RangeError`s for malformed internal values such as
invalid counts, timestamps, or durations.

## State And Realtime Invariants

- Give every state-changing command a client-generated command ID.
- Process mutations in PostgreSQL Serializable transactions with bounded,
  observable retries when the database layer is available.
- Persist state, the command result, and the corresponding active-lobby event
  before broadcasting. Broadcast only after the transaction commits.
- A repeated command ID returns its original committed result without repeating
  effects.
- Persist canonical command intent with idempotent results so reusing a command
  ID with changed configuration, pattern, ball, or action is rejected. Resolve
  the active session, actor role, current round, and own card inside the same
  lobby-fenced transaction that applies the command. Before replacing the
  current round, detach its active-event and command-result round scopes so
  command replay tombstones survive without retaining prior-round gameplay
  state. Run due participant-session expiry before selecting a new-round roster.
- Serializable command callbacks are scoped to one lobby and may run more than
  once after rolled-back conflicts, so they must not perform external effects.
  Only a freshly committed active-lobby command returns an event to broadcast;
  replays and participant-private commits return no broadcastable event.
- Assign active-lobby events a monotonic sequence. Clients apply sequences
  idempotently and request resynchronization when continuity is uncertain.
- Put active-lobby sequences only on messages delivered to every authorized
  lobby stream consumer. Participant-private messages use no lobby sequence,
  and acknowledgements explicitly distinguish lobby-event from private-only
  results so sequence requirements cannot be ambiguous.
- Sequences order live activity; they are not a public event-history feature and
  are deleted with the lobby.
- On reconnect, send a complete authorized snapshot unless transport-level
  recovery proves continuity across a very brief interruption.
- Establish a new socket's actor-scoped snapshot before releasing live room
  events: join first, buffer bounded deliveries during the query, emit the
  snapshot, discard buffered lobby sequences at or below its baseline, then
  release newer lobby and participant-private events. Apply the same delivery
  boundary to explicit resync snapshots; if a transient resync query fails,
  restore the prior safe baseline and release events buffered during the attempt.
  Disconnect if the initial baseline cannot be established safely.
- After process restart, ticket renewal, uncertain sequence state, or failed
  recovery, require a full snapshot rather than reconstructing state from the
  client.
- A snapshot may include the participant's own card and marks plus current
  calls, stage, participants, call mode/timer, pause reason, and result. It must
  not include other cards, credentials, or uncalled draw positions.
- Validate snapshot references as one authorized projection: lobby, round,
  session, roster roles and presence, timers, own card/marks, calls, and winners
  must agree with each other.
- Project stage-specific snapshot fields only when that durable stage requires
  them; an open co-winner window may have confirmed winners but no settled result.
- Build authorized snapshots from an allowlisted actor-scoped repository query;
  never adapt `findById`, which contains session hashes, every card, private draw
  order, active events, and command results.
- Reconnect never automatically resumes paused calling.

## HTTP Conventions

- Put application endpoints under `/api/v1` and validate inputs and outputs with
  shared versioned contracts.
- Return stable machine-readable error codes with safe, actionable messages.
- Route unsupported methods and unknown private API resources through the same
  versioned dispatcher so framework-generated 404/405 responses cannot bypass
  stable error schemas or private `no-store` headers.
- Authenticate and authorize every private read and mutation; a lobby code is a
  locator, not proof of identity or host authority.
- Apply origin/CSRF checks, payload limits, and independent rate limits where
  required by the PRD.
- Derive requester rate-limit keys only at a trusted proxy boundary that
  overwrites or appends the observed address and prevents direct origin access.
  Require an authenticated proxy marker that clients cannot supply, hash
  requester addresses, bound active in-memory buckets, and use one bounded
  unidentified bucket when no valid trusted address is available. Rate-limit
  session-status, snapshot reads, and state-changing commands before they can
  acquire lobby fences.
- Set `Cache-Control: no-store` on private responses.
- Require command IDs on mutation endpoints and return committed sequence and
  idempotent result data.
- A replayed entry command may return its original immutable metadata but must
  never mint a new participant credential from a command ID. Commit rejoin
  idempotency and session activation in one lobby-scoped transaction.
- Do not add APIs for chat, event-history retrieval, prior-round browsing, or
  expired-lobby restoration.

## Realtime Conventions

- Authenticate each Socket.IO connection with a short-lived, single-use ticket
  obtained using the scoped HttpOnly participant cookie.
- Require a new ticket for each reconnect; consume a ticket atomically and never
  log its plaintext.
- Generate tickets from 32 cryptographically secure bytes encoded as canonical
  unpadded base64url, persist only their SHA-256 hashes, and issue them under the
  lobby fence only for an active scoped participant session. Realtime adapters
  must atomically consume the hash and trust only the lobby, participant, and
  session identity returned from persistence, never client identity claims.
  Burn every presented ticket even when expired or invalid, purge expired
  abandoned tickets during issuance, and invalidate outstanding tickets whenever
  their participant session leaves active status so rejoin cannot revive them.
- Version realtime command and event contracts in `packages/contracts`.
- Accept Socket.IO authentication only as strict `{ schemaVersion, ticket }`
  handshake auth from the exact configured browser origin. Consume the ticket
  before connection, discard it, and put only persistence-returned lobby,
  participant, and session identity in `socket.data`; never trust client identity
  claims or accept tickets from URLs.
- Bound Engine.IO admission and Socket.IO namespace authentication separately by
  the direct peer address, close the underlying transport after rejected
  authentication, and mark the transport terminal as soon as rejection is known
  before awaiting any required bounded ticket burn. Bound active limiter buckets
  without scanning every active bucket on overflow, rate-limit every
  authenticated command/resync attempt before database work, cap authenticated
  sockets globally and per participant session, track transport closure across
  asynchronous ticket consumption so closed transports never reserve socket
  capacity, recheck transport-wide rejection state after ticket consumption so
  an older in-flight namespace attempt cannot authenticate a terminal transport,
  and permit only one in-flight command per socket.
- Acknowledge commands with their committed result/sequence or a stable error.
- Keep broadcasts derived from committed events. Do not emit optimistic domain
  state before persistence succeeds. Emit the active-event PostgreSQL
  notification inside the committing transaction so HTTP fallback mutations can
  reach the separate game-server process only after commit; the game server
  reloads and validates the committed event before publishing it. Treat listener,
  malformed dedicated-channel notification, reload, or publication failure as
  fatal so a supervisor restarts an authority that can no longer prove
  continuity; stop Socket.IO from accepting work before awaiting subscription or
  database drain. Serialize asynchronous room authorization and delivery per
  lobby so committed sequences cannot arrive out of order; accept only bounded,
  canonical exact-sequence echoes as idempotent and reject same-sequence conflicts
  or unknown stale deliveries.
- Realtime command adapters revalidate the consumed-ticket identity inside the
  lobby-fenced transaction. Fresh lobby commits broadcast their validated event
  before the caller acknowledgement, replays acknowledge without rebroadcasting,
  and participant-private results use participant rooms without lobby sequences.
  Validate every successful acknowledgement's command ID against the incoming
  mutation before emitting any result. Eventless idempotent replay tombstones may
  return their original acknowledgement for either delivery scope.
- Disconnect immediately when transactional revalidation rejects an identity,
  and revalidate room members before later lobby/private delivery so deactivated
  sessions cannot remain subscribed. Authorize one persisted identity once per
  delivery rather than once per sibling socket. A replayed private result may
  return only to its requesting socket, never rebroadcast to sibling tabs.
- Aggregate multiple connections for one session as one participant. Persist
  count-only tab opens/closes without broadcasting; only the first connection
  and final disconnection commit sequenced presence events. The final connection
  also disconnects the participant session, invalidates outstanding tickets, and
  fixes its configured rejoin deadline in the same lobby-fenced transaction.
  Bind disconnect cleanup to the registered presence generation, consolidate
  sibling sessions, and disconnect the participant's canonical active session
  when the final connection belongs to an older departed sibling. Treat cleanup
  persistence failure as fatal: stop accepting work, settle runtime completion,
  and drain the event subscription and database for supervisor restart.

## Test-Driven Development

Write a failing test before implementing behavior changes, bug fixes, or
refactors. Keep the smallest useful cycle: failing test, minimal implementation,
then refactor while green.

- Use Vitest, not Bun's built-in test framework.
- Keep `**/node_modules/**` in each custom Vitest project exclusion; Bun workspace
  links can otherwise place dependency source tests under matching `apps` or
  `packages` paths.
- Keep intentional quality-tool violations under `tests/fixtures/quality`; normal
  checks exclude them, and `bun run test:quality-tooling` verifies each tool
  rejects its fixture for the expected reason.
- Put pure rules under unit and property-based tests.
- Test HTTP and realtime boundaries for contract parsing, authorization,
  idempotency, privacy, and stable errors.
- Verify framework-routing guarantees such as unsupported methods, catch-all
  resources, stable errors, and private cache headers with live Next requests;
  dispatcher unit tests or route-source assertions alone do not exercise that
  boundary. The live API route suite requires an approved migrated
  `TEST_DATABASE_URL` and otherwise skips only that database-backed test.
- Use isolated PostgreSQL integration tests for repository, transaction,
  migration, concurrency, and restart behavior.
- PostgreSQL lock-coordination tests must roll back and release checked-out
  clients in `finally` blocks and await blocked operations during cleanup so a
  failed synchronization assertion cannot hang the suite.
- Use multi-client Socket.IO tests for ordering, presence, reconnects, timers,
  and co-winner behavior.
- Use React Testing Library for component behavior and Playwright for browser
  journeys. Frontend stories also require manual browser verification.
- Use fake timers for reconnect, pause grace, automatic calling, co-winner, and
  inactivity behavior; avoid wall-clock-dependent tests.
- Run the narrow affected suite while developing and all available root checks
  before committing.
- Pattern catalog changes must pass the complete audit that joins every source
  diagram and review disposition to runtime IDs, aliases, masks, and committed
  preview goldens; keep mutation coverage for each fail-closed audit category.

## UI Guidance

- Build mobile-first while keeping host workflows clear on larger screens.
- Use the planned atoms/molecules/organisms/templates/pages organization and
  shared semantic components instead of duplicating controls.
- Treat server snapshots and sequenced committed events as UI state inputs; do
  not infer authoritative game state from animation or local timers.
- Show loading, offline, reconnecting, snapshot-syncing, grace, paused, waiting,
  co-winner-window, result, and expired states explicitly where applicable.
- Keep current call, card, call mode/timer, pause reason, and valid controls
  prominent. Prevent duplicate pending commands.
- Generate pattern previews from canonical catalog data. Never hand-maintain a
  second mask source or transform a source mask implicitly.
- Themes may change presentation, not game semantics or readability. Lazy-load
  nonselected assets and preserve functional fallbacks when decoration fails.

## Accessibility

- All core host and player journeys must work with keyboard and screen reader.
- Prefer native semantic elements; give controls accessible names and associate
  errors/instructions programmatically.
- Provide visible focus, logical focus order, generous touch targets, and text
  equivalents for card and status states.
- Never communicate called/marked, connection, pause, winner, or error state by
  color, sound, or motion alone.
- Use controlled live regions for new calls and important state changes; avoid
  replaying call history or flooding announcements after snapshots.
- Respect reduced motion, high contrast, zoom/reflow, and mute/volume settings.
- Test accessibility in components and affected browser journeys. Do not accept
  critical accessibility violations.

## Security And Privacy

- Store opaque participant session tokens only as cryptographic hashes. Cookies
  must be Secure, HttpOnly, SameSite, and scoped to the active lobby flow.
- Generate participant session credentials from 32 cryptographically secure
  bytes, encode them as unpadded base64url, and persist only the SHA-256 digest
  of the encoded token. Authenticate through a narrow lobby-and-hash lookup,
  never by loading a full lobby aggregate or trusting a client participant ID.
- Serialize disconnect, rejoin-status, expiry, and rejoin transitions within the
  active lobby and sample lifecycle time after acquiring that fence on every
  retry. Treat `now >= rejoinUntil` as departed, invalidate the prior participant
  slot atomically when no valid sibling session remains, invalidate siblings on
  successful rejoin, and derive new-join round eligibility in persistence rather
  than accepting it from clients. Rejoin-status resolution must run the
  lobby-scoped expiry transition before cookie validation so a missing, cleared,
  or malformed credential cannot defer departure.
- Authorized snapshot rosters prioritize every referenced actor. The bounded
  projection may contain 26 entries only when preserving the 25-player current
  round plus one waiting replacement actor; otherwise exclude unrelated departed
  history and retain the normal current-roster bound. This does not increase
  lobby admission capacity.
- Do not fingerprint devices or collect unnecessary device attributes.
- Never log cookies, realtime tickets, secrets, future draw positions, private
  cards, or full private snapshots.
- Keep errors, metrics, health output, and structured logs secret-free and
  privacy-safe.
- Mark private pages `noindex`, `nofollow`, and `noarchive`; keep third-party
  analytics and public structured data off private routes.
- Validate environment configuration before serving traffic without echoing
  secret values.
- Parse process environment only at runtime entry points through
  `parseRuntimeConfig` from `packages/contracts`; pass the immutable typed result
  inward and keep `packages/domain` independent of `process.env`.
- Delete inactive lobby data according to configured retention, but never delete
  an active lobby with active calls or connections.
- Do not commit secrets, credentials, tokens, local environment files, database
  contents, or captured user data.

## Database And Migrations

- Keep Prisma confined to `packages/database`; expose repositories to the rest
  of the application.
- Prisma 7 generates its ignored client under `packages/database/generated` via
  `bun run db:generate`; the root install-time prepare script regenerates it, and
  application packages import only database repository interfaces.
- Design constraints for scoped uniqueness, command idempotency, monotonic event
  sequences, and cascade deletion rather than relying only on application checks.
- Create lobbies through `LobbyStateRepository.createActive`; it serializes
  admission, enforces the configured waiting/active lobby limit, and retries
  generated-code collisions before exposing the code as a locator.
- PostgreSQL-only partial indexes, checks, and composite foreign keys live in
  append-only migration SQL because Prisma schema syntax cannot represent them;
  inspect generated migrations so later schema changes do not drop those guards.
- `rounds.lobby_id` is unique: the durable model retains one current round and
  cascades its cards, marks, private draw order, calls, winners, round events, and
  command results rather than storing prior-round history.
- Run database integration tests only with an explicit approved
  `TEST_DATABASE_URL` after `DATABASE_URL=... bun run db:migrate:deploy`; the
  generic test command skips that suite when no test database is supplied.
- Migration files are append-only once shared. Do not edit applied migrations to
  change history.
- Obtain explicit confirmation before creating or running a migration unless the
  active automation invocation grants scoped approval.
- Run migrations only against approved local/test databases during development.
  Never point local checks at production or destructive targets.
- Destructive schema or data operations require explicit confirmation and a
  documented recovery plan.

## Local Operations And Confirmation

- Obtain confirmation before installing/changing dependencies, changing project
  configuration, changing Docker configuration, running migrations, or deleting
  data, unless the active task explicitly provides scoped auto approval.
- Scoped approval never permits production/secret access, work outside the
  repository, disabling safeguards, destructive unrelated operations, history
  rewriting, or protected-branch pushes.
- Bind local data services to `127.0.0.1`. Redis remains optional and no MVP code
  or default command may depend on it.
- Wait for PostgreSQL to report healthy in `docker compose ps` before starting
  application processes or integration tests.
- `docker compose down` preserves the named PostgreSQL volume. Do not add
  `--volumes` or otherwise delete local data without explicit confirmation.
- Do not expose the development database password or reuse it in hosted
  environments.

## Git And Commits

- Inspect status and diffs before staging. Stage only files required by the
  current story and never revert unrelated user changes.
- Do not commit unless applicable typecheck, lint, formatting, and tests pass.
- Use Conventional Commits in the form `<type>(<scope>): <description>`, for
  example `feat(realtime): restore snapshot after reconnect`.
- If an authorized task specifies an exact commit message, follow that task's
  message instead of rewriting it.
- Do not amend, rebase shared history, force-push, or push directly to a
  protected branch.
