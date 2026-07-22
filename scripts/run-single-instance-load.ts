import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { chromium, expect, type Page } from "@playwright/test";
import { io as createSocketClient, type Socket } from "socket.io-client";

import {
  ActiveLobbyEventSchema,
  CommandAckSchema,
  CONTRACT_SCHEMA_VERSION,
  ErrorSchema,
  MutationCommandSchema,
  RUNTIME_CONFIG_DEFAULTS,
  SnapshotMessageSchema,
  SnapshotSchema,
  type ActiveLobbyEvent,
  type CommandAck,
  type MutationCommand,
  type Snapshot,
} from "../packages/contracts/src/index.js";
import { connectDatabase } from "../packages/database/src/index.js";
import { patternCatalog } from "../packages/patterns/src/index.js";
import {
  findAvailableLoopbackPorts,
  performanceBrowserLaunchOptions,
  runWithBoundedCleanup,
  summarizePerformanceSamples,
  type CleanupStep,
} from "../packages/test-support/src/index.js";
import {
  createGameServer,
  type AuthenticatedRealtimeIdentity,
  type GameServer,
  type RealtimePresenceGracePeriod,
} from "../apps/game-server/src/socket-server.js";
import { subscribeGameServerToActiveLobbyEvents } from "../apps/game-server/src/runtime.js";
import { PARTICIPANT_SESSION_COOKIE_NAME } from "../apps/web/src/participant-session.js";

const LOBBY_COUNT = RUNTIME_CONFIG_DEFAULTS.maxActiveLobbies;
const PARTICIPANTS_PER_LOBBY = RUNTIME_CONFIG_DEFAULTS.maxPlayersPerLobby;
const WARM_UP_CALLS = 5;
const MEASURED_CALLS = 30;
const TOTAL_CALLS = WARM_UP_CALLS + MEASURED_CALLS;
const CALL_PHASE_MILLISECONDS = 50;
const CONNECTION_BATCH_SIZE = 1;
// Fixture setup is outside the measured workload and stays serial to avoid
// manufacturing unrelated Serializable conflicts in the shared test database.
const DATABASE_BATCH_SIZE = 1;
const CLEANUP_TIMEOUT_MILLISECONDS = 120_000;

type LoadEndpoints = {
  readonly realtimeOrigin: string;
  readonly realtimePort: number;
  readonly realtimeUrl: string;
  readonly webPort: number;
  readonly webUrl: string;
};

type Database = Awaited<ReturnType<typeof connectDatabase>>;

type ParticipantFixture = {
  readonly identity: AuthenticatedRealtimeIdentity;
  readonly username: string;
  readonly sessionToken: string;
  readonly sessionTokenHash: Uint8Array;
};

type LobbyFixture = {
  readonly id: string;
  readonly code: string;
  readonly participants: readonly ParticipantFixture[];
};

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
};

