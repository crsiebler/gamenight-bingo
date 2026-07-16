# GameNight Bingo

GameNight Bingo is a private, Internet-hosted 75-ball Bingo game for friends
and family. A host creates a lobby, selects a theme and pattern, chooses manual
or automatic calling, and shares a six-character code or invite URL. Players
join from their own devices with lobby-unique usernames; accounts and chat are
outside the MVP.

> [!IMPORTANT]
> The repository is being rebuilt in dependency-ordered stories. It currently
> contains product documentation, source pattern PDFs, and local Compose
> services, but the workspace and package scripts described below have not yet
> been added. Those commands are the project contract and become executable as
> later stories land.

## MVP

- Private, accountless lobbies with up to 25 participants by default
- Valid randomized 75-ball cards and a cryptographic, nonrepeating draw order
- Manual calling or automatic calling every 5, 10, 30, 60, or 120 seconds
- Server-authoritative calls, daubs, progress, winners, and round progression
- A two-second window that includes co-winners completed by the latest call
- Same-device rejoin for two minutes and authoritative reconnect snapshots
- Accessible, mobile-first cards, host controls, status, themes, and results
- Durable active games that survive one realtime-process restart

## Architecture

The application is a TypeScript modular monolith with two runtime processes:

```text
Browser
  |-- HTTPS --> Next.js 16 App Router web application and /api/v1
  `-- Socket.IO --> long-lived Node.js game authority
                         |
                         `-- PostgreSQL 16 durable state
```

- **Web:** Next.js 16, React 19, and Tailwind CSS 4 provide public pages,
  private lobby/game pages, and versioned HTTP APIs.
- **Game server:** a separate long-lived Node.js Socket.IO process owns
  low-latency commands, presence, timers, and sequenced events.
- **Database:** PostgreSQL is durable truth. Prisma is confined to repository
  implementations rather than imported by domain code.
- **Contracts:** Zod schemas version and validate HTTP and realtime boundaries.
- **Local infrastructure:** Docker Compose supplies PostgreSQL. Redis is
  reserved for an optional future profile and is not an MVP dependency.
- **Hosting target:** one Railway realtime instance and one PostgreSQL database.
  Web and game-server processes normally run through Bun outside Docker.

State-changing commands use command IDs and serializable transactions. State
and events are persisted before broadcast, and active-lobby event sequences
order/idempotently apply live updates. There is no event-history API.

## Prerequisites

Install and verify:

- [Bun](https://bun.sh/docs/installation) for workspace scripts and packages
- [Node.js](https://nodejs.org/en/download) for the long-lived game server and
  ecosystem tooling
- [Docker Desktop](https://docs.docker.com/desktop/) or Docker Engine with the
  [Compose plugin](https://docs.docker.com/compose/install/)
- [GitHub CLI](https://cli.github.com/) authenticated with access to required
  private reference repositories

```sh
bun --version
node --version
docker --version
docker compose version
gh auth status
```

## Setup

Configuration and dependency changes require maintainer confirmation. Local
infrastructure is available now; workspace commands become available in later
stories:

1. Clone the repository and enter its root directory.
2. Confirm the prerequisites above, including `gh auth status`.
3. Obtain approval before installing or changing dependencies, then run
   `bun install`.
4. Copy the provided environment example to the documented local environment
   file when that template is introduced. Never commit local secrets.
5. Start PostgreSQL with `docker compose up -d` and wait for it to become
   healthy in `docker compose ps`.
6. Run the web and game-server development commands in separate terminals.

Docker lifecycle commands:

```sh
docker compose up -d
docker compose ps
docker compose down
```

The default stack starts only the `postgres` service. Wait until its status is
`healthy` in `docker compose ps` before starting application processes. Redis is
reserved for future work and starts only when its profile is explicitly enabled:

```sh
docker compose --profile redis up -d
```

`docker compose down` stops local services without deleting the named database
volume. Do not add a volume-removal flag unless local data loss is intentional
and explicitly approved.

Development commands from the repository root:

```sh
bun run dev:web
bun run dev:game-server
```

The processes run locally through Bun, not in the default Compose stack.

## Environment

Runtime configuration is validated before either process serves traffic.
Invalid integers, unsafe ranges, inconsistent timings, and missing required
secrets must fail startup with actionable errors that do not reveal secrets.

The local Compose settings are configurable through the shell environment:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `POSTGRES_HOST_PORT` | `5432` | PostgreSQL port exposed on the host |
| `POSTGRES_DB` | `gamenight_bingo` | Local PostgreSQL database name |
| `POSTGRES_USER` | `gamenight_bingo` | Local PostgreSQL username |
| `POSTGRES_PASSWORD` | `gamenight_bingo` | Local-only PostgreSQL password |
| `REDIS_HOST_PORT` | `6379` | Redis host port when the `redis` profile is enabled |

For example, use `POSTGRES_HOST_PORT=55432 docker compose up -d` when port
`5432` is occupied. The checked-in credentials are intentionally non-secret
development defaults; override them as needed and never reuse them in hosted or
production environments. Both data services bind only to `127.0.0.1` on the
host. Changing PostgreSQL initialization variables does not update an existing
named volume; use matching values or recreate local data only when data loss is
intentional and explicitly approved.

The confirmed application defaults are:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `MAX_PLAYERS_PER_LOBBY` | `25` | Maximum participants retained in one lobby |
| `MAX_ACTIVE_LOBBIES` | `100` | Maximum concurrently active lobbies |
| `LOBBY_IDLE_TTL_SECONDS` | `1800` | Inactive waiting/completed/abandoned lobby retention |
| `PLAYER_RECONNECT_WINDOW_SECONDS` | `120` | Same-device prior-slot rejoin window |
| `DISCONNECT_PAUSE_GRACE_SECONDS` | `10` | Delay before a persistent absence pauses calling |
| `REALTIME_TICKET_TTL_SECONDS` | `60` | Lifetime of a single-use Socket.IO ticket |
| `CO_WINNER_WINDOW_MS` | `2000` | Window for completions attributable to the latest call |

Application database URLs, public origins, cookie secrets, and process ports are
infrastructure-specific. Their names and defaults will be defined by the
runtime-configuration story. Actual secret values have no repository default
and belong only in approved local or hosted secret storage.

## Workspace

The planned Bun workspace keeps runtime and domain concerns explicit:

```text
apps/
  web/             Next.js UI and versioned HTTP API
  game-server/     Long-lived Socket.IO authority
packages/
  contracts/       Versioned Zod boundary schemas and shared types
  domain/          Framework-independent Bingo rules and state transitions
  database/        Prisma and PostgreSQL repository implementations
  patterns/        Canonical pattern catalog, matcher, and previews
  themes/          Theme tokens and asset metadata
  ui/              Shared accessible UI components
  test-support/    Fixtures, builders, and cross-package test helpers
```

Domain code must not import React, Next.js, Prisma, or Socket.IO. HTTP and
realtime adapters validate contracts, invoke domain/application behavior, and
return committed results.

## Patterns And Themes

The source pattern diagrams are preserved in:

- [Shape patterns](docs/shapes-bingo-patterns.pdf)
- [Letter patterns](docs/letter-bingo-patterns.pdf)
- [Number patterns](docs/number-bingo-patterns.pdf)
- [Christmas patterns](docs/christmas-bingo-patterns.pdf)

`packages/patterns` will become the canonical runtime catalog for stable IDs,
source references, 5x5 masks, exact/flexible semantics, matching, and generated
previews. Catalog documentation and golden tests must stay synchronized with
that package; masks are never implicitly rotated, reflected, translated, or
deduplicated.

`packages/themes` will hold semantic tokens, original visual/audio assets, and
asset provenance. Every theme must preserve readable game state, visible focus,
high contrast, reduced motion, mute controls, and functional fallbacks when a
decorative asset fails.

## Realtime And Reconnects

The server, not the browser, owns participant identity, cards, future draw
order, calls, marks, presence, timers, winner validation, and progression.

An opaque Secure HttpOnly SameSite cookie identifies a participant only within
the active lobby and is stored server-side only as a cryptographic hash. The
cookie issues a 60-second, single-use realtime ticket for one participant and
lobby. A new ticket is required for each Socket.IO reconnect.

After a normal reconnect, the server sends a complete authorized snapshot of
the participant's own card and marks plus current calls, stage, participants,
timer/call mode, pause reason, and result. Brief transport recovery may resume
without a snapshot only when Socket.IO can prove continuity. A process restart
or uncertain event sequence requires a new ticket and full snapshot. Future
draw positions and other players' cards are never included.

The same-device cookie can offer `Rejoin as <username>` for 120 seconds after
disconnect. Clearing or losing the cookie removes that proof of identity; the
person must join as a new participant and waits for the next round if one is
active. Reconnect never automatically resumes paused calls.

## Privacy And Security

- Lobby codes locate lobbies but do not authorize identity or host actions.
- Private responses are non-cacheable, and private pages are excluded from
  indexing and third-party analytics.
- Session cookies and realtime tickets are scoped, short-lived where
  applicable, and never logged in plaintext.
- The application does not fingerprint devices or retain unnecessary device
  attributes.
- Other players' cards and uncalled draw positions are never exposed.
- Waiting, completed, or abandoned lobbies are deleted after 30 minutes of
  qualifying inactivity, including associated session/game data. Active games
  with calls or connections are protected from cleanup.
- Expired or old lobbies, event history, and prior-round results cannot be
  restored or browsed.
- Inputs, origins, permissions, rates, cookies, and private caching are checked
  at server boundaries. Errors and diagnostics must not expose credentials or
  private game state.

## Checks And Tests

Run the project checks from the repository root after the quality-tooling story
has established the scripts:

```sh
bun run typecheck
bun run lint
bun run format:check
bun run test
```

Vitest, not Bun's built-in test framework, is the test runner. The complete
strategy includes unit/property tests, React Testing Library, isolated
PostgreSQL integration tests, Socket.IO multi-client/restart tests, Playwright
browser journeys, accessibility checks, and load/security suites. A contributor
should run the narrow affected suite while developing and all required root
checks before committing.

## Contributing

- Read the [product requirements](tasks/prd-private-realtime-bingo.md) and root
  `AGENTS.md` after its implementation-guidance story is added.
- Work in dependency order and keep each change focused on one user story.
- Obtain confirmation before dependency installation/changes, configuration
  changes, Docker configuration changes, or database migrations.
- Write tests first for behavior changes and use Vitest through Bun scripts.
- Keep domain rules framework-independent and preserve persist-before-broadcast,
  command idempotency, active-lobby sequences, and authoritative snapshots.
- Do not commit secrets, credentials, private tokens, generated local state, or
  user data.
- Preserve keyboard operation, screen-reader semantics, non-color status cues,
  reduced motion, and high contrast in UI work.

Commit messages use Conventional Commits in this exact form:

```text
<type>(<scope>): <description>
```

Examples include `feat(patterns): add canonical shape masks`,
`fix(realtime): restore snapshot after reconnect`, and
`docs(project): clarify local setup`.

## Troubleshooting

### PostgreSQL Is Unhealthy

Run `docker compose ps`, then inspect the `postgres` service with
`docker compose logs postgres`. Confirm Docker has enough
disk/memory, the configured database/user/password agree with the application
connection URL, and the host port is not occupied. Restart with
`docker compose down` followed by `docker compose up -d`; do not delete the
named volume as a routine fix.

### A Port Is Already In Use

Identify the process using the reported web, game-server, PostgreSQL, or optional
Redis host port. Stop that process or set the documented host-port override to
an unused value, then update the corresponding local URL. Do not change the
container's internal database port or commit a machine-specific override.

### Environment Validation Fails

Read the startup error for the variable name and expected constraint. Check for
missing values, noninteger text, unsafe ranges, unsupported automatic intervals,
or timings that conflict. Compare against the defaults in [Environment](#environment)
and restart the affected process. Do not print secret values while debugging.

### GitHub CLI Is Not Authenticated

Run `gh auth status`. If it fails, authenticate with `gh auth login`, choose the
correct GitHub host/account, and verify that account can read required private
reference repositories. Retry `gh auth status` before any authenticated fetch.

### Socket.IO Does Not Connect

Confirm both development processes are running and the browser uses the correct
game-server origin/port. Check origin/CORS settings, HTTPS versus HTTP, proxy
WebSocket support, cookie availability, and browser network errors. A ticket is
single-use and expires after 60 seconds, so reload/reconnect through the normal
HTTP ticket flow rather than reusing a captured ticket. After server restart,
request a new ticket and expect a full snapshot.

### Cookies Were Cleared

The server cannot recover participant identity without the scoped HttpOnly
cookie. Join the lobby as a new participant with an available username. If a
round is active, the new participant waits for the next round; there is no
cross-device or administrator slot-reclaim flow.
