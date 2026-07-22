# GameNight Bingo

GameNight Bingo is a private, Internet-hosted 75-ball Bingo game for friends
and family. A host creates a lobby, selects a theme and pattern, chooses manual
or automatic calling, and shares a six-character code or invite URL. Players
join from their own devices with lobby-unique usernames; accounts and chat are
outside the MVP.

> [!IMPORTANT]
> The repository is being rebuilt in dependency-ordered stories. It currently
> includes the Bun workspace, strict TypeScript and quality checks, source
> pattern PDFs, and local Compose services. Framework runtimes become executable
> as their later stories land.

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
  implementations rather than imported by domain code. The durable model keeps
  only one current round per lobby and cascades its private state when replaced
  or when the lobby is deleted.
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
infrastructure, workspace checks, the web API, and the authenticated Socket.IO
authority are available now; browser UI stories land later:

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

`bun run dev:web` starts the Next.js HTTP API. `bun run dev:game-server` starts
the separate long-lived Socket.IO authority on `127.0.0.1:3001` by default.
Both validate runtime configuration and connect through `DATABASE_URL` before
serving. They run locally through Bun, not in the default Compose stack.

The explicit single-instance capacity check uses a fresh, empty, migrated
nonproduction database and writes percentile evidence to
`test-results/single-instance-performance.json`:

```sh
E2E_DATABASE_CONFIRMED_NONPRODUCTION=true \
TEST_DATABASE_URL=postgresql://... \
bun run test:performance
```

The harness uses Playwright's managed Chromium by default. Set
`PLAYWRIGHT_BROWSER_CHANNEL=chrome` to use an installed stable Chrome binary,
including on workstations where the managed browser has not been installed.

The harness fixes the profile at the application defaults of 100 active lobbies
and 25 connected participants per lobby. It builds and starts one web process,
runs one realtime authority, measures 3,000 command-to-commit samples, 30
commit-to-browser-render samples, and 100 full snapshot reconnects, and fails on
repeated balls, dropped or divergent call events, divergent snapshots, or a
commit-to-render p95 at or above 250 ms. Run it separately from other database
or browser suites so its dedicated database and local resources are not shared.

## Environment

Runtime configuration is validated before either process serves traffic.
Invalid integers, unsafe ranges, inconsistent timings, and missing required
secrets must fail startup with actionable errors that do not reveal secrets.

The local Compose settings are configurable through the shell environment:

| Variable             |           Default | Purpose                                             |
| -------------------- | ----------------: | --------------------------------------------------- |
| `POSTGRES_HOST_PORT` |            `5432` | PostgreSQL port exposed on the host                 |
| `POSTGRES_DB`        | `gamenight_bingo` | Local PostgreSQL database name                      |
| `POSTGRES_USER`      | `gamenight_bingo` | Local PostgreSQL username                           |
| `POSTGRES_PASSWORD`  | `gamenight_bingo` | Local-only PostgreSQL password                      |
| `REDIS_HOST_PORT`    |            `6379` | Redis host port when the `redis` profile is enabled |

For example, use `POSTGRES_HOST_PORT=55432 docker compose up -d` when port
`5432` is occupied. The checked-in credentials are intentionally non-secret
development defaults; override them as needed and never reuse them in hosted or
production environments. Both data services bind only to `127.0.0.1` on the
host. Changing PostgreSQL initialization variables does not update an existing
named volume; use matching values or recreate local data only when data loss is
intentional and explicitly approved.

The confirmed application defaults are:

| Variable                          | Default | Purpose                                                |
| --------------------------------- | ------: | ------------------------------------------------------ |
| `MAX_PLAYERS_PER_LOBBY`           |    `25` | Maximum participants retained in one lobby             |
| `MAX_ACTIVE_LOBBIES`              |   `100` | Maximum concurrently active lobbies                    |
| `LOBBY_IDLE_TTL_SECONDS`          |  `1800` | Inactive waiting/completed/abandoned lobby retention   |
| `PLAYER_RECONNECT_WINDOW_SECONDS` |   `120` | Same-device prior-slot rejoin window                   |
| `DISCONNECT_PAUSE_GRACE_SECONDS`  |    `10` | Delay before a persistent absence pauses calling       |
| `REALTIME_TICKET_TTL_SECONDS`     |    `60` | Lifetime of a single-use Socket.IO ticket              |
| `CO_WINNER_WINDOW_MS`             |  `2000` | Window for completions attributable to the latest call |

Capacity overrides accept 1-25 players and 1-100 active lobbies. Timing limits
are 1-86,400 seconds for lobby retention, 1-3,600 seconds for reconnect, 1-300
seconds for disconnect grace and realtime tickets, and 1-10,000 milliseconds
for the co-winner window. Disconnect grace must be shorter than reconnect,
realtime tickets cannot outlive reconnect, and reconnect must be shorter than
lobby retention. Values must be unsigned decimal integers; invalid errors name
the setting and constraint without including its supplied value.