function waitForChild(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with ${signal ?? `exit code ${String(code)}`}.`));
    });
  });
}

async function runCommand(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn("bun", [...arguments_], {
    env: environment,
    stdio: "inherit",
  });
  await waitForChild(child, arguments_.join(" "));
}

async function waitForWebServer(child: ChildProcess, healthUrl: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The performance web server exited before becoming ready.");
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // Startup connection failures are expected until Next begins listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the performance web server.");
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function monotonicEpochMilliseconds(): number {
  return performance.timeOrigin + performance.now();
}

function hashCredential(credential: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(credential).digest());
}

function credential(): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}

function lobbyCode(index: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let remaining = index;
  let code = "";
  for (let position = 0; position < 6; position += 1) {
    code = alphabet[remaining % alphabet.length]! + code;
    remaining = Math.floor(remaining / alphabet.length);
  }
  return code;
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  label: string,
  timeoutMilliseconds = 30_000,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function cleanupStep(label: string, run: () => Promise<void>): CleanupStep {
  return {
    label,
    async run() {
      const startedAt = monotonicEpochMilliseconds();
      console.info(`US060_CLEANUP started ${label}`);
      try {
        await run();
        console.info(
          `US060_CLEANUP completed ${label} ${String(Math.round(monotonicEpochMilliseconds() - startedAt))}ms`,
        );
      } catch (error) {
        console.error(`US060_CLEANUP failed ${label}`);
        throw error;
      }
    },
  };
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function stopChild(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await withTimeout(waitForChildExit(child), `${label} to stop`, 5_000);
  } catch {
    child.kill("SIGKILL");
    await withTimeout(waitForChildExit(child), `${label} to be killed`, 5_000);
  }
}

async function inBatches<Item>(
  items: readonly Item[],
  batchSize: number,
  operation: (item: Item) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const results = await Promise.allSettled(
      items.slice(offset, offset + batchSize).map(operation),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function seedLoadFixtures(database: Database): Promise<readonly LobbyFixture[]> {
  const lobbies: LobbyFixture[] = [];
  for (let lobbyIndex = 0; lobbyIndex < LOBBY_COUNT; lobbyIndex += 1) {
    const id = `load-lobby-${randomUUID()}`;
    const code = lobbyCode(lobbyIndex);
    const participants = Array.from({ length: PARTICIPANTS_PER_LOBBY }, (_, participantIndex) => {
      const sessionToken = credential();
      return {
        identity: {
          lobbyId: id,
          participantId: `load-participant-${lobbyIndex}-${participantIndex}-${randomUUID()}`,
          participantSessionId: `load-session-${lobbyIndex}-${participantIndex}-${randomUUID()}`,
        },
        username: `${participantIndex === 0 ? "Host" : "Player"} ${lobbyIndex}-${participantIndex}`,
        sessionToken,
        sessionTokenHash: hashCredential(sessionToken),
      };
    });
    const host = participants[0]!;
    const created = await database.lobbyStates.createLobbyWithHost({
      lobbyId: id,
      participantId: host.identity.participantId,
      sessionId: host.identity.participantSessionId,
      commandId: `load-create-${randomUUID()}`,
      username: host.username,
      themeId: "animals",
      tokenHash: host.sessionTokenHash,
      issuedAt: new Date(),
      maxActiveLobbies: LOBBY_COUNT,
      nextCode: () => code,
    });
    if (!created.ok) throw new Error(created.error.message);
    lobbies.push({ id, code: created.entry.lobbyCode, participants });
  }

  await inBatches(lobbies, DATABASE_BATCH_SIZE, async (lobby) => {
    for (const participant of lobby.participants.slice(1)) {
      const joined = await database.lobbyStates.joinLobbyWithSession({
        lobbyId: lobby.id,
        lobbyCode: lobby.code,
        participantId: participant.identity.participantId,
        sessionId: participant.identity.participantSessionId,
        commandId: `load-join-${randomUUID()}`,
        username: participant.username,
        tokenHash: participant.sessionTokenHash,
        issuedAt: new Date(),
        maxPlayersPerLobby: PARTICIPANTS_PER_LOBBY,
      });
      if (!joined.ok) throw new Error(joined.error.message);
    }
  });

  const rejectedToken = credential();
  const rejected = await database.lobbyStates.createLobbyWithHost({
    lobbyId: `load-rejected-${randomUUID()}`,
    participantId: `load-rejected-participant-${randomUUID()}`,
    sessionId: `load-rejected-session-${randomUUID()}`,
    commandId: `load-rejected-command-${randomUUID()}`,
    username: "Rejected capacity host",
    themeId: "animals",
    tokenHash: hashCredential(rejectedToken),
    issuedAt: new Date(),
    maxActiveLobbies: LOBBY_COUNT,
    nextCode: () => lobbyCode(LOBBY_COUNT),
  });
  expect(rejected).toMatchObject({
    ok: false,
    error: { code: "ACTIVE_LOBBY_LIMIT_REACHED" },
  });
  return lobbies;
}

class LoadClient {
  readonly calls: Extract<ActiveLobbyEvent, { readonly type: "call" }>[] = [];
  private readonly acknowledgements = new Map<string, Deferred<CommandAck>>();
  private readonly snapshotWaiters: Deferred<Snapshot>[] = [];
  private initialSnapshot = deferred<Snapshot>();
  private connected = deferred<void>();

  constructor(
    readonly fixture: ParticipantFixture,
    readonly socket: Socket,
  ) {
    socket.on("connect", () => this.connected.resolve());
    socket.on("connect_error", (error) => {
      this.connected.reject(error);
      this.initialSnapshot.reject(error);
    });
    socket.on("v1:snapshot", (message: unknown) => {
      const snapshot = SnapshotMessageSchema.parse(message).snapshot;
      const waiter = this.snapshotWaiters.shift();
      if (waiter === undefined) this.initialSnapshot.resolve(snapshot);
      else waiter.resolve(snapshot);
    });
    socket.on("v1:lobby-event", (message: unknown) => {
      const event = ActiveLobbyEventSchema.parse(message);
      if (event.type === "call") this.calls.push(event);
    });
    socket.on("v1:ack", (message: unknown) => {
      const acknowledgement = CommandAckSchema.parse(message);
      this.acknowledgements.get(acknowledgement.commandId)?.resolve(acknowledgement);
      this.acknowledgements.delete(acknowledgement.commandId);
    });
    socket.on("v1:error", (message: unknown) => {
      const error = ErrorSchema.parse(message);
      if (error.commandId !== null) {
        this.acknowledgements.get(error.commandId)?.reject(new Error(error.code));
        this.acknowledgements.delete(error.commandId);
      }
    });
  }

  async establish(): Promise<Snapshot> {
    this.socket.connect();
    await withTimeout(this.connected.promise, "a load client connection");
    return withTimeout(this.initialSnapshot.promise, "a load client snapshot");
  }

  send(command: MutationCommand): Promise<CommandAck> {
    const acknowledgement = deferred<CommandAck>();
    this.acknowledgements.set(command.commandId, acknowledgement);
    this.socket.emit("v1:command", command);
    return withTimeout(acknowledgement.promise, `acknowledgement ${command.commandId}`);
  }

  requestSnapshot(lastEventSequence: number | null): Promise<Snapshot> {
    const snapshot = deferred<Snapshot>();
    this.snapshotWaiters.push(snapshot);
    this.socket.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resync",
      lastEventSequence,
    });
    return withTimeout(snapshot.promise, "a resynchronized snapshot");
  }
}

async function issueTicket(database: Database, participant: ParticipantFixture): Promise<string> {
  const ticket = credential();
  const issued = await database.lobbyStates.issueRealtimeTicket({
    lobbyId: participant.identity.lobbyId,
    sessionTokenHash: participant.sessionTokenHash,
    ticketHash: hashCredential(ticket),
    ttlSeconds: 60,
  });
  if (!issued.ok) throw new Error(issued.error.code);
  return ticket;
}

async function openLoadClient(
  database: Database,
  participant: ParticipantFixture,
  endpoints: LoadEndpoints,
): Promise<{ readonly client: LoadClient; readonly snapshot: Snapshot }> {
  const ticket = await issueTicket(database, participant);
  const socket = createSocketClient(endpoints.realtimeUrl, {
    autoConnect: false,
    auth: { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket },
    extraHeaders: { Origin: endpoints.realtimeOrigin },
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  const client = new LoadClient(participant, socket);
  try {
    return { client, snapshot: await client.establish() };
  } catch (error) {
    socket.disconnect();
    throw error;
  }
}

async function startAuthority(database: Database, endpoints: LoadEndpoints) {
  const commitTimes = new Map<string, number>();
  const commitWaiters = new Map<string, Deferred<number>>();
  const measuredDisconnects = new Map<string, Deferred<RealtimePresenceGracePeriod | null>>();
  const server: GameServer = createGameServer({
    allowedOrigin: endpoints.realtimeOrigin,
    clock: () => new Date(),
    ticketConsumer: database.lobbyStates,
    commandExecutor: {
      execute: async ({ identity, command }) => {
        const result = await database.roundCommands.executeAuthenticated({ ...identity, command });
        if (!result.ok) return result;
        const committedAt = monotonicEpochMilliseconds();
        commitTimes.set(command.commandId, committedAt);
        commitWaiters.get(command.commandId)?.resolve(committedAt);
        commitWaiters.delete(command.commandId);
        return {
          ...result,
          acknowledgement: CommandAckSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "ack",
            ...result.acknowledgement,
            occurredAt: result.acknowledgement.occurredAt.toISOString(),
          }),
        };
      },
    },
    snapshotProvider: {
      findAuthorizedSnapshot: (identity) =>
        database.lobbyStates.findAuthorizedSnapshotByIdentity(identity),
    },
    identityAuthorizer: {
      isIdentityActive: (identity) =>
        database.lobbyStates.isParticipantSessionIdentityActive(identity),
    },
    presenceLifecycle: {
      registerConnection: (identity) => database.lobbyStates.registerRealtimeConnection(identity),
      recordHeartbeat: (identity) => database.lobbyStates.recordRealtimeHeartbeat(identity),
      unregisterConnection: async (identity, presenceGeneration) => {
        const measured = measuredDisconnects.get(identity.participantSessionId);
        if (measured === undefined) return null;
        const grace = await database.lobbyStates.unregisterRealtimeConnection({
          ...identity,
          presenceGeneration,
          reconnectWindowSeconds: 120,
          disconnectPauseGraceSeconds: 10,
        });
        measured.resolve(grace);
        measuredDisconnects.delete(identity.participantSessionId);
        return grace;
      },
      expireGracePeriod: (grace) => database.lobbyStates.expireRealtimePresenceGrace(grace),
    },
    automaticCallLifecycle: {
      findAutomaticCallLeases: () => database.roundCommands.findAutomaticCallLeases(),
      findAutomaticCallLease: (lobbyId) => database.roundCommands.findAutomaticCallLease(lobbyId),
      executeAutomaticCall: (lease) => database.roundCommands.executeAutomaticCall(lease),
    },
    coWinnerSettlementLifecycle: {
      findCoWinnerSettlementLeases: () => database.roundCommands.findCoWinnerSettlementLeases(),
      findCoWinnerSettlementLease: (lobbyId) =>
        database.roundCommands.findCoWinnerSettlementLease(lobbyId),
      executeCoWinnerSettlement: (lease) => database.roundCommands.executeCoWinnerSettlement(lease),
    },
    limits: {
      connectionsPerMinute: 10_000,
      commandsPerMinute: 10_000,
      maximumConnections: 10_000,
      connectionsPerSession: 8,
    },
  });
  const subscription = await subscribeGameServerToActiveLobbyEvents(
    database.activeLobbyEvents,
    server,
  );
  await server.listen({ host: "127.0.0.1", port: endpoints.realtimePort });

  return {
    server,
    subscription,
    waitForCommit(commandId: string): Promise<number> {
      const committedAt = commitTimes.get(commandId);
      if (committedAt !== undefined) return Promise.resolve(committedAt);
      const waiter = deferred<number>();
      commitWaiters.set(commandId, waiter);
      return withTimeout(waiter.promise, `commit ${commandId}`);
    },
    trackDisconnect(participantSessionId: string) {
      const waiter = deferred<RealtimePresenceGracePeriod | null>();
      measuredDisconnects.set(participantSessionId, waiter);
      return withTimeout(waiter.promise, `disconnect ${participantSessionId}`);
    },
  };
}

async function executeSetupCommand(
  database: Database,
  host: ParticipantFixture,
  command: MutationCommand,
): Promise<void> {
  const result = await database.roundCommands.executeAuthenticated({
    ...host.identity,
    command,
  });
  if (!result.ok) throw new Error(result.error.code);
}

async function startRounds(database: Database, lobbies: readonly LobbyFixture[]): Promise<void> {
  await inBatches(lobbies, DATABASE_BATCH_SIZE, async (lobby) => {
    const host = lobby.participants[0]!;
    await executeSetupCommand(
      database,
      host,
      MutationCommandSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "create-round",
        commandId: `load-round-${randomUUID()}`,
      }),
    );
    await executeSetupCommand(
      database,
      host,
      MutationCommandSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "configure",
        commandId: `load-configure-${randomUUID()}`,
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      }),
    );
    await executeSetupCommand(
      database,
      host,
      MutationCommandSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "start-round",
        commandId: `load-start-${randomUUID()}`,
      }),
    );
  });
}

function commonSnapshotProjection(snapshot: Snapshot): unknown {
  return {
    lastEventSequence: snapshot.lastEventSequence,
    lobby: snapshot.lobby,
    participants: [...snapshot.participants].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    round: snapshot.round,
    calls: snapshot.calls,
    timer: snapshot.timer,
  };
}

async function waitForCallDelivery(
  clients: readonly LoadClient[],
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (clients.every((client) => client.calls.length >= expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const minimum = Math.min(...clients.map((client) => client.calls.length));
  throw new Error(
    `Timed out waiting for call ${expected}; the minimum client count was ${minimum}.`,
  );
}

type RenderObservation = {
  readonly observedAt: number;
  readonly renderedLabel: string;
};

async function installRenderProbe(page: Page) {
  const rendered = new Map<number, RenderObservation>();
  const waiters = new Map<number, Deferred<RenderObservation>>();
  await page.exposeFunction("__recordUs060CallRender", (count: number, renderedLabel: string) => {
    const observation = { observedAt: monotonicEpochMilliseconds(), renderedLabel };
    rendered.set(count, observation);
    waiters.get(count)?.resolve(observation);
    waiters.delete(count);
  });
  await page.evaluate(() => {
    let priorCount = document.querySelectorAll(".call-history li").length;
    const report = (
      globalThis as unknown as {
        __recordUs060CallRender: (count: number, renderedLabel: string) => void;
      }
    ).__recordUs060CallRender;
    new MutationObserver(() => {
      const count = document.querySelectorAll(".call-history li").length;
      if (count === priorCount) return;
      priorCount = count;
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          report(
            count,
            document.querySelector(".call-history li:last-child")?.textContent?.trim() ?? "",
          ),
        ),
      );
    }).observe(document.body, { childList: true, subtree: true });
  });
  return (count: number) => {
    const observation = rendered.get(count);
    if (observation !== undefined) return Promise.resolve(observation);
    const waiter = deferred<RenderObservation>();
    waiters.set(count, waiter);
    return withTimeout(waiter.promise, `browser render ${count}`);
  };
}

function ballLabel(ball: number): string {
  const letters = ["B", "I", "N", "G", "O"] as const;
  const letter = letters[Math.floor((ball - 1) / 15)];
  if (letter === undefined) throw new RangeError("A Bingo ball must be between 1 and 75.");
  return `${letter} ${String(ball)}`;
}

async function runLoad(page: Page, databaseUrl: string, endpoints: LoadEndpoints): Promise<void> {
  const database = await connectDatabase(databaseUrl, {
    roundCommands: {
      patterns: patternCatalog,
      nearWinFeedbackEnabled: true,
      coWinnerWindowMs: 2_000,
      clock: () => new Date(),
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      nextId: (prefix) => `${prefix}-${randomUUID()}`,
    },
  });
  const clients: LoadClient[] = [];
  let authority: Awaited<ReturnType<typeof startAuthority>> | null = null;

  await runWithBoundedCleanup(
    async () => {
      const lobbies = await seedLoadFixtures(database);
      console.info(`US060_PHASE seeded ${lobbies.length} lobbies`);
      const activeAuthority = await startAuthority(database, endpoints);
      authority = activeAuthority;
      console.info("US060_PHASE authority listening");
      const browserParticipant = lobbies[0]!.participants.at(-1)!;
      const nodeParticipants = Array.from(
        { length: PARTICIPANTS_PER_LOBBY },
        (_, participantIndex) => lobbies.map((lobby) => lobby.participants[participantIndex]!),
      )
        .flat()
        .filter(
          (participant) =>
            participant.identity.participantSessionId !==
            browserParticipant.identity.participantSessionId,
        );

      await inBatches(nodeParticipants, CONNECTION_BATCH_SIZE, async (participant) => {
        clients.push((await openLoadClient(database, participant, endpoints)).client);
        if (clients.length % 250 === 0) {
          console.info(`US060_PHASE connected ${clients.length} Node clients`);
        }
      });
      expect(clients).toHaveLength(LOBBY_COUNT * PARTICIPANTS_PER_LOBBY - 1);

      await page.context().addCookies([
        {
          name: PARTICIPANT_SESSION_COOKIE_NAME,
          value: browserParticipant.sessionToken,
          domain: "localhost",
          path: `/api/v1/lobbies/${lobbies[0]!.code}`,
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
        },
      ]);
      await page.goto(`${endpoints.realtimeOrigin}/lobbies/${lobbies[0]!.code}`);
      await expect(
        page.getByRole("region", { name: "Live game status" }).locator(".connection-state"),
      ).toHaveText("Connected", { timeout: 30_000 });
      await expect(
        page.getByRole("list", { name: "Participants" }).getByRole("listitem"),
      ).toHaveCount(PARTICIPANTS_PER_LOBBY);
      const waitForRender = await installRenderProbe(page);

      await startRounds(database, lobbies);
      console.info("US060_PHASE started 100 rounds");
      await expect(page.locator(".bingo-card-cell")).toHaveCount(25, { timeout: 30_000 });

      const hostClients = lobbies.map((lobby) => {
        const client = clients.find(
          (client) =>
            client.fixture.identity.participantSessionId ===
            lobby.participants[0]!.identity.participantSessionId,
        );
        if (client === undefined) throw new Error("A load lobby host is not connected.");
        return client;
      });
      const commandToCommit: number[] = [];
      const commitToRender: number[] = [];
      let measuredStartedAt: number | null = null;

      for (let callIndex = 0; callIndex < TOTAL_CALLS; callIndex += 1) {
        if (callIndex === WARM_UP_CALLS) measuredStartedAt = monotonicEpochMilliseconds();
        const browserRender = waitForRender(callIndex + 1);
        const results = await Promise.all(
          hostClients.map(
            async (
              client,
              lobbyIndex,
            ): Promise<{
              readonly acknowledgement: CommandAck;
              readonly committedAt: number;
              readonly lobbyIndex: number;
              readonly startedAt: number;
            }> => {
              const phase = (lobbyIndex + callIndex * 37) % LOBBY_COUNT;
              await wait(phase * CALL_PHASE_MILLISECONDS);
              const command = MutationCommandSchema.parse({
                schemaVersion: CONTRACT_SCHEMA_VERSION,
                type: "call-next",
                commandId: `load-call-${lobbyIndex}-${callIndex}-${randomUUID()}`,
              });
              const startedAt = monotonicEpochMilliseconds();
              const [acknowledgement, committedAt] = await Promise.all([
                client.send(command),
                activeAuthority.waitForCommit(command.commandId),
              ]);
              return {
                acknowledgement,
                committedAt,
                lobbyIndex,
                startedAt,
              };
            },
          ),
        );
        await waitForCallDelivery(clients, callIndex + 1);
        for (const result of results) {
          expect(result.acknowledgement.eventSequence).toBe(
            hostClients[result.lobbyIndex]!.calls[callIndex]!.eventSequence,
          );
        }
        const renderObservation = await browserRender;
        const browserResult = results[0]!;
        const browserEvent = hostClients[0]!.calls[callIndex]!;
        expect(renderObservation.renderedLabel).toBe(ballLabel(browserEvent.call.ball));
        if (callIndex >= WARM_UP_CALLS) {
          commandToCommit.push(
            ...results.map(({ committedAt, startedAt }) => committedAt - startedAt),
          );
          commitToRender.push(renderObservation.observedAt - browserResult.committedAt);
        }
        expect(results.every(({ acknowledgement }) => !acknowledgement.idempotentReplay)).toBe(
          true,
        );
        if ((callIndex + 1) % 5 === 0) {
          console.info(`US060_PHASE completed call wave ${callIndex + 1}`);
        }
      }
      if (measuredStartedAt === null) throw new Error("The measured call phase did not start.");
      const measuredElapsedSeconds = (monotonicEpochMilliseconds() - measuredStartedAt) / 1_000;

      for (const lobby of lobbies) {
        const lobbyClients = clients.filter(
          (client) => client.fixture.identity.lobbyId === lobby.id,
        );
        const reference = lobbyClients[0]!.calls.map((event) => ({
          id: event.call.id,
          sequence: event.eventSequence,
          position: event.type === "call" ? event.call.position : null,
          ball: event.type === "call" ? event.call.ball : null,
        }));
        expect(reference).toHaveLength(TOTAL_CALLS);
        expect(new Set(reference.map(({ ball }) => ball)).size).toBe(TOTAL_CALLS);
        expect(reference.map(({ position }) => position)).toEqual(
          Array.from({ length: TOTAL_CALLS }, (_, index) => index + 1),
        );
        expect(
          reference
            .slice(1)
            .every((event, index) => event.sequence === reference[index]!.sequence + 1),
        ).toBe(true);
        for (const client of lobbyClients.slice(1)) {
          expect(
            client.calls.map((event) => ({
              id: event.call.id,
              sequence: event.eventSequence,
              position: event.type === "call" ? event.call.position : null,
              ball: event.type === "call" ? event.call.ball : null,
            })),
          ).toEqual(reference);
        }
      }
      await expect(page.locator(".call-history li")).toHaveCount(TOTAL_CALLS);

      const snapshotReconnect: number[] = [];
      const snapshots = new Map<string, Snapshot[]>();
      console.info("US060_PHASE starting measured reconnects");
      for (let offset = 0; offset < lobbies.length; offset += DATABASE_BATCH_SIZE) {
        const batch = lobbies.slice(offset, offset + DATABASE_BATCH_SIZE);
        await Promise.all(
          batch.map(async (lobby) => {
            const participant = lobby.participants[1]!;
            const existingIndex = clients.findIndex(
              (client) =>
                client.fixture.identity.participantSessionId ===
                participant.identity.participantSessionId,
            );
            const existing = clients[existingIndex]!;
            const disconnected = activeAuthority.trackDisconnect(
              participant.identity.participantSessionId,
            );
            existing.socket.disconnect();
            await disconnected;
            const startedAt = monotonicEpochMilliseconds();
            const rejoined = await database.lobbyStates.rejoinLobbyWithSession({
              lobbyId: lobby.id,
              tokenHash: participant.sessionTokenHash,
              commandId: `load-rejoin-${randomUUID()}`,
            });
            if (rejoined === null || !rejoined.ok) throw new Error("Measured rejoin failed.");
            const replacement = await openLoadClient(database, participant, endpoints);
            snapshotReconnect.push(monotonicEpochMilliseconds() - startedAt);
            expect(replacement.snapshot.calls).toHaveLength(TOTAL_CALLS);
            snapshots.set(lobby.id, [replacement.snapshot]);
            clients[existingIndex] = replacement.client;
          }),
        );
        console.info(
          `US060_PHASE measured ${Math.min(offset + DATABASE_BATCH_SIZE, LOBBY_COUNT)} reconnects`,
        );
      }

      await inBatches(hostClients, DATABASE_BATCH_SIZE, async (client) => {
        const snapshot = await client.requestSnapshot(null);
        const group = snapshots.get(client.fixture.identity.lobbyId) ?? [];
        group.push(snapshot);
        snapshots.set(client.fixture.identity.lobbyId, group);
      });
      const browserSnapshotBody = await page.evaluate(async (code) => {
        const response = await fetch(`/api/v1/lobbies/${code}/snapshot`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        return { body: await response.json(), status: response.status };
      }, lobbies[0]!.code);
      expect(browserSnapshotBody.status).toBe(200);
      const browserSnapshot = SnapshotMessageSchema.parse(browserSnapshotBody.body).snapshot;
      snapshots.get(lobbies[0]!.id)!.push(browserSnapshot);

      for (const lobby of lobbies) {
        const durable = await database.lobbyStates.findById(lobby.id);
        if (durable?.round === null || durable === null) throw new Error("Load lobby disappeared.");
        expect(durable.participants).toHaveLength(PARTICIPANTS_PER_LOBBY);
        expect(durable.round.calls).toHaveLength(TOTAL_CALLS);
        const lobbySnapshots = snapshots.get(lobby.id)!;
        expect(lobbySnapshots).toHaveLength(lobby.id === lobbies[0]!.id ? 3 : 2);
        const common = commonSnapshotProjection(lobbySnapshots[0]!);
        for (const snapshot of lobbySnapshots) {
          expect(SnapshotSchema.safeParse(snapshot).success).toBe(true);
          expect(commonSnapshotProjection(snapshot)).toEqual(common);
          expect(snapshot.calls).toEqual(
            durable.round.calls.map((call) => ({
              id: call.id,
              roundId: durable.round!.id,
              position: call.position,
              ball: call.ball,
              calledAt: call.calledAt.toISOString(),
            })),
          );
          const expectedCard = durable.round.cards.find(
            ({ participantId }) => participantId === snapshot.self.id,
          );
          expect(snapshot.ownCard).toEqual(
            expectedCard === undefined
              ? null
              : {
                  id: expectedCard.id,
                  roundId: durable.round.id,
                  participantId: expectedCard.participantId,
                  cells: expectedCard.cells.map((cell, index) =>
                    index === 12 && cell === 0 ? "FREE" : cell,
                  ),
                },
          );
          expect(snapshot.ownMarks).toEqual(
            expectedCard?.marks.map((mark) => ({
              id: mark.id,
              cardId: expectedCard.id,
              ball: mark.ball,
              markedAt: mark.markedAt.toISOString(),
            })) ?? [],
          );
          expect(JSON.stringify(snapshot)).not.toMatch(
            /drawOrder|tokenHash|commandResults|activeLobbyEvents|futureDraw/,
          );
        }
      }

      expect(commandToCommit).toHaveLength(LOBBY_COUNT * MEASURED_CALLS);
      expect(commitToRender).toHaveLength(MEASURED_CALLS);
      expect(snapshotReconnect).toHaveLength(LOBBY_COUNT);

      const metrics = {
        commandToCommit: summarizePerformanceSamples(commandToCommit),
        commitToRender: summarizePerformanceSamples(commitToRender),
        snapshotReconnect: summarizePerformanceSamples(snapshotReconnect),
      };
      const report = {
        generatedAt: new Date().toISOString(),
        workload: {
          activeLobbies: LOBBY_COUNT,
          participantsPerLobby: PARTICIPANTS_PER_LOBBY,
          connectedParticipants: LOBBY_COUNT * PARTICIPANTS_PER_LOBBY,
          warmUpCallsPerLobby: WARM_UP_CALLS,
          measuredCallsPerLobby: MEASURED_CALLS,
          callPhaseMilliseconds: CALL_PHASE_MILLISECONDS,
        },
        throughput: {
          callsPerSecond: (LOBBY_COUNT * MEASURED_CALLS) / measuredElapsedSeconds,
          deliveriesPerSecond:
            (LOBBY_COUNT * MEASURED_CALLS * PARTICIPANTS_PER_LOBBY) / measuredElapsedSeconds,
        },
        metrics,
      };
      await mkdir("test-results", { recursive: true });
      await writeFile(
        "test-results/single-instance-performance.json",
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.info(`US060_METRICS ${JSON.stringify(report)}`);
      expect(commandToCommit.every((sample) => sample >= 0)).toBe(true);
      expect(commitToRender.every((sample) => sample >= 0)).toBe(true);
      expect(snapshotReconnect.every((sample) => sample >= 0)).toBe(true);
      expect(metrics.commitToRender.p95Milliseconds).toBeLessThan(250);
    },
    [
      cleanupStep("clients", async () => {
        for (const client of clients) client.socket.disconnect();
      }),
      cleanupStep("authority", async () => authority?.server.close()),
      cleanupStep("subscription", async () => authority?.subscription.close()),
      cleanupStep("database", () => database.disconnect()),
    ],
    CLEANUP_TIMEOUT_MILLISECONDS,
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env["TEST_DATABASE_URL"];
  if (process.env["RUN_SINGLE_INSTANCE_LOAD"] !== "true") {
    throw new Error("RUN_SINGLE_INSTANCE_LOAD=true is required for the performance harness.");
  }
  if (process.env["E2E_DATABASE_CONFIRMED_NONPRODUCTION"] !== "true") {
    throw new Error(
      "E2E_DATABASE_CONFIRMED_NONPRODUCTION=true is required for the performance harness.",
    );
  }
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("TEST_DATABASE_URL is required for the performance harness.");
  }

  const ports = await findAvailableLoopbackPorts(2);
  const webPort = ports[0]!;
  const realtimePort = ports[1]!;
  const endpoints: LoadEndpoints = {
    realtimeOrigin: `http://localhost:${String(webPort)}`,
    realtimePort,
    realtimeUrl: `http://127.0.0.1:${String(realtimePort)}`,
    webPort,
    webUrl: `http://127.0.0.1:${String(webPort)}`,
  };

  const environment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    E2E_DATABASE_CONFIRMED_NONPRODUCTION: "true",
    NEXT_PUBLIC_GAME_SERVER_URL: endpoints.realtimeUrl,
    TEST_DATABASE_URL: databaseUrl,
    WEB_ORIGIN: endpoints.realtimeOrigin,
  };
  await runCommand(["packages/database/scripts/assert-empty-e2e-database.ts"], environment);
  await runCommand(["run", "--cwd", "apps/web", "build"], environment);

  const webServer = spawn(
    "bun",
    [
      "run",
      "--cwd",
      "apps/web",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(endpoints.webPort),
    ],
    { env: environment, stdio: "inherit" },
  );
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  await runWithBoundedCleanup(
    async () => {
      await waitForWebServer(webServer, `${endpoints.webUrl}/api/v1/patterns`);
      browser = await chromium.launch(
        performanceBrowserLaunchOptions(process.env["PLAYWRIGHT_BROWSER_CHANNEL"]),
      );
      const context = await browser.newContext();
      const page = await context.newPage();
      await runWithBoundedCleanup(
        () => runLoad(page, databaseUrl, endpoints),
        [cleanupStep("browser context", () => context.close())],
        CLEANUP_TIMEOUT_MILLISECONDS,
      );
    },
    [
      cleanupStep("browser", async () => browser?.close()),
      cleanupStep("web server", () => stopChild(webServer, "performance web server")),
    ],
    CLEANUP_TIMEOUT_MILLISECONDS,
  );
}

await main();