`DATABASE_URL` selects the PostgreSQL database used by Prisma migration commands
and both application processes; it has no usable repository default and is
required before either process starts. It must target an explicitly approved
local or test database during development. `TEST_DATABASE_URL` enables the
isolated PostgreSQL integration suite.

The game-server listener settings are:

| Variable           | Default                 | Purpose                                        |
| ------------------ | ----------------------- | ---------------------------------------------- |
| `GAME_SERVER_HOST` | `127.0.0.1`             | Socket.IO listener address                     |
| `GAME_SERVER_PORT` | `3001`                  | Socket.IO listener port, from 1 through 65535  |
| `WEB_ORIGIN`       | `http://localhost:3000` | Exact browser origin allowed for HTTP/realtime |

The optional browser build variable `NEXT_PUBLIC_GAME_SERVER_URL` selects an
absolute public Socket.IO origin, such as `http://localhost:3001` for separate
local web and game-server processes. Omit it when hosted ingress forwards
Socket.IO on the web origin. It is public routing configuration and must never
contain a credential or ticket.

`WEB_ORIGIN` must be one HTTP or HTTPS origin without credentials, path, query,
or fragment. The web process compares every mutation `Origin` with this value
and also requires its first-party JSON mutation header; the game server uses the
same exact origin for transport admission. Hosted ingress terminates TLS and
forwards WebSocket upgrades to the configured game-server listener. The web
rate limiter treats the rightmost `X-Forwarded-For` address as requester
identity only when the terminating proxy also supplies
`X-Gamenight-Trusted-Proxy` with the configured
`TRUSTED_PROXY_SECRET`. The optional secret must contain at least 32 characters;
when absent, every request safely uses the bounded unidentified-requester bucket.
Hosted ingress must strip client-supplied copies of both headers, inject the
secret marker, overwrite or append the observed address, and prevent direct
origin access. Public origins, cookie secrets, and process ports remain
infrastructure-specific and will be defined by dependency-ordered runtime
stories. Actual secret values belong only in approved local or hosted secret
storage.

## Workspace

The Bun workspace keeps runtime and domain concerns explicit:

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
return committed results. `bun run test:workspace-boundaries` enforces the
domain restriction through TypeScript AST inspection and verifies the expected
workspace structure.

## Patterns And Themes

The source pattern diagrams are preserved in:

- [Shape patterns](docs/shapes-bingo-patterns.pdf)
- [Letter patterns](docs/letter-bingo-patterns.pdf)
- [Number patterns](docs/number-bingo-patterns.pdf)
- [Christmas patterns](docs/christmas-bingo-patterns.pdf)

`packages/patterns` is the canonical runtime catalog for core stable IDs, source
references, 5x5 masks, exact/flexible semantics, and matching. Source-specific
exact entries and generated previews land in later catalog stories. Catalog
documentation and golden tests must stay synchronized with that package; masks
are never implicitly rotated, reflected, translated, or deduplicated.

`packages/themes` is the canonical catalog for approved theme IDs, moodboards,
semantic color roles, focus treatment, and motion policy. Review the generated
[theme direction](docs/theme-moodboards.md) and [browser specimen
gallery](docs/theme-moodboards.html). Original per-theme vector sprites are
described by that catalog and reviewed in the generated [visual asset
gallery](docs/theme-assets.html). The generated [asset inventory and optimization
policy](docs/assets.md) records budgets, provenance, raster-format decisions,
lazy loading, and failure fallbacks. The private lobby requests only its selected
theme. Each theme also has one project-original generated WAV sprite containing
call, daub, near-win, winner, and respectful other-player-won cues. The browser
requests only the selected theme's audio and only after `Enable sounds` is
activated; mute and volume persist locally, but every page load starts locked
until a new user gesture. Every theme preserves readable game state, visible
focus, high contrast, reduced motion, and functional play when visual or audio
assets fail. Regenerate the committed visual inventory and sprites with
`bun scripts/generate-theme-assets.ts`, and regenerate audio sprites with
`bun scripts/generate-theme-audio.ts`.

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

Socket.IO clients connect with strict handshake auth containing only
`{ schemaVersion: 1, ticket }`. The authority validates the exact browser origin,
atomically consumes the ticket, discards it, and trusts only the lobby,
participant, and session identity returned by persistence. Client commands use
the `v1:command` event. Server messages use `v1:snapshot`, `v1:lobby-event`,
`v1:private-event`, `v1:ack`, and `v1:error`; chat and event-history commands are
not defined. A consumed ticket cannot reconnect, so the client must obtain a new
ticket from the HTTP flow for every new Socket.IO connection.
Committed lobby events also emit a transaction-scoped PostgreSQL notification.
The separate game-server process reloads and validates the durable event before
publishing it, so HTTP fallback commands reach connected clients only after the
mutation commits. Exact notification echoes are deduplicated against bounded
canonical event identities. A lost listener or failed relay shuts down the game
server so its supervisor can restart it rather than serving with uncertain event
continuity.
Engine.IO admission and Socket.IO namespace authentication are separately
bounded by direct peer address. The authority permits at most 10,000 concurrent
authenticated sockets and eight per participant session. Authenticated commands
and resyncs are independently bounded per session, and each socket may have only
one command in flight. If a command, heartbeat, resync, or outbound delivery
finds that the persisted session is no longer active, the authority disconnects
that socket before it can remain subscribed to private rooms.

### Health And Diagnostics

Both the web process and game server expose `GET`/`HEAD` `/healthz` for process
liveness and `/readyz` for PostgreSQL readiness. Liveness does not query the
database. Readiness uses a one-second, coalesced and briefly cached database
probe; it returns `200` with `postgresql: "up"` or `503` with
`postgresql: "down"`. Responses are fixed, non-cacheable JSON and never include
connection strings, hosts, database errors, application counts, or private game
state. Other methods return `405`, and query-bearing health URLs return `404`.
Hosted ingress should expose these unauthenticated probe paths only to the load
balancer or monitoring network.

Application diagnostics are JSON Lines written to standard output. Allowlisted
records correlate committed/rejected commands, active-lobby event sequences,
Serializable transaction retries, disconnect-pause generations, and restart
restoration summaries. Lobby and participant correlations are truncated SHA-256
digests. Logs never serialize requests, command payloads, errors, snapshots,
cards, marks, future draw positions, cookies, session credentials, realtime
tickets, usernames, addresses, or user agents. Logging failures do not change
authoritative game behavior.

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
- Create, join, and rejoin limits use independent requester buckets with bounded
  in-memory storage; session-status and snapshot reads are independently bounded
  before lobby maintenance. Production must use the authenticated proxy marker
  and header-stripping boundary documented above. Client-supplied forwarding or
  proxy-marker headers are not trusted.

## Checks And Tests

Install the locked workspace dependencies and run checks from the repository
root:

```sh
bun install --frozen-lockfile
bun run test:workspace-boundaries
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run db:generate
DATABASE_URL='<approved-local-or-test-url>' bun run db:migrate:deploy
TEST_DATABASE_URL='<migrated-test-url>' bun run test:database
E2E_DATABASE_CONFIRMED_NONPRODUCTION=true TEST_DATABASE_URL='<fresh-empty-migrated-restart-test-url>' bun run test:restart
bun run test:e2e
E2E_DATABASE_CONFIRMED_NONPRODUCTION=true TEST_DATABASE_URL='<fresh-empty-migrated-browser-test-url>' PLAYWRIGHT_BROWSER_MATRIX=all PLAYWRIGHT_MATRIX_PROJECT='<one-project>' bun run test:e2e
```

Vitest, not Bun's built-in test framework, is the test runner. The complete
strategy includes unit/property tests, React Testing Library, isolated
PostgreSQL integration tests, Socket.IO multi-client/restart tests, Playwright
browser journeys, accessibility checks, and load/security suites. A contributor
should run the narrow affected suite while developing and all required root
checks before committing. Playwright browser checks require a managed Chromium
installation from `bunx playwright install chromium`. To verify against an
installed stable Google Chrome instead, run
`PLAYWRIGHT_BROWSER_CHANNEL=chrome bun run test:e2e`. The complete automated
project list and the required native/previous-stable manual coverage are in the
[browser test matrix](docs/browser-test-matrix.md); Playwright device emulation
must not be reported as native mobile-browser coverage. Full-stack browser runs
require the explicit nonproduction acknowledgement, fail closed unless their
dedicated database contains no existing lobbies, and run one project per fresh
database.
The generic Vitest run skips database integration tests when `TEST_DATABASE_URL`
is absent; database changes must also run `test:database` against PostgreSQL 16
after applying the committed migrations. The process-restart suite requires its
own fresh, empty, migrated nonproduction database because the game-server entry
point recovers every persisted process-local lease. Never run migration or
integration-test commands against production.

## Contributing

- Read the [product requirements](tasks/prd-private-realtime-bingo.md) and root
  [`AGENTS.md`](AGENTS.md) before making changes.
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
game-server origin/port. Confirm `WEB_ORIGIN` exactly matches the browser origin,
then check HTTPS versus HTTP, proxy
WebSocket support, cookie availability, and browser network errors. A ticket is
single-use and expires after 60 seconds, so reload/reconnect through the normal
HTTP ticket flow rather than reusing a captured ticket. After server restart,
request a new ticket and expect a full snapshot.

### Cookies Were Cleared

The server cannot recover participant identity without the scoped HttpOnly
cookie. Join the lobby as a new participant with an available username. If a
round is active, the new participant waits for the next round; there is no
cross-device or administrator slot-reclaim flow.
