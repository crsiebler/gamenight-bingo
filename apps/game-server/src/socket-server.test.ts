import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  CONTRACT_SCHEMA_VERSION,
  ActiveLobbyEventSchema,
  CommandAckSchema,
  ErrorSchema,
  MutationCommandSchema,
  ParticipantPrivateEventSchema,
  SnapshotSchema,
  type MutationCommand,
  type ParticipantPrivateEvent,
  type Snapshot,
} from "@gamenight-bingo/contracts";
import {
  connectDatabase,
  type CoWinnerSettlementLease,
  type NewActiveLobbyState,
  type OperationalLogger,
} from "@gamenight-bingo/database";
import { patternCatalog } from "@gamenight-bingo/patterns";
import { findAvailableLoopbackPorts, runWithBoundedCleanup } from "@gamenight-bingo/test-support";
import { io as createClient, Manager, type Socket } from "socket.io-client";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AuthenticatedConnectionCapacity,
  BoundedFixedWindowRateLimiter,
  createGameServer,
  type AuthenticatedRealtimeIdentity,
  type GameServer,
  type GameServerOptions,
  type RealtimeCommandExecutionResult,
} from "./socket-server.js";
import { subscribeGameServerToActiveLobbyEvents } from "./runtime.js";

const ORIGIN = "https://bingo.example.test";
const NOW = "2026-07-17T20:00:00.000Z";
const LATER = "2026-07-17T20:00:02.000Z";
const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const testDatabase = testDatabaseUrl === undefined ? test.skip : test;
const testProcessRestart =
  testDatabaseUrl !== undefined &&
  process.env["RUN_GAME_SERVER_RESTART_TEST"] === "true" &&
  process.env["E2E_DATABASE_CONFIRMED_NONPRODUCTION"] === "true"
    ? test
    : test.skip;
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

const identities = {
  host: {
    lobbyId: "lobby_alpha",
    participantId: "participant_host",
    participantSessionId: "session_host",
  },
  hostTab: {
    lobbyId: "lobby_alpha",
    participantId: "participant_host",
    participantSessionId: "session_host_tab",
  },
  player: {
    lobbyId: "lobby_alpha",
    participantId: "participant_player",
    participantSessionId: "session_player",
  },
  otherLobby: {
    lobbyId: "lobby_beta",
    participantId: "participant_other",
    participantSessionId: "session_other",
  },
} as const satisfies Record<string, AuthenticatedRealtimeIdentity>;

const waitingSnapshot = SnapshotSchema.parse({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  generatedAt: NOW,
  lastEventSequence: null,
  lobby: {
    id: identities.host.lobbyId,
    code: "ABC234",
    hostParticipantId: identities.host.participantId,
    themeId: "theme_classic",
    status: "waiting",
    createdAt: NOW,
  },
  session: {
    id: identities.host.participantSessionId,
    lobbyId: identities.host.lobbyId,
    participantId: identities.host.participantId,
    status: "active",
    issuedAt: NOW,
  },
  self: {
    id: identities.host.participantId,
    username: "Host",
    role: "host",
    roundEligibility: "waiting",
    presence: {
      participantId: identities.host.participantId,
      generation: 1,
      status: "connected",
      changedAt: NOW,
    },
  },
  participants: [
    {
      id: identities.host.participantId,
      username: "Host",
      role: "host",
      roundEligibility: "waiting",
      presence: {
        participantId: identities.host.participantId,
        generation: 1,
        status: "connected",
        changedAt: NOW,
      },
    },
  ],
  round: null,
  ownCard: null,
  ownMarks: [],
  calls: [],
  timer: null,
});

function waitingSnapshotForIdentity(identity: AuthenticatedRealtimeIdentity): Snapshot {
  const inPrimaryLobby = identity.lobbyId === identities.host.lobbyId;
  const hostParticipantId = inPrimaryLobby ? identities.host.participantId : identity.participantId;
  const isHost = identity.participantId === hostParticipantId;
  const summary = {
    id: identity.participantId,
    username: isHost ? "Host" : "Player",
    role: isHost ? ("host" as const) : ("player" as const),
    roundEligibility: "waiting" as const,
    presence: {
      participantId: identity.participantId,
      generation: 1,
      status: "connected" as const,
      changedAt: NOW,
    },
  };
  const hostSummary = {
    id: hostParticipantId,
    username: "Host",
    role: "host" as const,
    roundEligibility: "waiting" as const,
    presence: {
      participantId: hostParticipantId,
      generation: 1,
      status: "connected" as const,
      changedAt: NOW,
    },
  };

  return SnapshotSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    generatedAt: NOW,
    lastEventSequence: null,
    lobby: {
      id: identity.lobbyId,
      code: inPrimaryLobby ? "ABC234" : "DEF567",
      hostParticipantId,
      themeId: "theme_classic",
      status: "waiting",
      createdAt: NOW,
    },
    session: {
      id: identity.participantSessionId,
      lobbyId: identity.lobbyId,
      participantId: identity.participantId,
      status: "active",
      issuedAt: NOW,
    },
    self: summary,
    participants: isHost ? [summary] : [hostSummary, summary],
    round: null,
    ownCard: null,
    ownMarks: [],
    calls: [],
    timer: null,
  });
}

const activeSnapshot = SnapshotSchema.parse({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  generatedAt: NOW,
  lastEventSequence: 1,
  lobby: {
    id: identities.host.lobbyId,
    code: "ABC234",
    hostParticipantId: identities.host.participantId,
    themeId: "theme_classic",
    status: "active",
    createdAt: NOW,
    roundId: "round_one",
  },
  session: {
    id: identities.host.participantSessionId,
    lobbyId: identities.host.lobbyId,
    participantId: identities.host.participantId,
    status: "active",
    issuedAt: NOW,
  },
  self: {
    id: identities.host.participantId,
    username: "Host",
    role: "host",
    roundEligibility: "playing",
    presence: {
      participantId: identities.host.participantId,
      generation: 1,
      status: "connected",
      changedAt: NOW,
    },
  },
  participants: [
    {
      id: identities.host.participantId,
      username: "Host",
      role: "host",
      roundEligibility: "playing",
      presence: {
        participantId: identities.host.participantId,
        generation: 1,
        status: "connected",
        changedAt: NOW,
      },
    },
    {
      id: identities.player.participantId,
      username: "Player",
      role: "player",
      roundEligibility: "playing",
      presence: {
        participantId: identities.player.participantId,
        generation: 1,
        status: "connected",
        changedAt: NOW,
      },
    },
  ],
  round: {
    id: "round_one",
    lobbyId: identities.host.lobbyId,
    patternId: "standard-one-line",
    callConfiguration: { mode: "automatic", intervalSeconds: 30 },
    stage: "active",
    startedAt: NOW,
  },
  ownCard: {
    id: "card_host",
    roundId: "round_one",
    participantId: identities.host.participantId,
    cells: [
      1,
      16,
      31,
      46,
      61,
      2,
      17,
      32,
      47,
      62,
      3,
      18,
      "FREE",
      48,
      63,
      4,
      19,
      34,
      49,
      64,
      5,
      20,
      35,
      50,
      65,
    ],
  },
  ownMarks: [{ id: "mark_one", cardId: "card_host", ball: 1, markedAt: NOW }],
  calls: [{ id: "call_one", roundId: "round_one", position: 1, ball: 1, calledAt: NOW }],
  timer: { kind: "automatic-call", deadline: LATER },
});

const pausedSnapshot = SnapshotSchema.parse({
  ...activeSnapshot,
  generatedAt: LATER,
  lastEventSequence: 2,
  round: {
    ...activeSnapshot.round,
    stage: "paused",
    pauseReason: "host-command",
    pausedAt: LATER,
  },
  timer: null,
});

const resultSnapshot = SnapshotSchema.parse({
  ...activeSnapshot,
  generatedAt: "2026-07-17T20:00:04.000Z",
  lastEventSequence: 3,
  round: {
    ...activeSnapshot.round,
    stage: "result",
    result: {
      triggeringCallId: "call_one",
      openedAt: "2026-07-17T20:00:01.000Z",
      closesAt: LATER,
      settledAt: LATER,
      winnerParticipantIds: [identities.host.participantId],
    },
  },
  timer: null,
});

function createRestartLobbyState(): {
  readonly state: NewActiveLobbyState;
  readonly identity: AuthenticatedRealtimeIdentity;
  readonly sessionTokenHash: Uint8Array;
  readonly foreignCardId: string;
  readonly expectedSnapshot: (code: string, generatedAt: string) => Snapshot;
} {
  const suffix = randomUUID();
  const lobbyId = `lobby-restart-${suffix}`;
  const hostParticipantId = `participant-host-${suffix}`;
  const playerParticipantId = `participant-player-${suffix}`;
  const participantSessionId = `session-host-${suffix}`;
  const roundId = `round-restart-${suffix}`;
  const hostCardId = `card-host-${suffix}`;
  const foreignCardId = `card-player-${suffix}`;
  const callId = `call-restart-${suffix}`;
  const createdAt = new Date("2026-07-17T19:55:00.000Z");
  const startedAt = new Date(NOW);
  const calledAt = new Date("2026-07-17T20:00:00.500Z");
  const openedAt = new Date("2026-07-17T20:00:01.000Z");
  const closedAt = new Date(LATER);
  const sessionTokenHash = new Uint8Array(randomBytes(32));
  const hostCells = activeSnapshot.ownCard!.cells.map((cell) => (cell === "FREE" ? 0 : cell));
  const playerCells = [
    6, 21, 36, 51, 66, 7, 22, 37, 52, 67, 8, 23, 0, 53, 68, 9, 24, 39, 54, 69, 10, 25, 40, 55, 70,
  ];

  return {
    identity: { lobbyId, participantId: hostParticipantId, participantSessionId },
    sessionTokenHash,
    foreignCardId,
    expectedSnapshot: (code, generatedAt) =>
      SnapshotSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        generatedAt,
        lastEventSequence: 1,
        lobby: {
          id: lobbyId,
          code,
          hostParticipantId,
          themeId: "theme_classic",
          status: "active",
          createdAt: createdAt.toISOString(),
          roundId,
        },
        session: {
          id: participantSessionId,
          lobbyId,
          participantId: hostParticipantId,
          status: "active",
          issuedAt: createdAt.toISOString(),
        },
        self: {
          id: hostParticipantId,
          username: `Restart Host ${suffix}`,
          role: "host",
          roundEligibility: "playing",
          presence: {
            participantId: hostParticipantId,
            generation: 1,
            status: "connected",
            changedAt: startedAt.toISOString(),
          },
        },
        participants: [
          {
            id: hostParticipantId,
            username: `Restart Host ${suffix}`,
            role: "host",
            roundEligibility: "playing",
            presence: {
              participantId: hostParticipantId,
              generation: 1,
              status: "connected",
              changedAt: startedAt.toISOString(),
            },
          },
          {
            id: playerParticipantId,
            username: `Restart Player ${suffix}`,
            role: "player",
            roundEligibility: "playing",
            presence: {
              participantId: playerParticipantId,
              generation: 1,
              status: "connected",
              changedAt: startedAt.toISOString(),
            },
          },
        ],
        round: {
          id: roundId,
          lobbyId,
          patternId: "standard-one-line",
          callConfiguration: { mode: "automatic", intervalSeconds: 30 },
          stage: "result",
          continuationPatternId: "standard-two-lines",
          startedAt: startedAt.toISOString(),
          result: {
            triggeringCallId: callId,
            openedAt: openedAt.toISOString(),
            closesAt: closedAt.toISOString(),
            settledAt: closedAt.toISOString(),
            winnerParticipantIds: [hostParticipantId],
          },
        },
        ownCard: {
          id: hostCardId,
          roundId,
          participantId: hostParticipantId,
          cells: activeSnapshot.ownCard!.cells,
        },
        ownMarks: [
          {
            id: `mark-restart-${suffix}`,
            cardId: hostCardId,
            ball: 1,
            markedAt: calledAt.toISOString(),
          },
        ],
        calls: [
          {
            id: callId,
            roundId,
            position: 1,
            ball: 1,
            calledAt: calledAt.toISOString(),
          },
        ],
        timer: null,
      }),
    state: {
      lobby: {
        id: lobbyId,
        status: "active",
        themeId: "theme_classic",
        createdAt,
        lastActivityAt: closedAt,
        endedAt: null,
        lastEventSequence: 1n,
      },
      participants: [
        {
          id: hostParticipantId,
          username: `Restart Host ${suffix}`,
          normalizedUsername: `restart host ${suffix}`,
          role: "host",
          roundEligibility: "playing",
          joinedAt: createdAt,
          departedAt: null,
        },
        {
          id: playerParticipantId,
          username: `Restart Player ${suffix}`,
          normalizedUsername: `restart player ${suffix}`,
          role: "player",
          roundEligibility: "playing",
          joinedAt: createdAt,
          departedAt: null,
        },
      ],
      sessions: [
        {
          id: participantSessionId,
          participantId: hostParticipantId,
          tokenHash: sessionTokenHash,
          status: "active",
          issuedAt: createdAt,
          disconnectedAt: null,
          rejoinUntil: null,
          departedAt: null,
        },
      ],
      presenceGenerations: [
        {
          participantId: hostParticipantId,
          generation: 1n,
          status: "connected",
          connectionCount: 1,
          changedAt: startedAt,
          graceEndsAt: null,
          absentSince: null,
          departedAt: null,
          overridden: false,
          endedAt: null,
        },
        {
          participantId: playerParticipantId,
          generation: 1n,
          status: "connected",
          connectionCount: 1,
          changedAt: startedAt,
          graceEndsAt: null,
          absentSince: null,
          departedAt: null,
          overridden: false,
          endedAt: null,
        },
      ],
      round: {
        id: roundId,
        initialPatternId: "standard-one-line",
        currentPatternId: "standard-one-line",
        stage: "result",
        callMode: "automatic",
        callIntervalSeconds: 30,
        createdAt,
        startedAt,
        activeAt: startedAt,
        pausedAt: null,
        pauseReason: null,
        nextCallAt: null,
        coWinnerTriggeringCallId: callId,
        coWinnerOpenedAt: openedAt,
        coWinnerClosesAt: closedAt,
        resultSettledAt: closedAt,
        endedAt: null,
        drawOrder: Array.from({ length: 75 }, (_, index) => ({
          position: index + 1,
          ball: index + 1,
        })),
        cards: [
          {
            id: hostCardId,
            participantId: hostParticipantId,
            cells: hostCells,
            createdAt,
            marks: [{ id: `mark-restart-${suffix}`, ball: 1, markedAt: calledAt }],
          },
          {
            id: foreignCardId,
            participantId: playerParticipantId,
            cells: playerCells,
            createdAt,
            marks: [],
          },
        ],
        calls: [{ id: callId, position: 1, ball: 1, calledAt }],
        coWinners: [
          {
            participantId: hostParticipantId,
            cardId: hostCardId,
            triggeringCallId: callId,
            confirmedAt: closedAt,
          },
        ],
      },
      events: [
        {
          sequence: 1n,
          roundId,
          eventType: "co-winner-result",
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          payload: { winnerParticipantIds: [hostParticipantId] },
          createdAt: closedAt,
        },
      ],
      commandResults: [],
    },
  };
}

function randomLobbyCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
}

const stageEvent = ActiveLobbyEventSchema.parse({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  type: "stage",
  eventSequence: 1,
  occurredAt: NOW,
  round: {
    id: "round_one",
    lobbyId: identities.host.lobbyId,
    patternId: "standard-one-line",
    callConfiguration: { mode: "manual" },
    stage: "waiting",
    createdAt: NOW,
  },
});

const markEvent = ParticipantPrivateEventSchema.parse({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  type: "mark-result",
  commandId: "command_mark",
  occurredAt: NOW,
  mark: {
    id: "mark_one",
    cardId: "card_one",
    ball: 1,
    markedAt: NOW,
  },
}) as Extract<ParticipantPrivateEvent, { readonly type: "mark-result" }>;
const nearWinEvent = ParticipantPrivateEventSchema.parse({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  type: "near-win",
  occurredAt: NOW,
  requiredBall: 66,
});

function ticket(fill: number): string {
  return Buffer.alloc(32, fill).toString("base64url");
}

function ticketHash(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("hex");
}

function once<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}.`)), 2_000);
    socket.once(event, (value: T) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

function collectLobbySequences(socket: Socket, count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const sequences: number[] = [];
    const timeout = setTimeout(() => {
      socket.off("v1:lobby-event", onEvent);
      reject(new Error(`Timed out waiting for ${count} lobby events.`));
    }, 2_000);
    const onEvent = (event: { eventSequence: number }) => {
      sequences.push(event.eventSequence);
      if (sequences.length !== count) return;
      clearTimeout(timeout);
      socket.off("v1:lobby-event", onEvent);
      resolve(sequences);
    };
    socket.on("v1:lobby-event", onEvent);
  });
}

function expectNoEvent(socket: Socket, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      clearTimeout(timeout);
      reject(new Error(`Unexpected ${event} event.`));
    };
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, 75);
    socket.once(event, onEvent);
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function waitForSignal<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = realSetTimeout(
      () => reject(new Error(`Timed out waiting for ${label}.`)),
      2_000,
    );
    promise.then(
      (value) => {
        realClearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        realClearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      waitForChildExit(child),
      new Promise<never>((_resolve, reject) => {
        timeout = realSetTimeout(
          () => reject(new Error("Timed out stopping the game-server process.")),
          5_000,
        );
      }),
    ]);
  } catch {
    child.kill("SIGKILL");
    await waitForChildExit(child);
  } finally {
    if (timeout !== undefined) realClearTimeout(timeout);
  }
}

async function startGameServerProcess(
  environment: NodeJS.ProcessEnv,
  healthUrl: string,
): Promise<ChildProcess> {
  const child = spawn("bun", ["apps/game-server/src/index.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The game-server process exited before becoming healthy.");
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return child;
    } catch {
      // Connection failures are expected until the child binds its listener.
    }
    await new Promise((resolve) => realSetTimeout(resolve, 25));
  }
  await stopChild(child);
  throw new Error("Timed out waiting for the game-server process to become healthy.");
}

interface HarnessOptions {
  readonly clock?: () => Date;
  readonly tickets?: ReadonlyMap<string, AuthenticatedRealtimeIdentity>;
  readonly consumeTicket?: (ticketHash: string) => Promise<AuthenticatedRealtimeIdentity | null>;
  readonly execute?: (
    identity: AuthenticatedRealtimeIdentity,
    command: MutationCommand,
  ) => Promise<RealtimeCommandExecutionResult>;
  readonly snapshot?: (identity: AuthenticatedRealtimeIdentity) => Promise<Snapshot | null>;
  readonly authorize?: (identity: AuthenticatedRealtimeIdentity) => Promise<boolean>;
  readonly registerPresence?: (identity: AuthenticatedRealtimeIdentity) => Promise<number | null>;
  readonly recordHeartbeat?: (identity: AuthenticatedRealtimeIdentity) => Promise<boolean>;
  readonly unregisterPresence?: (
    identity: AuthenticatedRealtimeIdentity,
    presenceGeneration: number,
  ) => Promise<{
    readonly lobbyId: string;
    readonly participantId: string;
    readonly presenceGeneration: number;
    readonly graceEndsAt: Date;
  } | null>;
  readonly expirePresenceGrace?: (grace: {
    readonly lobbyId: string;
    readonly participantId: string;
    readonly presenceGeneration: number;
    readonly graceEndsAt: Date;
  }) => Promise<"expired" | "stale" | "too-early">;
  readonly initialPresenceGracePeriods?: readonly {
    readonly lobbyId: string;
    readonly participantId: string;
    readonly presenceGeneration: number;
    readonly graceEndsAt: Date;
  }[];
  readonly findAutomaticCallLeases?: () => Promise<
    readonly { lobbyId: string; roundId: string; deadline: Date }[]
  >;
  readonly findAutomaticCallLease?: (
    lobbyId: string,
  ) => Promise<{ lobbyId: string; roundId: string; deadline: Date } | null>;
  readonly executeAutomaticCall?: (lease: {
    lobbyId: string;
    roundId: string;
    deadline: Date;
  }) => Promise<"called" | "stale" | "too-early" | "blocked" | "exhausted">;
  readonly findCoWinnerSettlementLeases?: () => Promise<
    readonly {
      lobbyId: string;
      roundId: string;
      triggeringCallId: string;
      deadline: Date;
    }[]
  >;
  readonly findCoWinnerSettlementLease?: (lobbyId: string) => Promise<{
    lobbyId: string;
    roundId: string;
    triggeringCallId: string;
    deadline: Date;
  } | null>;
  readonly executeCoWinnerSettlement?: (lease: {
    lobbyId: string;
    roundId: string;
    triggeringCallId: string;
    deadline: Date;
  }) => Promise<"settled" | "stale" | "too-early">;
  readonly beforeListen?: (server: GameServer) => Promise<void>;
  readonly readinessCheck?: () => Promise<boolean>;
  readonly operationalLogger?: OperationalLogger;
  readonly limits?: {
    readonly connectionsPerMinute?: number;
    readonly commandsPerMinute?: number;
    readonly maximumConnections?: number;
    readonly connectionsPerSession?: number;
    readonly maximumQueuedAutomaticCalls?: number;
    readonly maximumQueuedCoWinnerSettlements?: number;
  };
}

const servers: GameServer[] = [];
const clients: Socket[] = [];
const managers: Manager[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const manager of managers.splice(0)) manager._close();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createHarness(options: HarnessOptions = {}) {
  const availableTickets = new Map(options.tickets ?? []);
  const consumedHashes: string[] = [];
  const executed: Array<{
    identity: AuthenticatedRealtimeIdentity;
    command: MutationCommand;
  }> = [];
  const serverOptions = {
    allowedOrigin: ORIGIN,
    clock: options.clock ?? (() => new Date(NOW)),
    readinessCheck: options.readinessCheck ?? (async () => true),
    ...(options.operationalLogger === undefined
      ? {}
      : { operationalLogger: options.operationalLogger }),
    ...(options.initialPresenceGracePeriods === undefined
      ? {}
      : { initialPresenceGracePeriods: options.initialPresenceGracePeriods }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ticketConsumer: {
      consumeRealtimeTicket: async ({ ticketHash: hash }) => {
        const key = Buffer.from(hash).toString("hex");
        consumedHashes.push(key);
        if (options.consumeTicket !== undefined) return options.consumeTicket(key);
        const identity = availableTickets.get(key) ?? null;
        availableTickets.delete(key);
        return identity;
      },
    },
    commandExecutor: {
      execute: async ({ identity, command }) => {
        executed.push({ identity, command });
        return (
          options.execute?.(identity, command) ??
          Promise.resolve({
            ok: true,
            acknowledgement: CommandAckSchema.parse({
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              type: "ack",
              commandId: command.commandId,
              occurredAt: NOW,
              idempotentReplay: true,
              scope: "active-lobby",
              eventSequence: 1,
            }),
            activeLobbyEvent: null,
            participantPrivateEvents: [],
          })
        );
      },
    },
    snapshotProvider: {
      findAuthorizedSnapshot: async (identity) =>
        options.snapshot?.(identity) ?? waitingSnapshotForIdentity(identity),
    },
    identityAuthorizer: {
      isIdentityActive: async (identity) => options.authorize?.(identity) ?? true,
    },
    presenceLifecycle: {
      registerConnection: async (identity) => options.registerPresence?.(identity) ?? 1,
      recordHeartbeat: async (identity) => options.recordHeartbeat?.(identity) ?? true,
      unregisterConnection: (identity, presenceGeneration) =>
        options.unregisterPresence?.(identity, presenceGeneration) ?? Promise.resolve(null),
      expireGracePeriod: async (grace) => options.expirePresenceGrace?.(grace) ?? "stale",
    },
    automaticCallLifecycle: {
      findAutomaticCallLeases: async () => options.findAutomaticCallLeases?.() ?? [],
      findAutomaticCallLease: async (lobbyId: string) =>
        options.findAutomaticCallLease?.(lobbyId) ?? null,
      executeAutomaticCall: (lease: { lobbyId: string; roundId: string; deadline: Date }) =>
        options.executeAutomaticCall?.(lease) ?? Promise.resolve("stale"),
    },
    coWinnerSettlementLifecycle: {
      findCoWinnerSettlementLeases: async () => options.findCoWinnerSettlementLeases?.() ?? [],
      findCoWinnerSettlementLease: async (lobbyId: string) =>
        options.findCoWinnerSettlementLease?.(lobbyId) ?? null,
      executeCoWinnerSettlement: (lease: {
        lobbyId: string;
        roundId: string;
        triggeringCallId: string;
        deadline: Date;
      }) => options.executeCoWinnerSettlement?.(lease) ?? Promise.resolve("stale"),
    },
  } as GameServerOptions;
  const server = createGameServer(serverOptions);
  servers.push(server);
  await options.beforeListen?.(server);
  const address = await server.listen({ host: "127.0.0.1", port: 0 });

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    consumedHashes,
    executed,
    open(
      credential: string,
      auth: Record<string, unknown> = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        ticket: credential,
      },
      origin = ORIGIN,
    ) {
      const client = createClient(`http://127.0.0.1:${address.port}`, {
        autoConnect: false,
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
        auth,
        reconnection: false,
      });
      clients.push(client);
      return client;
    },
    async connect(
      credential: string,
      auth: Record<string, unknown> = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        ticket: credential,
      },
      origin = ORIGIN,
    ) {
      const client = this.open(credential, auth, origin);
      const connected = once<void>(client, "connect");
      const initialized = once<unknown>(client, "v1:snapshot");
      const failed = once<Error>(client, "connect_error").then((error) => Promise.reject(error));
      client.connect();
      await Promise.race([connected, failed]);
      await initialized;
      return client;
    },
    async reject(
      credential: string,
      auth: Record<string, unknown> = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        ticket: credential,
      },
      origin = ORIGIN,
    ) {
      const client = this.open(credential, auth, origin);
      const errorPromise = once<Error & { data?: unknown }>(client, "connect_error");
      client.connect();
      return errorPromise;
    },
  };
}

describe("authenticated Socket.IO authority", () => {
  test("keeps repeated close calls joined to in-flight presence cleanup", async () => {
    const credential = ticket(99);
    const unregisterStarted = deferred();
    const releaseUnregister = deferred<null>();
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      unregisterPresence: async () => {
        unregisterStarted.resolve();
        return releaseUnregister.promise;
      },
    });
    await harness.connect(credential);

    const firstClose = harness.server.close();
    await waitForSignal(unregisterStarted.promise, "presence cleanup during shutdown");
    const secondClose = harness.server.close();

    expect(secondClose).toBe(firstClose);
    releaseUnregister.resolve(null);

    await waitForSignal(
      Promise.all([firstClose, secondClose]),
      "all callers to observe completed authority shutdown",
    );
  });

  test("recovers and settles an exact co-winner deadline after two seconds", async () => {
    const lease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-co-winner",
      triggeringCallId: "call-co-winner",
      deadline: new Date(Date.parse(NOW) + 2_000),
    };
    const attempts: unknown[] = [];
    let currentLease: typeof lease | null = lease;
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      await createHarness({
        clock: () => new Date(),
        findCoWinnerSettlementLeases: async () => [lease],
        findCoWinnerSettlementLease: async () => currentLease,
        executeCoWinnerSettlement: async (attempted) => {
          attempts.push(attempted);
          currentLease = null;
          return "settled";
        },
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(attempts).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toEqual([lease]);
    } finally {
      currentLease = null;
      vi.useRealTimers();
    }
  });

  test("reschedules a co-winner settlement when persistence says its deadline is still early", async () => {
    let now = new Date(NOW);
    const lease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-co-winner-early",
      triggeringCallId: "call-co-winner-early",
      deadline: new Date(Date.parse(NOW) + 2_000),
    };
    const attempts: unknown[] = [];
    let currentLease: typeof lease | null = lease;
    vi.useFakeTimers({ now });

    try {
      await createHarness({
        clock: () => now,
        findCoWinnerSettlementLeases: async () => [lease],
        findCoWinnerSettlementLease: async () => currentLease,
        executeCoWinnerSettlement: async (attempted) => {
          attempts.push(attempted);
          if (attempts.length === 1) return "too-early";
          currentLease = null;
          return "settled";
        },
      });
      now = new Date(Date.parse(NOW) + 1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(attempts).toEqual([lease]);

      now = lease.deadline;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toEqual([lease, lease]);
    } finally {
      currentLease = null;
      vi.useRealTimers();
    }
  });

  test("replaces a live co-winner settlement when its exact persisted lease changes", async () => {
    const oldLease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-co-winner-old",
      triggeringCallId: "call-co-winner-old",
      deadline: new Date(Date.parse(NOW) + 1_000),
    };
    const newLease = {
      ...oldLease,
      roundId: "round-co-winner-new",
      triggeringCallId: "call-co-winner-new",
      deadline: new Date(Date.parse(NOW) + 2_000),
    };
    const attempts: unknown[] = [];
    let currentLease: typeof oldLease | null = oldLease;
    vi.useFakeTimers({ now: new Date(NOW) });

    let publication: Promise<void> | undefined;
    try {
      const harness = await createHarness({
        clock: () => new Date(),
        findCoWinnerSettlementLeases: async () => [oldLease],
        findCoWinnerSettlementLease: async () => currentLease,
        executeCoWinnerSettlement: async (attempted) => {
          attempts.push(attempted);
          currentLease = null;
          return "settled";
        },
      });
      currentLease = newLease;
      publication = harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
      await vi.advanceTimersByTimeAsync(0);
      await waitForSignal(publication, "the replacement co-winner lease reconciliation");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toEqual([newLease]);
    } finally {
      currentLease = null;
      try {
        if (publication !== undefined) {
          await waitForSignal(Promise.allSettled([publication]), "replacement lease cleanup");
        }
      } finally {
        vi.useRealTimers();
      }
    }
  });

  test("does not bind after shutdown begins during co-winner settlement recovery", async () => {
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    const serverReady = deferred<GameServer>();
    let harnessPromise: ReturnType<typeof createHarness> | undefined;

    try {
      harnessPromise = createHarness({
        beforeListen: async (server) => serverReady.resolve(server),
        findCoWinnerSettlementLeases: async () => {
          recoveryStarted.resolve();
          await releaseRecovery.promise;
          return [];
        },
      });
      const server = await waitForSignal(serverReady.promise, "the recovering co-winner authority");
      await waitForSignal(recoveryStarted.promise, "the blocked co-winner settlement recovery");
      const closed = server.close();
      releaseRecovery.resolve();

      await waitForSignal(closed, "authority shutdown during co-winner recovery");
      await expect(
        waitForSignal(harnessPromise, "the cancelled co-winner recovery"),
      ).rejects.toThrow("closed");
    } finally {
      releaseRecovery.resolve();
      if (harnessPromise !== undefined) {
        await waitForSignal(
          Promise.allSettled([harnessPromise]),
          "co-winner shutdown recovery cleanup",
        );
      }
    }
  });

  test("runs at most one co-winner settlement per lobby without starving another lobby", async () => {
    const targetLobbyId = identities.host.lobbyId;
    const otherLobbyId = identities.otherLobby.lobbyId;
    const firstTargetLease = {
      lobbyId: targetLobbyId,
      roundId: "round-co-winner-target-first",
      triggeringCallId: "call-co-winner-target-first",
      deadline: new Date(NOW),
    };
    const replacementTargetLease = {
      ...firstTargetLease,
      roundId: "round-co-winner-target-replacement",
      triggeringCallId: "call-co-winner-target-replacement",
    };
    const otherLease = {
      lobbyId: otherLobbyId,
      roundId: "round-co-winner-other",
      triggeringCallId: "call-co-winner-other",
      deadline: new Date(NOW),
    };
    const releaseFirstTarget = deferred();
    const firstTargetStarted = deferred();
    const otherStarted = deferred();
    const replacementTargetStarted = deferred();
    const attempts: CoWinnerSettlementLease[] = [];
    const currentLeases = new Map<string, CoWinnerSettlementLease | null>([
      [targetLobbyId, firstTargetLease],
      [otherLobbyId, null],
    ]);
    let firstPublication: Promise<void> | undefined;
    let secondPublication: Promise<void> | undefined;

    try {
      const harness = await createHarness({
        clock: () => new Date(NOW),
        findCoWinnerSettlementLeases: async () => [firstTargetLease],
        findCoWinnerSettlementLease: async (lobbyId) => currentLeases.get(lobbyId) ?? null,
        executeCoWinnerSettlement: async (lease) => {
          attempts.push(lease);
          if (lease === firstTargetLease) {
            firstTargetStarted.resolve();
            await releaseFirstTarget.promise;
          }
          if (lease === otherLease) otherStarted.resolve();
          if (lease === replacementTargetLease) replacementTargetStarted.resolve();
          return "stale";
        },
      });
      await waitForSignal(firstTargetStarted.promise, "the first co-winner settlement");

      currentLeases.set(targetLobbyId, replacementTargetLease);
      firstPublication = harness.server.publishLobbyEvent(targetLobbyId, stageEvent);
      await waitForSignal(firstPublication, "the replacement co-winner reconciliation");
      currentLeases.set(otherLobbyId, otherLease);
      secondPublication = harness.server.publishLobbyEvent(otherLobbyId, stageEvent);
      await waitForSignal(secondPublication, "the unrelated co-winner reconciliation");
      await waitForSignal(otherStarted.promise, "the unrelated co-winner settlement");
      expect(attempts).toEqual([firstTargetLease, otherLease]);

      releaseFirstTarget.resolve();
      await waitForSignal(replacementTargetStarted.promise, "the replacement co-winner settlement");
      expect(attempts).toEqual([firstTargetLease, otherLease, replacementTargetLease]);
    } finally {
      currentLeases.set(targetLobbyId, null);
      currentLeases.set(otherLobbyId, null);
      releaseFirstTarget.resolve();
      const pending: Promise<unknown>[] = [];
      if (firstPublication !== undefined) pending.push(firstPublication);
      if (secondPublication !== undefined) pending.push(secondPublication);
      await waitForSignal(Promise.allSettled(pending), "co-winner fairness cleanup");
    }
  });

  test("fails the authority when a co-winner settlement cannot be persisted", async () => {
    const lease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-co-winner-failure",
      triggeringCallId: "call-co-winner-failure",
      deadline: new Date(NOW),
    };
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      const harness = await createHarness({
        clock: () => new Date(),
        findCoWinnerSettlementLeases: async () => [lease],
        executeCoWinnerSettlement: async () => {
          throw new Error("private co-winner persistence detail");
        },
      });
      const authorityFailure = harness.server.failure.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        waitForSignal(authorityFailure, "the terminal co-winner settlement failure"),
      ).resolves.toMatchObject({ message: "Game server authority failed." });
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails the authority when a co-winner lease cannot be reconciled", async () => {
    const harness = await createHarness({
      findCoWinnerSettlementLeases: async () => [],
      findCoWinnerSettlementLease: async () => {
        throw new Error("private co-winner lease read detail");
      },
    });
    const authorityFailure = harness.server.failure.catch((error: unknown) => error);

    await expect(
      harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent),
    ).rejects.toThrow();
    await expect(
      waitForSignal(authorityFailure, "the terminal co-winner reconciliation failure"),
    ).resolves.toMatchObject({ message: "Game server authority failed." });
  });

  test("fails closed when the bounded co-winner settlement queue overflows", async () => {
    const leases = Array.from({ length: 10 }, (_, index) => ({
      lobbyId: `lobby-co-winner-overflow-${index}`,
      roundId: `round-co-winner-overflow-${index}`,
      triggeringCallId: `call-co-winner-overflow-${index}`,
      deadline: new Date(NOW),
    }));
    const releaseSettlements = deferred();
    const started: CoWinnerSettlementLease[] = [];
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      const harness = await createHarness({
        clock: () => new Date(),
        limits: { maximumQueuedCoWinnerSettlements: 1 },
        findCoWinnerSettlementLeases: async () => leases,
        executeCoWinnerSettlement: async (lease) => {
          started.push(lease);
          await releaseSettlements.promise;
          return "stale";
        },
      });
      const authorityFailure = harness.server.failure.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);

      await expect(
        waitForSignal(authorityFailure, "the co-winner queue overflow failure"),
      ).resolves.toMatchObject({ message: "Game server authority failed." });
      expect(started).toHaveLength(8);
    } finally {
      releaseSettlements.resolve();
      try {
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  test("publishes a scheduled co-winner settlement to every connected lobby client", async () => {
    const hostCredential = ticket(76);
    const playerCredential = ticket(77);
    const deadline = new Date();
    const lease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-scheduled-co-winner",
      triggeringCallId: "call-scheduled-co-winner",
      deadline,
    };
    const resultEvent = ActiveLobbyEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "co-winner-result",
      eventSequence: 1,
      occurredAt: deadline.toISOString(),
      result: {
        triggeringCallId: lease.triggeringCallId,
        openedAt: new Date(deadline.getTime() - 2_000).toISOString(),
        closesAt: deadline.toISOString(),
        settledAt: deadline.toISOString(),
        winnerParticipantIds: [identities.player.participantId],
      },
    });
    let server: GameServer | undefined;
    let currentLease: typeof lease | null = lease;
    const settlementStarted = deferred();
    const releaseSettlement = deferred();
    const harness = await createHarness({
      clock: () => new Date(),
      tickets: new Map<string, AuthenticatedRealtimeIdentity>([
        [ticketHash(hostCredential), identities.host],
        [ticketHash(playerCredential), identities.player],
      ]),
      beforeListen: async (createdServer) => {
        server = createdServer;
      },
      findCoWinnerSettlementLeases: async () => [lease],
      findCoWinnerSettlementLease: async () => currentLease,
      executeCoWinnerSettlement: async () => {
        settlementStarted.resolve();
        await releaseSettlement.promise;
        currentLease = null;
        if (server === undefined) throw new Error("The test authority was not captured.");
        await server.publishLobbyEvent(lease.lobbyId, resultEvent);
        return "settled";
      },
    });
    const [host, player] = await Promise.all([
      harness.connect(hostCredential),
      harness.connect(playerCredential),
    ]);
    const hostResult = once<unknown>(host, "v1:lobby-event");
    const playerResult = once<unknown>(player, "v1:lobby-event");
    await waitForSignal(settlementStarted.promise, "the scheduled co-winner settlement");
    releaseSettlement.resolve();

    await expect(hostResult).resolves.toEqual(resultEvent);
    await expect(playerResult).resolves.toEqual(resultEvent);
  });

  test("recovers automatic calling and schedules each persisted deadline once", async () => {
    const first = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-automatic",
      deadline: new Date(Date.parse(NOW) + 30_000),
    };
    const second = { ...first, deadline: new Date(Date.parse(NOW) + 60_000) };
    const attempts: unknown[] = [];
    let currentLease: typeof first | null = first;
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      await createHarness({
        clock: () => new Date(),
        findAutomaticCallLeases: async () => [first],
        findAutomaticCallLease: async () => currentLease,
        executeAutomaticCall: async (lease) => {
          attempts.push(lease);
          currentLease = attempts.length === 1 ? second : null;
          return "called";
        },
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(attempts).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toEqual([first]);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toEqual([first, second]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reconciles a committed event delivered during startup recovery", async () => {
    const oldLease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-recovery-old",
      deadline: new Date(Date.parse(NOW) + 5_000),
    };
    const newLease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-recovery-new",
      deadline: new Date(Date.parse(NOW) + 10_000),
    };
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    const serverReady = deferred<GameServer>();
    const attempts: unknown[] = [];
    let currentLease: typeof oldLease | null = oldLease;
    vi.useFakeTimers({ now: new Date(NOW) });

    let harnessPromise: ReturnType<typeof createHarness> | undefined;
    let publication: Promise<void> | undefined;
    try {
      harnessPromise = createHarness({
        clock: () => new Date(),
        beforeListen: async (server) => serverReady.resolve(server),
        findAutomaticCallLeases: async () => {
          recoveryStarted.resolve();
          await releaseRecovery.promise;
          return [oldLease];
        },
        findAutomaticCallLease: async () => currentLease,
        executeAutomaticCall: async (lease) => {
          attempts.push(lease);
          currentLease = null;
          return "exhausted";
        },
      });
      await waitForSignal(recoveryStarted.promise, "automatic call recovery to start");
      currentLease = newLease;
      publication = (
        await waitForSignal(serverReady.promise, "the recovering game server")
      ).publishLobbyEvent(identities.host.lobbyId, stageEvent);
      await vi.advanceTimersByTimeAsync(0);
      await waitForSignal(publication, "the recovery-time event publication");
      releaseRecovery.resolve();
      await waitForSignal(harnessPromise, "automatic call recovery to finish");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(attempts).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(attempts).toEqual([newLease]);
    } finally {
      releaseRecovery.resolve();
      try {
        const pending: Promise<unknown>[] = [];
        if (publication !== undefined) pending.push(publication);
        if (harnessPromise !== undefined) pending.push(harnessPromise);
        await waitForSignal(Promise.allSettled(pending), "recovery test cleanup");
      } finally {
        vi.useRealTimers();
      }
    }
  });

  test("does not bind after shutdown begins during automatic call recovery", async () => {
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    const serverReady = deferred<GameServer>();
    let harnessPromise: ReturnType<typeof createHarness> | undefined;

    try {
      harnessPromise = createHarness({
        beforeListen: async (server) => serverReady.resolve(server),
        findAutomaticCallLeases: async () => {
          recoveryStarted.resolve();
          await releaseRecovery.promise;
          return [];
        },
      });
      const server = await waitForSignal(serverReady.promise, "the recovering authority");
      await waitForSignal(recoveryStarted.promise, "the blocked automatic call recovery");
      const closed = server.close();
      releaseRecovery.resolve();

      await waitForSignal(closed, "authority shutdown during recovery");
      await expect(
        waitForSignal(harnessPromise, "the cancelled automatic call recovery"),
      ).rejects.toThrow("closed");
    } finally {
      releaseRecovery.resolve();
      if (harnessPromise !== undefined) {
        await waitForSignal(Promise.allSettled([harnessPromise]), "shutdown recovery test cleanup");
      }
    }
  });

  test("never schedules automatic calls when recovery finds only manual rounds", async () => {
    const attempts: unknown[] = [];
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      await createHarness({
        findAutomaticCallLeases: async () => [],
        executeAutomaticCall: async (lease) => {
          attempts.push(lease);
          return "called";
        },
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(attempts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reschedules an automatic call when persistence says its deadline is still early", async () => {
    let now = new Date(NOW);
    const lease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-automatic",
      deadline: new Date(Date.parse(NOW) + 30_000),
    };
    const attempts: unknown[] = [];
    let currentLease: typeof lease | null = lease;
    vi.useFakeTimers({ now });

    try {
      await createHarness({
        clock: () => now,
        findAutomaticCallLeases: async () => [lease],
        findAutomaticCallLease: async () => currentLease,
        executeAutomaticCall: async (attempted) => {
          attempts.push(attempted);
          if (attempts.length === 1) return "too-early";
          currentLease = null;
          return "called";
        },
      });
      now = new Date(Date.parse(NOW) + 20_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toEqual([lease]);

      now = lease.deadline;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(attempts).toEqual([lease, lease]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not let a delayed early result replace a newer persisted lease", async () => {
    const oldLease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-automatic",
      deadline: new Date(NOW),
    };
    const newLease = { ...oldLease, deadline: new Date(Date.parse(NOW) + 5_000) };
    const firstResult = deferred<"too-early">();
    const attempts: unknown[] = [];
    let currentLease: typeof oldLease | null = oldLease;
    vi.useFakeTimers({ now: new Date(NOW) });

    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    let publication: Promise<void> | undefined;
    try {
      harness = await createHarness({
        clock: () => new Date(),
        findAutomaticCallLeases: async () => [oldLease],
        findAutomaticCallLease: async () => currentLease,
        executeAutomaticCall: async (lease) => {
          attempts.push(lease);
          if (lease.deadline.getTime() === oldLease.deadline.getTime()) {
            return firstResult.promise;
          }
          currentLease = null;
          return "called";
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual([oldLease]);

      currentLease = newLease;
      publication = harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
      await vi.advanceTimersByTimeAsync(0);
      await waitForSignal(publication, "the newer persisted lease publication");
      firstResult.resolve("too-early");
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual([oldLease]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(attempts).toEqual([oldLease, newLease]);
    } finally {
      currentLease = null;
      firstResult.resolve("too-early");
      try {
        if (publication !== undefined) {
          await waitForSignal(Promise.allSettled([publication]), "delayed result test cleanup");
        }
        if (harness !== undefined) {
          await waitForSignal(harness.server.close(), "delayed result server cleanup");
        }
      } finally {
        vi.useRealTimers();
      }
    }
  });

  test.each(["replace", "clear"] as const)(
    "keeps a newer lease %s when an older reconciliation finishes last",
    async (newerAction) => {
      const lobbyId = identities.host.lobbyId;
      const oldLease = {
        lobbyId,
        roundId: "round-automatic-old",
        deadline: new Date(NOW),
      };
      const newLease = {
        lobbyId,
        roundId: "round-automatic-new",
        deadline: new Date(NOW),
      };
      const firstRead = deferred<typeof oldLease | null>();
      const secondRead = deferred<typeof oldLease | null>();
      const firstReadStarted = deferred();
      const secondReadStarted = deferred();
      const attempts: unknown[] = [];
      let reads = 0;
      vi.useFakeTimers({ now: new Date(NOW) });

      let firstPublication: Promise<void> | undefined;
      let secondPublication: Promise<void> | undefined;
      try {
        const harness = await createHarness({
          clock: () => new Date(),
          findAutomaticCallLeases: async () => [],
          findAutomaticCallLease: async () => {
            reads += 1;
            if (reads === 1) {
              firstReadStarted.resolve();
              return firstRead.promise;
            }
            secondReadStarted.resolve();
            return secondRead.promise;
          },
          executeAutomaticCall: async (lease) => {
            attempts.push(lease);
            return "exhausted";
          },
        });
        firstPublication = harness.server.publishLobbyEvent(lobbyId, stageEvent);
        await vi.advanceTimersByTimeAsync(0);
        await waitForSignal(firstReadStarted.promise, "the first automatic lease read");
        secondPublication = harness.server.publishLobbyEvent(
          lobbyId,
          ActiveLobbyEventSchema.parse({ ...stageEvent, eventSequence: 2 }),
        );
        await vi.advanceTimersByTimeAsync(0);
        await waitForSignal(secondReadStarted.promise, "the second automatic lease read");

        secondRead.resolve(newerAction === "replace" ? newLease : null);
        await waitForSignal(secondPublication, "the newer automatic lease reconciliation");
        firstRead.resolve(oldLease);
        await waitForSignal(firstPublication, "the stale automatic lease reconciliation");

        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toEqual(newerAction === "replace" ? [newLease] : []);
      } finally {
        firstRead.resolve(null);
        secondRead.resolve(null);
        try {
          const pending: Promise<unknown>[] = [];
          if (firstPublication !== undefined) pending.push(firstPublication);
          if (secondPublication !== undefined) pending.push(secondPublication);
          await waitForSignal(Promise.allSettled(pending), "lease reconciliation test cleanup");
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  test("runs at most one automatic call per lobby without starving another lobby", async () => {
    const targetLobbyId = identities.host.lobbyId;
    const otherLobbyId = identities.otherLobby.lobbyId;
    const firstTargetLease = {
      lobbyId: targetLobbyId,
      roundId: "round-target-first",
      deadline: new Date(NOW),
    };
    const replacementTargetLease = {
      lobbyId: targetLobbyId,
      roundId: "round-target-replacement",
      deadline: new Date(NOW),
    };
    const otherLease = {
      lobbyId: otherLobbyId,
      roundId: "round-other",
      deadline: new Date(NOW),
    };
    const releaseFirstTarget = deferred();
    const firstTargetStarted = deferred();
    const otherStarted = deferred();
    const replacementTargetStarted = deferred();
    const attempts: Array<{ lobbyId: string; roundId: string; deadline: Date }> = [];
    const currentLeases = new Map<
      string,
      { lobbyId: string; roundId: string; deadline: Date } | null
    >([
      [targetLobbyId, firstTargetLease],
      [otherLobbyId, null],
    ]);
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    let firstPublication: Promise<void> | undefined;
    let secondPublication: Promise<void> | undefined;
    try {
      harness = await createHarness({
        clock: () => new Date(NOW),
        findAutomaticCallLeases: async () => [firstTargetLease],
        findAutomaticCallLease: async (lobbyId) => currentLeases.get(lobbyId) ?? null,
        executeAutomaticCall: async (lease) => {
          attempts.push(lease);
          if (lease === firstTargetLease) {
            firstTargetStarted.resolve();
            await releaseFirstTarget.promise;
          }
          if (lease === otherLease) otherStarted.resolve();
          if (lease === replacementTargetLease) replacementTargetStarted.resolve();
          return "exhausted";
        },
      });
      await waitForSignal(firstTargetStarted.promise, "the first target automatic call");

      currentLeases.set(targetLobbyId, replacementTargetLease);
      firstPublication = harness.server.publishLobbyEvent(targetLobbyId, stageEvent);
      await waitForSignal(firstPublication, "the target replacement publication");
      currentLeases.set(otherLobbyId, otherLease);
      secondPublication = harness.server.publishLobbyEvent(otherLobbyId, stageEvent);
      await waitForSignal(secondPublication, "the unrelated lobby publication");
      await waitForSignal(otherStarted.promise, "the other lobby automatic call");

      expect(attempts).toEqual([firstTargetLease, otherLease]);
      releaseFirstTarget.resolve();
      await waitForSignal(replacementTargetStarted.promise, "the replacement automatic call");
      expect(attempts).toEqual([firstTargetLease, otherLease, replacementTargetLease]);
    } finally {
      releaseFirstTarget.resolve();
      const pending: Promise<unknown>[] = [];
      if (firstPublication !== undefined) pending.push(firstPublication);
      if (secondPublication !== undefined) pending.push(secondPublication);
      await waitForSignal(Promise.allSettled(pending), "per-lobby fairness test cleanup");
      if (harness !== undefined) {
        await waitForSignal(harness.server.close(), "per-lobby fairness server cleanup");
      }
    }
  });

  test("latches an automatic execution rejection before concurrent success reconciliation", async () => {
    const failedLease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-failed",
      deadline: new Date(NOW),
    };
    const successfulLease = {
      lobbyId: identities.otherLobby.lobbyId,
      roundId: "round-successful",
      deadline: new Date(NOW),
    };
    const failedResult = deferred<"called">();
    const successfulResult = deferred<"called">();
    const failedStarted = deferred();
    const successfulStarted = deferred();
    const leaseReads: string[] = [];

    try {
      const harness = await createHarness({
        clock: () => new Date(NOW),
        findAutomaticCallLeases: async () => [failedLease, successfulLease],
        findAutomaticCallLease: async (lobbyId) => {
          leaseReads.push(lobbyId);
          return null;
        },
        executeAutomaticCall: async (lease) => {
          if (lease === failedLease) {
            failedStarted.resolve();
            return failedResult.promise;
          }
          successfulStarted.resolve();
          return successfulResult.promise;
        },
      });
      const authorityFailure = harness.server.failure.catch((error: unknown) => error);
      await Promise.all([
        waitForSignal(failedStarted.promise, "the failing automatic call"),
        waitForSignal(successfulStarted.promise, "the successful automatic call"),
      ]);

      failedResult.reject(new Error("private automatic call persistence detail"));
      successfulResult.resolve("called");

      await expect(
        waitForSignal(authorityFailure, "the terminal automatic call failure"),
      ).resolves.toMatchObject({ message: "Game server authority failed." });
      await waitForSignal(
        new Promise<void>((resolve) => setImmediate(resolve)),
        "promise reactions",
      );
      expect(leaseReads).toEqual([]);
    } finally {
      failedResult.resolve("called");
      successfulResult.resolve("called");
    }
  });

  test("retains a same-key lease reconciled while active after execution returns blocked", async () => {
    const lease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-presence-blocked",
      deadline: new Date(NOW),
    };
    const firstResult = deferred<"blocked">();
    const firstStarted = deferred();
    const leaseRead = deferred();
    const secondStarted = deferred();
    const attempts: Array<{ lobbyId: string; roundId: string; deadline: Date }> = [];
    let currentLease: typeof lease | null = lease;
    let publication: Promise<void> | undefined;

    try {
      const harness = await createHarness({
        clock: () => new Date(NOW),
        findAutomaticCallLeases: async () => [lease],
        findAutomaticCallLease: async () => {
          leaseRead.resolve();
          return currentLease;
        },
        executeAutomaticCall: async (attempted) => {
          attempts.push(attempted);
          if (attempts.length === 1) {
            firstStarted.resolve();
            return firstResult.promise;
          }
          currentLease = null;
          secondStarted.resolve();
          return "exhausted";
        },
      });
      await waitForSignal(firstStarted.promise, "the blocked automatic call");

      publication = harness.server.publishLobbyEvent(lease.lobbyId, stageEvent);
      await waitForSignal(leaseRead.promise, "the same-key automatic lease read");
      await waitForSignal(publication, "the same-key automatic lease reconciliation");
      firstResult.resolve("blocked");

      await waitForSignal(secondStarted.promise, "the retained automatic call");
      expect(attempts).toEqual([lease, lease]);
    } finally {
      currentLease = null;
      firstResult.resolve("blocked");
      if (publication !== undefined) {
        await waitForSignal(Promise.allSettled([publication]), "same-key test cleanup");
      }
    }
  });

  test.each([5, 10, 30, 60, 120] as const)(
    "installs a live %i-second automatic lease from a committed lobby event",
    async (intervalSeconds) => {
      const lease = {
        lobbyId: identities.host.lobbyId,
        roundId: `round-live-${intervalSeconds}`,
        deadline: new Date(Date.parse(NOW) + intervalSeconds * 1_000),
      };
      const attempts: unknown[] = [];
      let currentLease: typeof lease | null = null;
      vi.useFakeTimers({ now: new Date(NOW) });

      let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
      let publication: Promise<void> | undefined;
      try {
        harness = await createHarness({
          clock: () => new Date(),
          findAutomaticCallLeases: async () => [],
          findAutomaticCallLease: async () => currentLease,
          executeAutomaticCall: async (attempted) => {
            attempts.push(attempted);
            currentLease = null;
            return "called";
          },
        });
        currentLease = lease;
        publication = harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
        await vi.advanceTimersByTimeAsync(0);
        await waitForSignal(publication, `the ${intervalSeconds}-second lease publication`);

        await vi.advanceTimersByTimeAsync(intervalSeconds * 1_000 - 1);
        expect(attempts).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toEqual([lease]);
      } finally {
        currentLease = null;
        try {
          if (publication !== undefined) {
            await waitForSignal(Promise.allSettled([publication]), "interval test cleanup");
          }
          if (harness !== undefined) {
            await waitForSignal(harness.server.close(), "interval test server cleanup");
          }
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  test("cancels a live automatic lease after an externally committed pause event", async () => {
    const lease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-live-cancelled",
      deadline: new Date(Date.parse(NOW) + 30_000),
    };
    const attempts: unknown[] = [];
    let currentLease: typeof lease | null = null;
    vi.useFakeTimers({ now: new Date(NOW) });

    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    const publications: Promise<void>[] = [];
    try {
      harness = await createHarness({
        clock: () => new Date(),
        findAutomaticCallLeases: async () => [],
        findAutomaticCallLease: async () => currentLease,
        executeAutomaticCall: async (attempted) => {
          attempts.push(attempted);
          return "called";
        },
      });
      currentLease = lease;
      let publication = harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
      publications.push(publication);
      await vi.advanceTimersByTimeAsync(0);
      await waitForSignal(publication, "the live automatic lease publication");

      currentLease = null;
      publication = harness.server.publishLobbyEventFromSource(
        identities.host.lobbyId,
        2,
        async () => ActiveLobbyEventSchema.parse({ ...stageEvent, eventSequence: 2 }),
      );
      publications.push(publication);
      await vi.advanceTimersByTimeAsync(0);
      await waitForSignal(publication, "the automatic lease cancellation publication");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toEqual([]);
    } finally {
      currentLease = null;
      try {
        await waitForSignal(Promise.allSettled(publications), "lease cancellation test cleanup");
        if (harness !== undefined) {
          await waitForSignal(harness.server.close(), "lease cancellation server cleanup");
        }
      } finally {
        vi.useRealTimers();
      }
    }
  });

  test("keeps only the latest queued automatic lease for a busy lobby", async () => {
    const release = deferred();
    const blockerLeases = Array.from({ length: 8 }, (_, index) => ({
      lobbyId: `blocking-lobby-${index}`,
      roundId: `blocking-round-${index}`,
      deadline: new Date(NOW),
    }));
    const attempts: Array<{ lobbyId: string; roundId: string; deadline: Date }> = [];
    const targetLobbyId = "queued-lobby";
    let currentTargetLease: (typeof blockerLeases)[number] | null = null;
    let latestTargetLease: (typeof blockerLeases)[number] | null = null;
    vi.useFakeTimers({ now: new Date(NOW) });

    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    const publications: Promise<void>[] = [];
    try {
      harness = await createHarness({
        clock: () => new Date(),
        findAutomaticCallLeases: async () => blockerLeases,
        findAutomaticCallLease: async (lobbyId) =>
          lobbyId === targetLobbyId ? currentTargetLease : null,
        executeAutomaticCall: async (lease) => {
          attempts.push(lease);
          if (lease.lobbyId !== targetLobbyId) await release.promise;
          else currentTargetLease = null;
          return "called";
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(8);

      for (let index = 1; index <= 20; index += 1) {
        currentTargetLease = latestTargetLease = {
          lobbyId: targetLobbyId,
          roundId: "queued-round",
          deadline: new Date(Date.parse(NOW) - index),
        };
        const publication = harness.server.publishLobbyEvent(
          targetLobbyId,
          ActiveLobbyEventSchema.parse({ ...stageEvent, eventSequence: index }),
        );
        publications.push(publication);
        await vi.advanceTimersByTimeAsync(0);
        await waitForSignal(publication, `queued lease publication ${index}`);
        await vi.advanceTimersByTimeAsync(0);
      }

      release.resolve();
      await vi.runAllTimersAsync();
      const targetAttempts = attempts.filter(({ lobbyId }) => lobbyId === targetLobbyId);
      expect(targetAttempts).toEqual([latestTargetLease]);
    } finally {
      currentTargetLease = null;
      release.resolve();
      try {
        await waitForSignal(Promise.allSettled(publications), "queued lease test cleanup");
        if (harness !== undefined) {
          await waitForSignal(harness.server.close(), "queued lease server cleanup");
        }
      } finally {
        vi.useRealTimers();
      }
    }
  });

  test("fails closed when the bounded automatic call queue overflows", async () => {
    const release = deferred();
    const leases = Array.from({ length: 10 }, (_, index) => ({
      lobbyId: `overflow-blocking-lobby-${index}`,
      roundId: `overflow-blocking-round-${index}`,
      deadline: new Date(NOW),
    }));
    const reconciledLobbies = new Set<string>();
    const attempts: typeof leases = [];
    let failureObserved = false;
    vi.useFakeTimers({ now: new Date(NOW) });

    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      harness = await createHarness({
        clock: () => new Date(),
        limits: { maximumQueuedAutomaticCalls: 1 },
        findAutomaticCallLeases: async () => leases,
        findAutomaticCallLease: async (lobbyId) => {
          if (reconciledLobbies.has(lobbyId)) return null;
          reconciledLobbies.add(lobbyId);
          return {
            lobbyId,
            roundId: `replacement-${lobbyId}`,
            deadline: new Date(NOW),
          };
        },
        executeAutomaticCall: async (lease) => {
          attempts.push(lease);
          await release.promise;
          return "called";
        },
      });
      void harness.server.failure.catch(() => {
        failureObserved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(failureObserved).toBe(true);
      expect(attempts).toHaveLength(8);
      release.resolve();
      await vi.runAllTimersAsync();
      expect(attempts).toHaveLength(8);
    } finally {
      release.resolve();
      try {
        if (harness !== undefined) {
          await waitForSignal(harness.server.close(), "overflow server cleanup");
        }
      } finally {
        vi.useRealTimers();
      }
    }
  });

  test("bounds concurrent automatic calls recovered after restart", async () => {
    const release = deferred();
    const leases = Array.from({ length: 9 }, (_, index) => ({
      lobbyId: `${identities.host.lobbyId}-${index}`,
      roundId: `round-automatic-${index}`,
      deadline: new Date(NOW),
    }));
    const attempts: unknown[] = [];
    let active = 0;
    let maximumActive = 0;
    vi.useFakeTimers({ now: new Date(NOW) });

    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      harness = await createHarness({
        clock: () => new Date(),
        findAutomaticCallLeases: async () => leases,
        findAutomaticCallLease: async () => null,
        executeAutomaticCall: async (lease) => {
          attempts.push(lease);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await release.promise;
          active -= 1;
          return "called";
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(maximumActive).toBe(8);

      release.resolve();
      await vi.runAllTimersAsync();
      expect(attempts).toEqual(leases);
    } finally {
      release.resolve();
      try {
        if (harness !== undefined) {
          await waitForSignal(harness.server.close(), "concurrency server cleanup");
        }
      } finally {
        vi.useRealTimers();
      }
    }
  });

  test("fails the authority when an automatic call cannot be persisted", async () => {
    const lease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-automatic",
      deadline: new Date(NOW),
    };
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      const harness = await createHarness({
        clock: () => new Date(),
        findAutomaticCallLeases: async () => [lease],
        executeAutomaticCall: async () => {
          throw new Error("private automatic call persistence detail");
        },
      });
      const authorityFailure = harness.server.failure.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(0);
      await expect(authorityFailure).resolves.toMatchObject({
        message: "Game server authority failed.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails the authority when live automatic lease reconciliation cannot read persistence", async () => {
    const harness = await createHarness({
      findAutomaticCallLeases: async () => [],
      findAutomaticCallLease: async () => {
        throw new Error("private automatic lease read detail");
      },
    });
    const authorityFailure = harness.server.failure.catch((error: unknown) => error);

    await expect(
      harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent),
    ).rejects.toThrow("private automatic lease read detail");
    await expect(
      Promise.race([
        authorityFailure,
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]),
    ).resolves.toMatchObject({ message: "Game server authority failed." });
  });

  test("restores a persisted disconnect grace lease after authority restart", async () => {
    const expired: unknown[] = [];
    const grace = {
      lobbyId: identities.player.lobbyId,
      participantId: identities.player.participantId,
      presenceGeneration: 4,
      graceEndsAt: new Date(Date.parse(NOW) + 10_000),
    };
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      await createHarness({
        initialPresenceGracePeriods: [grace],
        expirePresenceGrace: async (lease) => {
          expired.push(lease);
          return "expired";
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(expired).toEqual([grace]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("expires a persisted disconnect grace lease only at its configured deadline", async () => {
    const credential = ticket(59);
    const releasePersisted = deferred();
    const expired: unknown[] = [];
    const graceEndsAt = new Date(Date.parse(NOW) + 10_000);
    const grace = {
      lobbyId: identities.host.lobbyId,
      participantId: identities.host.participantId,
      presenceGeneration: 7,
      graceEndsAt,
    };
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      unregisterPresence: async () => {
        releasePersisted.resolve();
        return grace;
      },
      expirePresenceGrace: async (lease) => {
        expired.push(lease);
        return "expired";
      },
    });
    const client = await harness.connect(credential);
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      client.disconnect();
      await releasePersisted.promise;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(expired).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(expired).toEqual([grace]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reschedules a grace lease when wall-clock rollback makes the first expiry early", async () => {
    let now = new Date(NOW);
    const attempts: unknown[] = [];
    const grace = {
      lobbyId: identities.player.lobbyId,
      participantId: identities.player.participantId,
      presenceGeneration: 9,
      graceEndsAt: new Date(Date.parse(NOW) + 10_000),
    };
    vi.useFakeTimers({ now });

    try {
      await createHarness({
        clock: () => now,
        initialPresenceGracePeriods: [grace],
        expirePresenceGrace: async (lease) => {
          attempts.push(lease);
          return attempts.length > 1 ? "expired" : "too-early";
        },
      });
      now = new Date(Date.parse(NOW) + 5_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(attempts).toEqual([grace]);

      now = grace.graceEndsAt;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(attempts).toEqual([grace, grace]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reschedules an authoritative early expiry that completes after the deadline", async () => {
    let now = new Date(NOW);
    const firstResult = deferred<"expired" | "stale" | "too-early">();
    const attempts: unknown[] = [];
    const grace = {
      lobbyId: identities.player.lobbyId,
      participantId: identities.player.participantId,
      presenceGeneration: 10,
      graceEndsAt: new Date(Date.parse(NOW) + 10_000),
    };
    vi.useFakeTimers({ now });

    try {
      await createHarness({
        clock: () => now,
        initialPresenceGracePeriods: [grace],
        expirePresenceGrace: async (lease) => {
          attempts.push(lease);
          return attempts.length === 1 ? firstResult.promise : "expired";
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(attempts).toEqual([grace]);

      now = new Date(grace.graceEndsAt.getTime() + 1);
      firstResult.resolve("too-early");
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual([grace, grace]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds concurrent expiry of restart-restored grace leases", async () => {
    const release = deferred();
    const gracePeriods = Array.from({ length: 9 }, (_, index) => ({
      lobbyId: identities.player.lobbyId,
      participantId: `${identities.player.participantId}-${index}`,
      presenceGeneration: 1,
      graceEndsAt: new Date(NOW),
    }));
    const attempted: unknown[] = [];
    let active = 0;
    let maximumActive = 0;
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      await createHarness({
        initialPresenceGracePeriods: gracePeriods,
        expirePresenceGrace: async (grace) => {
          attempted.push(grace);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await release.promise;
          active -= 1;
          return "expired";
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(maximumActive).toBe(8);

      release.resolve();
      await vi.runAllTimersAsync();
      expect(attempted).toEqual(gracePeriods);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });

  test("does not start queued grace expiry after persistence fails", async () => {
    const disconnectRecords: Parameters<OperationalLogger["disconnectPause"]>[0][] = [];
    const logger: OperationalLogger = {
      withCommandCorrelation: (_commandId, operation) => operation(),
      command: () => {},
      lobbyEvent: () => {},
      transactionRetry: () => {},
      disconnectPause: (record) => disconnectRecords.push(record),
      restartRestoration: () => {},
    };
    const releaseOthers = deferred();
    let rejectFirst!: (error: Error) => void;
    const firstAttempt = new Promise<"expired" | "stale" | "too-early">((_resolve, reject) => {
      rejectFirst = reject;
    });
    const gracePeriods = Array.from({ length: 9 }, (_, index) => ({
      lobbyId: identities.player.lobbyId,
      participantId: `${identities.player.participantId}-failure-${index}`,
      presenceGeneration: 1,
      graceEndsAt: new Date(NOW),
    }));
    let attempts = 0;
    vi.useFakeTimers({ now: new Date(NOW) });

    try {
      const harness = await createHarness({
        initialPresenceGracePeriods: gracePeriods,
        operationalLogger: logger,
        expirePresenceGrace: async () => {
          attempts += 1;
          if (attempts === 1) return firstAttempt;
          await releaseOthers.promise;
          return "stale";
        },
      });
      const authorityFailure = harness.server.failure.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(8);

      rejectFirst(new Error("private grace persistence detail"));
      await expect(authorityFailure).resolves.toMatchObject({
        message: "Game server authority failed.",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(8);
      expect(disconnectRecords).toContainEqual({
        lobbyId: gracePeriods[0]!.lobbyId,
        participantId: gracePeriods[0]!.participantId,
        presenceGeneration: gracePeriods[0]!.presenceGeneration,
        outcome: "failed",
      });
    } finally {
      releaseOthers.resolve();
      vi.useRealTimers();
    }
  });

  test("latches a grace persistence rejection before automatic success reconciliation", async () => {
    const grace = {
      lobbyId: identities.player.lobbyId,
      participantId: identities.player.participantId,
      presenceGeneration: 1,
      graceEndsAt: new Date(NOW),
    };
    const lease = {
      lobbyId: identities.host.lobbyId,
      roundId: "round-concurrent-grace-failure",
      deadline: new Date(NOW),
    };
    const graceResult = deferred<"expired">();
    const automaticResult = deferred<"called">();
    const graceStarted = deferred();
    const automaticStarted = deferred();
    const leaseReads: string[] = [];

    try {
      const harness = await createHarness({
        clock: () => new Date(NOW),
        initialPresenceGracePeriods: [grace],
        findAutomaticCallLeases: async () => [lease],
        findAutomaticCallLease: async (lobbyId) => {
          leaseReads.push(lobbyId);
          return null;
        },
        expirePresenceGrace: async () => {
          graceStarted.resolve();
          return graceResult.promise;
        },
        executeAutomaticCall: async () => {
          automaticStarted.resolve();
          return automaticResult.promise;
        },
      });
      const authorityFailure = harness.server.failure.catch((error: unknown) => error);
      await Promise.all([
        waitForSignal(graceStarted.promise, "the failing grace persistence"),
        waitForSignal(automaticStarted.promise, "the concurrent automatic call"),
      ]);

      graceResult.reject(new Error("private grace persistence detail"));
      automaticResult.resolve("called");

      await expect(
        waitForSignal(authorityFailure, "the terminal grace persistence failure"),
      ).resolves.toMatchObject({ message: "Game server authority failed." });
      await waitForSignal(
        new Promise<void>((resolve) => setImmediate(resolve)),
        "grace failure promise reactions",
      );
      expect(leaseReads).toEqual([]);
    } finally {
      graceResult.resolve("expired");
      automaticResult.resolve("called");
    }
  });

  test("latches a final disconnect rejection before automatic success reconciliation", async () => {
    const credential = ticket(66);
    const lease = {
      lobbyId: identities.otherLobby.lobbyId,
      roundId: "round-concurrent-disconnect-failure",
      deadline: new Date(NOW),
    };
    const disconnectResult = deferred<null>();
    const automaticResult = deferred<"called">();
    const disconnectStarted = deferred();
    const automaticStarted = deferred();
    const leaseReads: string[] = [];
    const disconnectRecords: Parameters<OperationalLogger["disconnectPause"]>[0][] = [];
    const logger: OperationalLogger = {
      withCommandCorrelation: (_commandId, operation) => operation(),
      command: () => {},
      lobbyEvent: () => {},
      transactionRetry: () => {},
      disconnectPause: (record) => disconnectRecords.push(record),
      restartRestoration: () => {},
    };

    try {
      const harness = await createHarness({
        clock: () => new Date(NOW),
        tickets: new Map([[ticketHash(credential), identities.host]]),
        operationalLogger: logger,
        findAutomaticCallLeases: async () => [lease],
        findAutomaticCallLease: async (lobbyId) => {
          leaseReads.push(lobbyId);
          return null;
        },
        unregisterPresence: async () => {
          disconnectStarted.resolve();
          return disconnectResult.promise;
        },
        executeAutomaticCall: async () => {
          automaticStarted.resolve();
          return automaticResult.promise;
        },
      });
      const client = await harness.connect(credential);
      const authorityFailure = harness.server.failure.catch((error: unknown) => error);
      await waitForSignal(automaticStarted.promise, "the concurrent automatic call");
      client.disconnect();
      await waitForSignal(disconnectStarted.promise, "the failing final disconnect");

      automaticResult.resolve("called");
      disconnectResult.reject(new Error("private disconnect persistence detail"));

      await expect(
        waitForSignal(authorityFailure, "the terminal disconnect persistence failure"),
      ).resolves.toMatchObject({ message: "Game server authority failed." });
      await waitForSignal(
        new Promise<void>((resolve) => setImmediate(resolve)),
        "disconnect failure promise reactions",
      );
      expect(leaseReads).toEqual([]);
      expect(disconnectRecords).toEqual([
        {
          lobbyId: identities.host.lobbyId,
          participantId: identities.host.participantId,
          presenceGeneration: 1,
          outcome: "failed",
        },
      ]);
    } finally {
      disconnectResult.resolve(null);
      automaticResult.resolve("called");
    }
  });

  test("tracks multiple tabs for one participant session and releases each connection", async () => {
    const firstCredential = ticket(60);
    const secondCredential = ticket(61);
    const registered: AuthenticatedRealtimeIdentity[] = [];
    const heartbeats: AuthenticatedRealtimeIdentity[] = [];
    const unregistered: AuthenticatedRealtimeIdentity[] = [];
    const bothHeartbeats = deferred();
    const firstRelease = deferred();
    const secondRelease = deferred();
    const harness = await createHarness({
      tickets: new Map<string, AuthenticatedRealtimeIdentity>([
        [ticketHash(firstCredential), identities.host],
        [ticketHash(secondCredential), identities.host],
      ]),
      registerPresence: async (identity) => {
        registered.push(identity);
        return 7;
      },
      recordHeartbeat: async (identity) => {
        heartbeats.push(identity);
        if (heartbeats.length === 2) bothHeartbeats.resolve();
        return true;
      },
      unregisterPresence: async (identity, presenceGeneration) => {
        expect(presenceGeneration).toBe(7);
        unregistered.push(identity);
        (unregistered.length === 1 ? firstRelease : secondRelease).resolve();
        return null;
      },
    });
    const first = await harness.connect(firstCredential);
    const second = await harness.connect(secondCredential);

    first.emit("v1:command", { schemaVersion: CONTRACT_SCHEMA_VERSION, type: "heartbeat" });
    second.emit("v1:command", { schemaVersion: CONTRACT_SCHEMA_VERSION, type: "heartbeat" });
    await waitForSignal(bothHeartbeats.promise, "both authenticated heartbeats");

    first.disconnect();
    await waitForSignal(firstRelease.promise, "the first tab presence release");
    expect(second.connected).toBe(true);
    expect(unregistered).toEqual([identities.host]);

    second.disconnect();
    await waitForSignal(secondRelease.promise, "the final tab presence release");
    expect(registered).toEqual([identities.host, identities.host]);
    expect(heartbeats).toEqual([identities.host, identities.host]);
    expect(unregistered).toEqual([identities.host, identities.host]);
  });

  test("fails closed before snapshot restoration when presence registration is rejected", async () => {
    const credential = ticket(62);
    let snapshotQueries = 0;
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      registerPresence: async () => null,
      snapshot: async () => {
        snapshotQueries += 1;
        return waitingSnapshot;
      },
    });
    const client = harness.open(credential);
    const error = once<unknown>(client, "v1:error");
    const disconnected = once<void>(client, "disconnect");

    client.connect();
    await once<void>(client, "connect");

    await expect(error).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    await disconnected;
    expect(snapshotQueries).toBe(0);
  });

  test("disconnects with a safe error when heartbeat persistence fails", async () => {
    const credential = ticket(63);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      recordHeartbeat: async () => {
        throw new Error("private heartbeat persistence detail");
      },
    });
    const client = await harness.connect(credential);
    const error = once<unknown>(client, "v1:error");
    const disconnected = once<void>(client, "disconnect");

    client.emit("v1:command", { schemaVersion: CONTRACT_SCHEMA_VERSION, type: "heartbeat" });

    await expect(error).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
    await disconnected;
  });

  test("stops accepting connections when disconnect presence persistence fails", async () => {
    const firstCredential = ticket(64);
    const secondCredential = ticket(65);
    const releaseAttempted = deferred();
    const harness = await createHarness({
      tickets: new Map<string, AuthenticatedRealtimeIdentity>([
        [ticketHash(firstCredential), identities.host],
        [ticketHash(secondCredential), identities.host],
      ]),
      unregisterPresence: async () => {
        releaseAttempted.resolve();
        throw new Error("private disconnect persistence detail");
      },
    });
    const first = await harness.connect(firstCredential);
    const authorityFailure = harness.server.failure.then(
      () => null,
      (error: unknown) => error,
    );

    first.disconnect();
    await waitForSignal(releaseAttempted.promise, "the failed presence release");
    await expect(authorityFailure).resolves.toMatchObject({
      message: "Game server authority failed.",
    });

    await expect(harness.reject(secondCredential)).resolves.toBeDefined();
  });

  testDatabase("aggregates PostgreSQL-backed tabs and relays final grace and absence", async () => {
    let now = new Date("2026-07-17T21:00:00.000Z");
    const database = await connectDatabase(testDatabaseUrl!, {
      lifecycleClock: () => now,
      roundCommands: {
        patterns: patternCatalog,
        nearWinFeedbackEnabled: true,
        coWinnerWindowMs: 2_000,
        clock: () => now,
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
        nextId: (prefix) => `${prefix}-${randomUUID()}`,
      },
    });
    let subscription: Awaited<ReturnType<typeof subscribeGameServerToActiveLobbyEvents>> | null =
      null;
    let harness: Awaited<ReturnType<typeof createHarness>> | null = null;
    const releaseFinalHostGrace = deferred();
    try {
      const suffix = randomUUID();
      const lobbyId = `lobby-tabs-${suffix}`;
      const hostParticipantId = `participant-tabs-host-${suffix}`;
      const hostSessionId = `session-tabs-host-${suffix}`;
      const playerParticipantId = `participant-tabs-player-${suffix}`;
      const playerSessionId = `session-tabs-player-${suffix}`;
      const hostTokenHash = new Uint8Array(randomBytes(32));
      const playerTokenHash = new Uint8Array(randomBytes(32));
      const created = await database.lobbyStates.createLobbyWithHost({
        lobbyId,
        participantId: hostParticipantId,
        sessionId: hostSessionId,
        commandId: `command-tabs-host-${suffix}`,
        username: `Tabs Host ${suffix}`,
        themeId: "classic",
        tokenHash: hostTokenHash,
        issuedAt: new Date("2026-07-17T20:59:00.000Z"),
        maxActiveLobbies: 100_000,
        nextCode: randomLobbyCode,
      });
      if (!created.ok) throw new Error(created.error.message);
      const joined = await database.lobbyStates.joinLobbyWithSession({
        lobbyId,
        lobbyCode: created.entry.lobbyCode,
        participantId: playerParticipantId,
        sessionId: playerSessionId,
        commandId: `command-tabs-player-${suffix}`,
        username: `Tabs Player ${suffix}`,
        tokenHash: playerTokenHash,
        issuedAt: new Date("2026-07-17T20:59:30.000Z"),
        maxPlayersPerLobby: 25,
      });
      if (!joined.ok) throw new Error(joined.error.message);
      for (const command of [
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "create-round",
          commandId: `command-tabs-create-${suffix}`,
        },
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "configure",
          commandId: `command-tabs-configure-${suffix}`,
          patternId: "standard-one-line",
          callConfiguration: { mode: "manual" },
        },
      ]) {
        const result = await database.roundCommands.executeAuthenticated({
          lobbyId,
          participantId: hostParticipantId,
          participantSessionId: hostSessionId,
          command: MutationCommandSchema.parse(command),
        });
        if (!result.ok) throw new Error(result.error.code);
      }

      const credentials = {
        player: Buffer.from(randomBytes(32)).toString("base64url"),
        hostFirst: Buffer.from(randomBytes(32)).toString("base64url"),
        hostSecond: Buffer.from(randomBytes(32)).toString("base64url"),
        hostUnused: Buffer.from(randomBytes(32)).toString("base64url"),
      };
      for (const [credential, tokenHash] of [
        [credentials.player, playerTokenHash],
        [credentials.hostFirst, hostTokenHash],
        [credentials.hostSecond, hostTokenHash],
        [credentials.hostUnused, hostTokenHash],
      ] as const) {
        const issued = await database.lobbyStates.issueRealtimeTicket({
          lobbyId,
          sessionTokenHash: tokenHash,
          ticketHash: Buffer.from(ticketHash(credential), "hex"),
          ttlSeconds: 60,
        });
        if (!issued.ok) throw new Error(issued.error.code);
      }

      const firstHostRelease = deferred();
      const finalHostRelease = deferred();
      const finalHostPersistence = deferred();
      let hostReleaseCount = 0;
      harness = await createHarness({
        clock: () => now,
        consumeTicket: (hash) =>
          database.lobbyStates.consumeRealtimeTicket({
            ticketHash: Buffer.from(hash, "hex"),
          }),
        snapshot: (identity) => database.lobbyStates.findAuthorizedSnapshotByIdentity(identity),
        authorize: (identity) => database.lobbyStates.isParticipantSessionIdentityActive(identity),
        registerPresence: (identity) => database.lobbyStates.registerRealtimeConnection(identity),
        recordHeartbeat: (identity) => database.lobbyStates.recordRealtimeHeartbeat(identity),
        unregisterPresence: async (identity, presenceGeneration) => {
          const grace = await database.lobbyStates.unregisterRealtimeConnection({
            ...identity,
            presenceGeneration,
            reconnectWindowSeconds: 120,
            disconnectPauseGraceSeconds: 10,
          });
          if (identity.participantId === hostParticipantId) {
            hostReleaseCount += 1;
            if (hostReleaseCount === 1) {
              firstHostRelease.resolve();
            } else {
              finalHostPersistence.resolve();
              await releaseFinalHostGrace.promise;
              finalHostRelease.resolve();
            }
          }
          return grace;
        },
        expirePresenceGrace: (grace) => database.lobbyStates.expireRealtimePresenceGrace(grace),
      });
      subscription = await subscribeGameServerToActiveLobbyEvents(
        database.activeLobbyEvents,
        harness.server,
      );

      const player = await harness.connect(credentials.player);
      const hostConnected = once<unknown>(player, "v1:lobby-event");
      const firstHost = await harness.connect(credentials.hostFirst);
      await expect(hostConnected).resolves.toMatchObject({
        type: "presence",
        presence: { participantId: hostParticipantId, status: "connected" },
      });
      const secondHost = await harness.connect(credentials.hostSecond);
      const roundStarted = once<unknown>(player, "v1:lobby-event");
      const started = await database.roundCommands.executeAuthenticated({
        lobbyId,
        participantId: hostParticipantId,
        participantSessionId: hostSessionId,
        command: MutationCommandSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "start-round",
          commandId: `command-tabs-start-${suffix}`,
        }),
      });
      if (!started.ok) throw new Error(started.error.code);
      await expect(roundStarted).resolves.toMatchObject({
        type: "stage",
        round: { stage: "active" },
      });

      firstHost.disconnect();
      await waitForSignal(firstHostRelease.promise, "the first PostgreSQL host tab release");
      const resynced = once<{ snapshot: Snapshot }>(player, "v1:snapshot");
      player.emit("v1:command", {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "resync",
        lastEventSequence: null,
      });
      const afterFirstClose = await resynced;
      expect(
        afterFirstClose.snapshot.participants.find(({ id }) => id === hostParticipantId)?.presence,
      ).toMatchObject({ status: "connected" });

      now = new Date("2026-07-17T21:01:00.000Z");
      const hostGrace = once<unknown>(player, "v1:lobby-event");
      secondHost.disconnect();
      await waitForSignal(finalHostPersistence.promise, "the final PostgreSQL host persistence");
      await expect(hostGrace).resolves.toMatchObject({
        type: "presence",
        presence: {
          participantId: hostParticipantId,
          status: "grace",
          graceEndsAt: "2026-07-17T21:01:10.000Z",
        },
      });
      vi.useFakeTimers({ now });
      releaseFinalHostGrace.resolve();
      await waitForSignal(finalHostRelease.promise, "the final PostgreSQL host tab release");
      let persisted = await database.lobbyStates.findById(lobbyId);
      expect(
        persisted?.presenceGenerations
          .filter(({ participantId }) => participantId === hostParticipantId)
          .at(-1),
      ).toMatchObject({
        status: "grace",
        connectionCount: 0,
        graceEndsAt: new Date("2026-07-17T21:01:10.000Z"),
      });
      expect(persisted?.sessions.find(({ id }) => id === hostSessionId)).toMatchObject({
        status: "disconnected",
        disconnectedAt: now,
        rejoinUntil: new Date("2026-07-17T21:03:00.000Z"),
      });
      await expect(
        database.lobbyStates.consumeRealtimeTicket({
          ticketHash: Buffer.from(ticketHash(credentials.hostUnused), "hex"),
        }),
      ).resolves.toBeNull();

      await vi.advanceTimersByTimeAsync(9_999);
      expect((await database.lobbyStates.findById(lobbyId))?.round).toMatchObject({
        stage: "active",
        pauseReason: null,
      });

      const relayed: unknown[] = [];
      const bothRelayed = deferred();
      const onLobbyEvent = (event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          ((event as { type?: unknown }).type === "presence" ||
            (event as { type?: unknown }).type === "stage")
        ) {
          relayed.push(event);
          if (relayed.length === 2) bothRelayed.resolve();
        }
      };
      player.on("v1:lobby-event", onLobbyEvent);
      now = new Date("2026-07-17T21:01:10.000Z");
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      await bothRelayed.promise;
      player.off("v1:lobby-event", onLobbyEvent);
      expect(relayed).toMatchObject([
        {
          type: "presence",
          presence: {
            participantId: hostParticipantId,
            status: "absent",
            absentSince: now.toISOString(),
          },
        },
        {
          type: "stage",
          round: { stage: "paused", pauseReason: "host-absent" },
        },
      ]);
      expect((relayed[1] as { eventSequence: number }).eventSequence).toBe(
        (relayed[0] as { eventSequence: number }).eventSequence + 1,
      );
      persisted = await database.lobbyStates.findById(lobbyId);
      expect(
        persisted?.presenceGenerations
          .filter(({ participantId }) => participantId === hostParticipantId)
          .at(-1),
      ).toMatchObject({ status: "absent", connectionCount: 0, absentSince: now });
      expect(persisted?.round).toMatchObject({
        stage: "paused",
        pauseReason: "host-absent",
        pausedAt: now,
        nextCallAt: null,
      });
    } finally {
      releaseFinalHostGrace.resolve();
      vi.useRealTimers();
      await harness?.server.close();
      await subscription?.close();
      await database.disconnect();
    }
  });

  test("automatically restores the latest full snapshot with a fresh reconnect ticket", async () => {
    const firstCredential = ticket(50);
    const reconnectCredential = ticket(51);
    let durableSnapshot = activeSnapshot;
    const requestedIdentities: AuthenticatedRealtimeIdentity[] = [];
    const harness = await createHarness({
      tickets: new Map([
        [ticketHash(firstCredential), identities.host],
        [ticketHash(reconnectCredential), identities.host],
      ]),
      snapshot: async (identity) => {
        requestedIdentities.push(identity);
        return durableSnapshot;
      },
    });

    const firstClient = harness.open(firstCredential);
    const firstSnapshot = once<unknown>(firstClient, "v1:snapshot");
    firstClient.connect();
    await once<void>(firstClient, "connect");
    await expect(firstSnapshot).resolves.toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "snapshot",
      snapshot: activeSnapshot,
    });

    const disconnected = once<void>(firstClient, "disconnect");
    firstClient.disconnect();
    await disconnected;
    durableSnapshot = pausedSnapshot;

    const reconnectClient = harness.open(reconnectCredential);
    const reconnectSnapshot = once<unknown>(reconnectClient, "v1:snapshot");
    reconnectClient.connect();
    await once<void>(reconnectClient, "connect");
    await expect(reconnectSnapshot).resolves.toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "snapshot",
      snapshot: pausedSnapshot,
    });
    expect(requestedIdentities).toEqual([identities.host, identities.host]);
    expect(harness.consumedHashes).toEqual([
      ticketHash(firstCredential),
      ticketHash(reconnectCredential),
    ]);
    expect(JSON.stringify(pausedSnapshot)).not.toMatch(/drawOrder|card_player/);
  });

  test("restores durable result state after the game-server authority restarts", async () => {
    const firstCredential = ticket(52);
    const firstHarness = await createHarness({
      tickets: new Map([[ticketHash(firstCredential), identities.host]]),
      snapshot: async () => activeSnapshot,
    });
    const firstClient = firstHarness.open(firstCredential);
    const firstSnapshot = once<unknown>(firstClient, "v1:snapshot");
    firstClient.connect();
    await once<void>(firstClient, "connect");
    await expect(firstSnapshot).resolves.toMatchObject({ snapshot: activeSnapshot });

    const firstDisconnect = once<void>(firstClient, "disconnect");
    await firstHarness.server.close();
    await firstDisconnect;

    const restartCredential = ticket(53);
    const restartedHarness = await createHarness({
      tickets: new Map([[ticketHash(restartCredential), identities.host]]),
      snapshot: async () => resultSnapshot,
    });
    const restartedClient = restartedHarness.open(restartCredential);
    const restartedSnapshot = once<unknown>(restartedClient, "v1:snapshot");
    restartedClient.connect();
    await once<void>(restartedClient, "connect");

    await expect(restartedSnapshot).resolves.toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "snapshot",
      snapshot: resultSnapshot,
    });
    expect(restartedHarness.executed).toEqual([]);
  });

  testDatabase(
    "restores the exact PostgreSQL-backed authorized snapshot after authority restart",
    async () => {
      const fixture = createRestartLobbyState();
      const lifecycleTime = new Date("2026-07-17T20:00:04.000Z");
      let firstDatabase: Awaited<ReturnType<typeof connectDatabase>> | null = null;
      let restartedDatabase: Awaited<ReturnType<typeof connectDatabase>> | null = null;
      try {
        firstDatabase = await connectDatabase(testDatabaseUrl!, {
          lifecycleClock: () => lifecycleTime,
        });
        const created = await firstDatabase.lobbyStates.createActive(fixture.state, {
          maxActiveLobbies: 100_000,
          nextCode: randomLobbyCode,
        });
        if (!created.ok) throw new Error(created.error.message);
        const expected = fixture.expectedSnapshot(created.code, lifecycleTime.toISOString());

        const firstCredential = Buffer.from(randomBytes(32)).toString("base64url");
        await expect(
          firstDatabase.lobbyStates.issueRealtimeTicket({
            lobbyId: fixture.identity.lobbyId,
            sessionTokenHash: fixture.sessionTokenHash,
            ticketHash: Buffer.from(ticketHash(firstCredential), "hex"),
            ttlSeconds: 60,
          }),
        ).resolves.toMatchObject({ ok: true });
        const firstAuthority = await createHarness({
          consumeTicket: (hash) =>
            firstDatabase!.lobbyStates.consumeRealtimeTicket({
              ticketHash: Buffer.from(hash, "hex"),
            }),
          snapshot: (identity) =>
            firstDatabase!.lobbyStates.findAuthorizedSnapshotByIdentity(identity),
          authorize: (identity) =>
            firstDatabase!.lobbyStates.isParticipantSessionIdentityActive(identity),
        });
        const firstClient = firstAuthority.open(firstCredential);
        const firstSnapshot = once<unknown>(firstClient, "v1:snapshot");
        firstClient.connect();
        await once<void>(firstClient, "connect");
        await expect(firstSnapshot).resolves.toEqual({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "snapshot",
          snapshot: expected,
        });

        const firstDisconnect = once<void>(firstClient, "disconnect");
        await firstAuthority.server.close();
        await firstDisconnect;
        await firstDatabase.disconnect();
        firstDatabase = null;

        restartedDatabase = await connectDatabase(testDatabaseUrl!, {
          lifecycleClock: () => lifecycleTime,
        });
        const restartCredential = Buffer.from(randomBytes(32)).toString("base64url");
        await expect(
          restartedDatabase.lobbyStates.issueRealtimeTicket({
            lobbyId: fixture.identity.lobbyId,
            sessionTokenHash: fixture.sessionTokenHash,
            ticketHash: Buffer.from(ticketHash(restartCredential), "hex"),
            ttlSeconds: 60,
          }),
        ).resolves.toMatchObject({ ok: true });
        const restartedAuthority = await createHarness({
          consumeTicket: (hash) =>
            restartedDatabase!.lobbyStates.consumeRealtimeTicket({
              ticketHash: Buffer.from(hash, "hex"),
            }),
          snapshot: (identity) =>
            restartedDatabase!.lobbyStates.findAuthorizedSnapshotByIdentity(identity),
          authorize: (identity) =>
            restartedDatabase!.lobbyStates.isParticipantSessionIdentityActive(identity),
        });
        const restartedClient = restartedAuthority.open(restartCredential);
        const restartedSnapshot = once<unknown>(restartedClient, "v1:snapshot");
        restartedClient.connect();
        await once<void>(restartedClient, "connect");

        await expect(restartedSnapshot).resolves.toEqual({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "snapshot",
          snapshot: expected,
        });
        expect(JSON.stringify(expected)).not.toMatch(
          new RegExp(`${fixture.foreignCardId}|drawOrder|tokenHash|commandResults|events`),
        );
      } finally {
        await firstDatabase?.disconnect();
        await restartedDatabase?.disconnect();
      }
    },
  );

  testProcessRestart(
    "restores paused and co-winner lobbies after the game-server process restarts",
    async () => {
      const pausedFixture = createRestartLobbyState();
      const resultFixture = createRestartLobbyState();
      const latestActivityAt = new Date();
      const pausedAt = new Date(latestActivityAt.getTime() - 1_000);
      const pausedRound = pausedFixture.state.round!;
      const pausedCall = pausedRound.calls[0]!;
      const pausedEvents = [
        {
          sequence: 1n,
          roundId: pausedRound.id,
          eventType: "call",
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          payload: {
            call: {
              ...pausedCall,
              roundId: pausedRound.id,
              calledAt: pausedCall.calledAt.toISOString(),
            },
          },
          createdAt: pausedCall.calledAt,
        },
        {
          sequence: 2n,
          roundId: pausedRound.id,
          eventType: "stage",
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          payload: {
            round: {
              id: pausedRound.id,
              lobbyId: pausedFixture.identity.lobbyId,
              patternId: pausedRound.currentPatternId,
              callConfiguration: { mode: "automatic" as const, intervalSeconds: 30 as const },
              stage: "paused" as const,
              pauseReason: "host-command" as const,
              pausedAt: pausedAt.toISOString(),
              startedAt: pausedRound.startedAt!.toISOString(),
            },
          },
          createdAt: pausedAt,
        },
      ];
      const winningBalls = [1, 16, 31, 46, 61] as const;
      const resultRound = resultFixture.state.round!;
      const resultCalls = winningBalls.map((ball, index) => ({
        id: `${resultRound.id}-call-${String(index + 1)}`,
        position: index + 1,
        ball,
        calledAt: new Date(new Date(NOW).getTime() + index * 100),
      }));
      const triggeringCallId = resultCalls.at(-1)!.id;
      const coWinnerOpenedAt = new Date(resultCalls.at(-1)!.calledAt.getTime() + 1);
      const coWinnerClosesAt = new Date(coWinnerOpenedAt.getTime() + 2_000);
      const resultEvents = [
        ...resultCalls.map((call, index) => ({
          sequence: BigInt(index + 1),
          roundId: resultRound.id,
          eventType: "call",
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          payload: {
            call: {
              ...call,
              roundId: resultRound.id,
              calledAt: call.calledAt.toISOString(),
            },
          },
          createdAt: call.calledAt,
        })),
        {
          sequence: 6n,
          roundId: resultRound.id,
          eventType: "co-winner-window",
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          payload: {
            window: {
              triggeringCallId,
              openedAt: coWinnerOpenedAt.toISOString(),
              closesAt: coWinnerClosesAt.toISOString(),
            },
          },
          createdAt: coWinnerOpenedAt,
        },
        {
          sequence: 7n,
          roundId: resultRound.id,
          eventType: "co-winner-result",
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          payload: {
            result: {
              triggeringCallId,
              openedAt: coWinnerOpenedAt.toISOString(),
              closesAt: coWinnerClosesAt.toISOString(),
              settledAt: coWinnerClosesAt.toISOString(),
              winnerParticipantIds: [resultFixture.identity.participantId],
            },
          },
          createdAt: coWinnerClosesAt,
        },
      ];
      const fixtures = [
        {
          kind: "paused" as const,
          fixture: pausedFixture,
          state: {
            ...pausedFixture.state,
            lobby: {
              ...pausedFixture.state.lobby,
              lastActivityAt: latestActivityAt,
              lastEventSequence: 2n,
            },
            presenceGenerations: pausedFixture.state.presenceGenerations.map((presence) => ({
              ...presence,
              status: "absent" as const,
              connectionCount: 0,
              changedAt: latestActivityAt,
              graceEndsAt: null,
              absentSince: latestActivityAt,
            })),
            round: {
              ...pausedFixture.state.round!,
              stage: "paused" as const,
              pausedAt,
              pauseReason: "host-command" as const,
              nextCallAt: null,
              coWinnerTriggeringCallId: null,
              coWinnerOpenedAt: null,
              coWinnerClosesAt: null,
              resultSettledAt: null,
              coWinners: [],
            },
            events: pausedEvents,
          },
        },
        {
          kind: "result" as const,
          fixture: resultFixture,
          state: {
            ...resultFixture.state,
            lobby: {
              ...resultFixture.state.lobby,
              lastActivityAt: latestActivityAt,
              lastEventSequence: 7n,
            },
            presenceGenerations: resultFixture.state.presenceGenerations.map((presence) => ({
              ...presence,
              status: "absent" as const,
              connectionCount: 0,
              changedAt: latestActivityAt,
              graceEndsAt: null,
              absentSince: latestActivityAt,
            })),
            round: {
              ...resultRound,
              drawOrder: [
                ...winningBalls.map((ball, index) => ({ position: index + 1, ball })),
                ...Array.from({ length: 75 }, (_, index) => index + 1)
                  .filter((ball) => !winningBalls.includes(ball as (typeof winningBalls)[number]))
                  .map((ball, index) => ({ position: index + winningBalls.length + 1, ball })),
              ],
              calls: resultCalls,
              cards: resultRound.cards.map((card) =>
                card.participantId === resultFixture.identity.participantId
                  ? {
                      ...card,
                      marks: winningBalls.map((ball, index) => ({
                        id: `${card.id}-mark-${String(index + 1)}`,
                        ball,
                        markedAt:
                          index === winningBalls.length - 1
                            ? coWinnerOpenedAt
                            : resultCalls[index]!.calledAt,
                      })),
                    }
                  : card,
              ),
              coWinnerTriggeringCallId: triggeringCallId,
              coWinnerOpenedAt,
              coWinnerClosesAt,
              resultSettledAt: coWinnerClosesAt,
              coWinners: resultRound.coWinners.map((winner) => ({
                ...winner,
                triggeringCallId,
                confirmedAt: coWinnerOpenedAt,
              })),
            },
            events: resultEvents,
          },
        },
      ];
      expect(fixtures[0]!.state.events.map(({ eventType }) => eventType)).toEqual([
        "call",
        "stage",
      ]);
      const settledResult = fixtures[1]!.state.round!;
      expect(settledResult.cards[0]!.marks.at(-1)!.markedAt).toEqual(
        settledResult.coWinnerOpenedAt,
      );
      expect(settledResult.coWinners[0]!.confirmedAt.getTime()).toBeLessThan(
        settledResult.coWinnerClosesAt!.getTime(),
      );
      expect(fixtures[1]!.state.events.map(({ eventType }) => eventType)).toEqual([
        ...winningBalls.map(() => "call"),
        "co-winner-window",
        "co-winner-result",
      ]);
      for (const { state } of fixtures) {
        for (const event of state.events) {
          expect(() =>
            ActiveLobbyEventSchema.parse({
              schemaVersion: event.schemaVersion,
              type: event.eventType,
              eventSequence: Number(event.sequence),
              occurredAt: event.createdAt.toISOString(),
              ...event.payload,
            }),
          ).not.toThrow();
        }
      }
      const [port] = await findAvailableLoopbackPorts(1);
      const url = `http://127.0.0.1:${String(port)}`;
      const environment = {
        ...process.env,
        DATABASE_URL: testDatabaseUrl!,
        GAME_SERVER_HOST: "127.0.0.1",
        GAME_SERVER_PORT: String(port),
        WEB_ORIGIN: ORIGIN,
      };
      const database = await connectDatabase(testDatabaseUrl!);
      let firstProcess: ChildProcess | null = null;
      let restartedProcess: ChildProcess | null = null;

      const issueTicket = async (
        fixture: ReturnType<typeof createRestartLobbyState>,
        credential: string,
      ) => {
        const issued = await database.lobbyStates.issueRealtimeTicket({
          lobbyId: fixture.identity.lobbyId,
          sessionTokenHash: fixture.sessionTokenHash,
          ticketHash: Buffer.from(ticketHash(credential), "hex"),
          ttlSeconds: 60,
        });
        if (!issued.ok) throw new Error(issued.error.code);
      };
      const openRuntimeClient = (
        credential: string,
        lobbyEvents: unknown[],
      ): { readonly client: Socket; readonly snapshot: Promise<Snapshot> } => {
        const client = createClient(url, {
          autoConnect: false,
          transports: ["websocket"],
          extraHeaders: { Origin: ORIGIN },
          auth: { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket: credential },
          reconnection: false,
        });
        clients.push(client);
        client.on("v1:lobby-event", (event: unknown) => lobbyEvents.push(event));
        const snapshot = once<{ snapshot: unknown }>(client, "v1:snapshot").then((message) =>
          SnapshotSchema.parse(message.snapshot),
        );
        client.connect();
        return { client, snapshot };
      };
      const stableGameState = (snapshot: Snapshot) => ({
        round: snapshot.round,
        ownCard: snapshot.ownCard,
        ownMarks: snapshot.ownMarks,
        calls: snapshot.calls,
        timer: snapshot.timer,
      });

      await runWithBoundedCleanup(
        async () => {
          for (const entry of fixtures) {
            const created = await database.lobbyStates.createActive(entry.state, {
              maxActiveLobbies: 100_000,
              nextCode: randomLobbyCode,
            });
            if (!created.ok) throw new Error(created.error.message);
          }

          const firstCredentials = fixtures.map(() =>
            Buffer.from(randomBytes(32)).toString("base64url"),
          );
          for (const [index, entry] of fixtures.entries()) {
            await issueTicket(entry.fixture, firstCredentials[index]!);
          }

          firstProcess = await startGameServerProcess(environment, `${url}/healthz`);
          const firstProcessId = firstProcess.pid;
          const firstConnections = firstCredentials.map((credential) =>
            openRuntimeClient(credential, []),
          );
          const firstSnapshots = await Promise.all(
            firstConnections.map(({ snapshot }) => snapshot),
          );

          const firstDisconnects = firstConnections.map(({ client }) =>
            once<void>(client, "disconnect"),
          );
          await stopChild(firstProcess);
          firstProcess = null;
          await Promise.all(firstDisconnects);
          await expect(database.checkReadiness()).resolves.toBe(true);

          const restartCredentials = fixtures.map(() =>
            Buffer.from(randomBytes(32)).toString("base64url"),
          );
          for (const [index, entry] of fixtures.entries()) {
            expect(restartCredentials[index]).not.toBe(firstCredentials[index]);
            await expect(
              database.lobbyStates.rejoinParticipantSessionByTokenHash({
                lobbyId: entry.fixture.identity.lobbyId,
                tokenHash: entry.fixture.sessionTokenHash,
              }),
            ).resolves.toMatchObject({ status: "active" });
            await issueTicket(entry.fixture, restartCredentials[index]!);
          }

          restartedProcess = await startGameServerProcess(environment, `${url}/healthz`);
          expect(restartedProcess.pid).toBeDefined();
          expect(restartedProcess.pid).not.toBe(firstProcessId);
          for (const credential of firstCredentials) {
            const rejectedClient = createClient(url, {
              autoConnect: false,
              transports: ["websocket"],
              extraHeaders: { Origin: ORIGIN },
              auth: { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket: credential },
              reconnection: false,
            });
            clients.push(rejectedClient);
            const rejected = once<Error & { data?: unknown }>(rejectedClient, "connect_error");
            rejectedClient.connect();
            await expect(rejected).resolves.toMatchObject({ data: { code: "UNAUTHORIZED" } });
          }
          const restartedEvents = fixtures.map(() => [] as unknown[]);
          const restartedConnections = restartCredentials.map((credential, index) =>
            openRuntimeClient(credential, restartedEvents[index]!),
          );
          const restartedSnapshots = await Promise.all(
            restartedConnections.map(({ snapshot }) => snapshot),
          );
          await new Promise((resolve) => realSetTimeout(resolve, 75));

          for (const [index, entry] of fixtures.entries()) {
            const firstSnapshot = firstSnapshots[index]!;
            const restartedSnapshot = restartedSnapshots[index]!;
            expect(stableGameState(restartedSnapshot)).toEqual(stableGameState(firstSnapshot));
            expect(restartedSnapshot.round?.callConfiguration).toEqual({
              mode: "automatic",
              intervalSeconds: 30,
            });
            expect(restartedSnapshot.ownCard).toMatchObject({
              participantId: entry.fixture.identity.participantId,
              cells: activeSnapshot.ownCard!.cells,
            });
            expect(restartedSnapshot.ownMarks.map(({ ball }) => ball)).toEqual(
              entry.state.round!.cards[0]!.marks.map(({ ball }) => ball),
            );
            expect(
              restartedSnapshot.calls.map(({ position, ball }) => ({ position, ball })),
            ).toEqual(entry.state.round!.calls.map(({ position, ball }) => ({ position, ball })));
            expect(new Set(restartedSnapshot.calls.map(({ ball }) => ball)).size).toBe(
              restartedSnapshot.calls.length,
            );
            expect(restartedEvents[index]).toEqual([]);
            expect(JSON.stringify(restartedSnapshot)).not.toMatch(
              new RegExp(
                `${entry.fixture.foreignCardId}|drawOrder|tokenHash|commandResults|"events"`,
              ),
            );

            if (entry.kind === "paused") {
              expect(restartedSnapshot.round).toMatchObject({
                stage: "paused",
                pauseReason: "host-command",
                pausedAt: pausedAt.toISOString(),
              });
            } else {
              expect(restartedSnapshot.round).toMatchObject({
                stage: "result",
                result: {
                  triggeringCallId,
                  settledAt: entry.state.round!.resultSettledAt!.toISOString(),
                  winnerParticipantIds: [entry.fixture.identity.participantId],
                },
              });
            }
          }
        },
        [
          { label: "first game-server process", run: () => stopChild(firstProcess) },
          { label: "restarted game-server process", run: () => stopChild(restartedProcess) },
          { label: "PostgreSQL connection", run: () => database.disconnect() },
        ],
        10_000,
      );
    },
    30_000,
  );

  testDatabase(
    "recovers one persisted automatic call after authority restart",
    async () => {
      const fixture = createRestartLobbyState();
      const startedAt = new Date("2026-07-17T22:00:00.000Z");
      const deadline = new Date("2026-07-17T22:00:30.000Z");
      let now = startedAt;
      const sourceRound = fixture.state.round!;
      const state: NewActiveLobbyState = {
        ...fixture.state,
        lobby: {
          ...fixture.state.lobby,
          status: "active",
          lastActivityAt: startedAt,
          lastEventSequence: 0n,
        },
        round: {
          ...sourceRound,
          stage: "active",
          activeAt: startedAt,
          pausedAt: null,
          pauseReason: null,
          nextCallAt: deadline,
          coWinnerTriggeringCallId: null,
          coWinnerOpenedAt: null,
          coWinnerClosesAt: null,
          resultSettledAt: null,
          endedAt: null,
          coWinners: [],
        },
        events: [],
        commandResults: [],
      };
      const databaseOptions = {
        lifecycleClock: () => now,
        roundCommands: {
          patterns: patternCatalog,
          nearWinFeedbackEnabled: true,
          coWinnerWindowMs: 2_000,
          clock: () => now,
          randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
          nextId: (prefix: "round" | "card" | "call" | "mark") => `${prefix}-${randomUUID()}`,
        },
      };
      let firstDatabase: Awaited<ReturnType<typeof connectDatabase>> | null = null;
      let restartedDatabase: Awaited<ReturnType<typeof connectDatabase>> | null = null;
      let firstAuthority: Awaited<ReturnType<typeof createHarness>> | null = null;
      let restartedAuthority: Awaited<ReturnType<typeof createHarness>> | null = null;
      let subscription: Awaited<ReturnType<typeof subscribeGameServerToActiveLobbyEvents>> | null =
        null;
      vi.useFakeTimers({ now });

      try {
        firstDatabase = await connectDatabase(testDatabaseUrl!, databaseOptions);
        const created = await firstDatabase.lobbyStates.createActive(state, {
          maxActiveLobbies: 100_000,
          nextCode: randomLobbyCode,
        });
        if (!created.ok) throw new Error(created.error.message);
        const automaticLifecycle = (
          database: NonNullable<typeof firstDatabase> | NonNullable<typeof restartedDatabase>,
        ) => ({
          findAutomaticCallLeases: async () => {
            const lease = await database.roundCommands.findAutomaticCallLease(
              fixture.identity.lobbyId,
            );
            return lease === null ? [] : [lease];
          },
          findAutomaticCallLease: (lobbyId: string) =>
            database.roundCommands.findAutomaticCallLease(lobbyId),
          executeAutomaticCall: (lease: { lobbyId: string; roundId: string; deadline: Date }) =>
            database.roundCommands.executeAutomaticCall(lease),
        });

        firstAuthority = await createHarness({
          clock: () => now,
          ...automaticLifecycle(firstDatabase),
        });
        now = new Date("2026-07-17T22:00:10.000Z");
        await vi.advanceTimersByTimeAsync(10_000);
        await firstAuthority.server.close();
        firstAuthority = null;
        expect(
          (await firstDatabase.lobbyStates.findById(fixture.identity.lobbyId))?.round?.calls,
        ).toHaveLength(1);
        await firstDatabase.disconnect();
        firstDatabase = null;

        restartedDatabase = await connectDatabase(testDatabaseUrl!, databaseOptions);
        restartedAuthority = await createHarness({
          clock: () => now,
          ...automaticLifecycle(restartedDatabase),
        });
        const called = deferred();
        subscription = await subscribeGameServerToActiveLobbyEvents(
          restartedDatabase.activeLobbyEvents,
          {
            publishLobbyEventFromSource: async (_lobbyId, _sequence, loadEvent) => {
              const event = await loadEvent();
              if (event.type === "call") called.resolve();
            },
          },
        );

        await vi.advanceTimersByTimeAsync(19_999);
        expect(
          (await restartedDatabase.lobbyStates.findById(fixture.identity.lobbyId))?.round?.calls,
        ).toHaveLength(1);
        now = deadline;
        await vi.advanceTimersByTimeAsync(1);
        await waitForSignal(called.promise, "the restarted automatic call event");

        const restored = await restartedDatabase.lobbyStates.findById(fixture.identity.lobbyId);
        expect(restored?.round?.calls.map(({ position, ball }) => ({ position, ball }))).toEqual([
          { position: 1, ball: 1 },
          { position: 2, ball: 2 },
        ]);
        expect(new Set(restored?.round?.calls.map(({ ball }) => ball)).size).toBe(2);
        expect(restored?.round?.nextCallAt).toEqual(new Date("2026-07-17T22:01:00.000Z"));
      } finally {
        vi.useRealTimers();
        await firstAuthority?.server.close();
        await restartedAuthority?.server.close();
        await subscription?.close();
        await firstDatabase?.disconnect();
        await restartedDatabase?.disconnect();
      }
    },
    15_000,
  );

  test.each([
    ["unauthorized", async (): Promise<Snapshot | null> => null, "UNAUTHORIZED"],
    [
      "persistence failure",
      async (): Promise<Snapshot | null> => {
        throw new Error("private snapshot persistence detail");
      },
      "INTERNAL_ERROR",
    ],
  ] as const)(
    "disconnects when initial snapshot restoration has an %s",
    async (_case, snapshot, code) => {
      const credential = ticket(code === "UNAUTHORIZED" ? 54 : 55);
      const harness = await createHarness({
        tickets: new Map([[ticketHash(credential), identities.host]]),
        snapshot,
      });
      const client = harness.open(credential);
      const error = once<unknown>(client, "v1:error");
      const disconnected = once<void>(client, "disconnect");
      const snapshots: unknown[] = [];
      client.on("v1:snapshot", (message) => snapshots.push(message));

      client.connect();

      const receivedError = await error;
      expect(receivedError).toMatchObject({ code });
      expect(JSON.stringify(receivedError)).not.toContain("private snapshot persistence detail");
      await disconnected;
      expect(snapshots).toEqual([]);
    },
  );

  test("establishes the snapshot baseline before buffered live events", async () => {
    const credential = ticket(56);
    const snapshotRequested = deferred();
    const releaseSnapshot = deferred();
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      snapshot: async () => {
        snapshotRequested.resolve();
        await releaseSnapshot.promise;
        return activeSnapshot;
      },
    });
    const client = harness.open(credential);
    const observed: string[] = [];
    const laterEventObserved = deferred();
    client.on("v1:snapshot", (message: { snapshot: { lastEventSequence: number | null } }) => {
      observed.push(`snapshot:${message.snapshot.lastEventSequence}`);
    });
    client.on("v1:lobby-event", (event: { eventSequence: number }) => {
      observed.push(`event:${event.eventSequence}`);
      if (event.eventSequence === 2) laterEventObserved.resolve();
    });

    client.connect();
    await waitForSignal(snapshotRequested.promise, "initial snapshot loading to start");
    await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
    const laterEvent = ActiveLobbyEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "presence",
      eventSequence: 2,
      occurredAt: LATER,
      presence: {
        participantId: identities.player.participantId,
        generation: 1,
        status: "grace",
        changedAt: LATER,
        graceEndsAt: "2026-07-17T20:00:12.000Z",
      },
    });
    await harness.server.publishLobbyEvent(identities.host.lobbyId, laterEvent);
    releaseSnapshot.resolve();

    await waitForSignal(
      laterEventObserved.promise,
      "the buffered event after the snapshot baseline",
    );
    expect(observed).toEqual(["snapshot:1", "event:2"]);
  });

  test("filters an initialization-era event when authorization settles after the snapshot", async () => {
    const credential = ticket(57);
    const snapshotRequested = deferred();
    const releaseSnapshot = deferred();
    const authorizationRequested = deferred();
    const releaseAuthorization = deferred();
    let snapshotRequests = 0;
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      snapshot: async () => {
        snapshotRequests += 1;
        if (snapshotRequests === 1) {
          snapshotRequested.resolve();
          await releaseSnapshot.promise;
        }
        return activeSnapshot;
      },
      authorize: async () => {
        authorizationRequested.resolve();
        await releaseAuthorization.promise;
        return true;
      },
    });
    const client = harness.open(credential);
    const initialization = once<unknown>(client, "v1:snapshot");
    const observedEvents: unknown[] = [];
    client.on("v1:lobby-event", (event) => observedEvents.push(event));

    client.connect();
    await waitForSignal(snapshotRequested.promise, "initial snapshot loading to start");
    const publication = harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
    try {
      await waitForSignal(authorizationRequested.promise, "delivery authorization to start");
      releaseSnapshot.resolve();
      await initialization;
      releaseAuthorization.resolve();
      await publication;
    } finally {
      releaseSnapshot.resolve();
      releaseAuthorization.resolve();
    }

    const resynchronized = once<unknown>(client, "v1:snapshot");
    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resync",
      lastEventSequence: 1,
    });
    await resynchronized;
    expect(observedEvents).toEqual([]);
  });

  test("filters a queued baseline event whose socket delivery starts after the snapshot", async () => {
    const credential = ticket(58);
    const snapshotRequested = deferred();
    const releaseSnapshot = deferred();
    const loadStarted = deferred();
    const releaseLoad = deferred();
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      snapshot: async () => {
        snapshotRequested.resolve();
        await releaseSnapshot.promise;
        return activeSnapshot;
      },
    });
    const client = harness.open(credential);
    const initialized = once<unknown>(client, "v1:snapshot");
    const observedSequences: number[] = [];
    client.on("v1:lobby-event", (event: { eventSequence: number }) => {
      observedSequences.push(event.eventSequence);
    });

    client.connect();
    await waitForSignal(snapshotRequested.promise, "initial snapshot loading to start");
    const publication = harness.server.publishLobbyEventFromSource(
      identities.host.lobbyId,
      stageEvent.eventSequence,
      async () => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return stageEvent;
      },
    );
    try {
      await waitForSignal(loadStarted.promise, "queued event loading to start");
      releaseSnapshot.resolve();
      await initialized;
      releaseLoad.resolve();
      await publication;
    } finally {
      releaseSnapshot.resolve();
      releaseLoad.resolve();
    }

    const resynchronized = once<unknown>(client, "v1:snapshot");
    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resync",
      lastEventSequence: 1,
    });
    await resynchronized;
    expect(observedSequences).toEqual([]);
  });

  test("establishes a new delivery boundary for an explicit resync snapshot", async () => {
    const credential = ticket(59);
    const resyncRequested = deferred();
    const releaseResync = deferred();
    let snapshotRequests = 0;
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      snapshot: async () => {
        snapshotRequests += 1;
        if (snapshotRequests === 1) return activeSnapshot;
        resyncRequested.resolve();
        await releaseResync.promise;
        return pausedSnapshot;
      },
    });
    const client = await harness.connect(credential);
    const observed: string[] = [];
    client.on("v1:lobby-event", (event: { eventSequence: number }) => {
      observed.push(`event:${event.eventSequence}`);
    });
    client.on("v1:snapshot", (message: { snapshot: { lastEventSequence: number | null } }) => {
      observed.push(`snapshot:${message.snapshot.lastEventSequence}`);
    });
    const resynchronized = once<unknown>(client, "v1:snapshot");

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resync",
      lastEventSequence: 1,
    });
    await waitForSignal(resyncRequested.promise, "resync snapshot loading to start");
    const secondEvent = ActiveLobbyEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "presence",
      eventSequence: 2,
      occurredAt: LATER,
      presence: {
        participantId: identities.player.participantId,
        generation: 1,
        status: "grace",
        changedAt: LATER,
        graceEndsAt: "2026-07-17T20:00:12.000Z",
      },
    });
    try {
      await harness.server.publishLobbyEvent(identities.host.lobbyId, secondEvent);
      releaseResync.resolve();
      await resynchronized;
    } finally {
      releaseResync.resolve();
    }

    expect(observed).toEqual(["snapshot:2"]);
  });

  test("delivers a late-authorized participant event only after the snapshot", async () => {
    const credential = ticket(60);
    const snapshotRequested = deferred();
    const releaseSnapshot = deferred();
    const authorizationRequested = deferred();
    const releaseAuthorization = deferred();
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      snapshot: async () => {
        snapshotRequested.resolve();
        await releaseSnapshot.promise;
        return activeSnapshot;
      },
      authorize: async () => {
        authorizationRequested.resolve();
        await releaseAuthorization.promise;
        return true;
      },
    });
    const client = harness.open(credential);
    const initialized = once<unknown>(client, "v1:snapshot");
    const privateEvent = once<unknown>(client, "v1:private-event");
    const observed: string[] = [];
    client.on("v1:snapshot", () => observed.push("snapshot"));
    client.on("v1:private-event", () => observed.push("private"));

    client.connect();
    await waitForSignal(snapshotRequested.promise, "initial snapshot loading to start");
    const publication = harness.server.publishParticipantEvent(
      identities.host.participantId,
      markEvent,
    );
    try {
      await waitForSignal(
        authorizationRequested.promise,
        "private delivery authorization to start",
      );
      releaseSnapshot.resolve();
      await initialized;
      releaseAuthorization.resolve();
      await publication;
      await privateEvent;
    } finally {
      releaseSnapshot.resolve();
      releaseAuthorization.resolve();
    }

    expect(observed).toEqual(["snapshot", "private"]);
  });

  test("disconnects when the combined synchronization buffer exceeds its bound", async () => {
    const credential = ticket(61);
    const snapshotRequested = deferred();
    const releaseSnapshot = deferred();
    let authorizationCount = 0;
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      snapshot: async () => {
        snapshotRequested.resolve();
        await releaseSnapshot.promise;
        return activeSnapshot;
      },
      authorize: async () => {
        authorizationCount += 1;
        return true;
      },
    });
    const client = harness.open(credential);
    const connected = once<void>(client, "connect");
    const error = once<unknown>(client, "v1:error");
    const disconnected = once<void>(client, "disconnect");
    const observedPrivateEvents: unknown[] = [];
    client.on("v1:private-event", (event) => observedPrivateEvents.push(event));

    client.connect();
    await connected;
    await waitForSignal(snapshotRequested.promise, "initial snapshot loading to start");
    try {
      for (let index = 0; index < 255; index += 1) {
        await harness.server.publishParticipantEvent(identities.host.participantId, markEvent);
      }
      await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
      expect(authorizationCount).toBe(256);
      expect(client.connected).toBe(true);
      await harness.server.publishParticipantEvent(identities.host.participantId, markEvent);
      await expect(error).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
      await disconnected;
    } finally {
      releaseSnapshot.resolve();
    }

    expect(observedPrivateEvents).toEqual([]);
    expect(authorizationCount).toBe(256);
  });

  test("keeps active-bucket overflow bounded and admits keys after expiry", () => {
    const limiter = new BoundedFixedWindowRateLimiter(2);

    expect(limiter.consume("first", 1, 0)).toBe(true);
    expect(limiter.consume("second", 1, 1)).toBe(true);
    expect(limiter.consume("overflow", 1, 2)).toBe(false);
    expect(limiter.consume("replacement", 1, 60_000)).toBe(true);
  });

  test("does not count a closed transport against authenticated capacity", () => {
    const capacity = new AuthenticatedConnectionCapacity(1, 1);

    expect(capacity.reserve("session_closed", () => false)).toEqual({ status: "closed" });
    const replacement = capacity.reserve("session_replacement", () => true);

    expect(replacement.status).toBe("reserved");
    if (replacement.status === "reserved") replacement.release();
  });

  test("hardens raw HTTP responses without reflecting request data", async () => {
    const harness = await createHarness();
    const privateMarker = "private-ticket-marker";

    const response = await fetch(`${harness.url}/missing?ticket=${privateMarker}`);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).not.toContain(privateMarker);
  });

  test("serves liveness and bounded PostgreSQL readiness with fixed safe responses", async () => {
    let ready = true;
    let readinessChecks = 0;
    let readinessFailure: Error | null = null;
    const harness = await createHarness({
      readinessCheck: async () => {
        readinessChecks += 1;
        if (readinessFailure !== null) throw readinessFailure;
        return ready;
      },
    });

    const health = await fetch(`${harness.url}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok", service: "game-server" });
    expect(readinessChecks).toBe(0);

    const available = await fetch(`${harness.url}/readyz`);
    expect(available.status).toBe(200);
    await expect(available.json()).resolves.toEqual({
      status: "ready",
      service: "game-server",
      dependencies: { postgresql: "up" },
    });

    ready = false;
    const unavailable = await fetch(`${harness.url}/readyz`);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      status: "not_ready",
      service: "game-server",
      dependencies: { postgresql: "down" },
    });
    const privateMarker = "postgresql://user:password@private.example/bingo";
    readinessFailure = new Error(privateMarker);
    const rejected = await fetch(`${harness.url}/readyz`);
    const rejectedBody = await rejected.text();
    expect(rejected.status).toBe(503);
    expect(JSON.parse(rejectedBody)).toEqual({
      status: "not_ready",
      service: "game-server",
      dependencies: { postgresql: "down" },
    });
    expect(rejectedBody).not.toContain(privateMarker);
    expect(readinessChecks).toBe(3);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.headers.get("x-content-type-options")).toBe("nosniff");

    const head = await fetch(`${harness.url}/readyz`, { method: "HEAD" });
    const method = await fetch(`${harness.url}/healthz`, { method: "POST" });
    const query = await fetch(`${harness.url}/healthz?detail=private`);
    expect(head.status).toBe(503);
    await expect(head.text()).resolves.toBe("");
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, HEAD");
    expect(query.status).toBe(404);
  });

  test("records allowlisted command, event, disconnect, and restoration correlations", async () => {
    const commandRecords: Parameters<OperationalLogger["command"]>[0][] = [];
    const eventRecords: Parameters<OperationalLogger["lobbyEvent"]>[0][] = [];
    const disconnectRecords: Parameters<OperationalLogger["disconnectPause"]>[0][] = [];
    const restorationRecords: Parameters<OperationalLogger["restartRestoration"]>[0][] = [];
    const scheduled = deferred();
    const logger: OperationalLogger = {
      withCommandCorrelation: (_commandId, operation) => operation(),
      command: (record) => commandRecords.push(record),
      lobbyEvent: (record) => eventRecords.push(record),
      transactionRetry: () => {},
      disconnectPause: (record) => {
        disconnectRecords.push(record);
        if (record.outcome === "scheduled") scheduled.resolve();
      },
      restartRestoration: (record) => restorationRecords.push(record),
    };
    const credential = ticket(79);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      operationalLogger: logger,
      initialPresenceGracePeriods: [
        {
          lobbyId: "lobby-restored",
          participantId: "participant-restored",
          presenceGeneration: 2,
          graceEndsAt: new Date("2026-07-17T20:01:00.000Z"),
        },
      ],
      findAutomaticCallLeases: async () => [
        { lobbyId: "lobby-auto", roundId: "round-auto", deadline: new Date(LATER) },
      ],
      findCoWinnerSettlementLeases: async () => [],
      execute: async (_identity, command) => ({
        ok: true,
        acknowledgement: CommandAckSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          commandId: command.commandId,
          occurredAt: NOW,
          idempotentReplay: false,
          scope: "active-lobby",
          eventSequence: stageEvent.eventSequence,
        }),
        activeLobbyEvent: stageEvent,
        participantPrivateEvents: [],
      }),
      unregisterPresence: async (identity, presenceGeneration) => ({
        lobbyId: identity.lobbyId,
        participantId: identity.participantId,
        presenceGeneration,
        graceEndsAt: new Date("2026-07-17T20:01:00.000Z"),
      }),
    });
    const client = await harness.connect(credential);
    const acknowledgement = once<unknown>(client, "v1:ack");
    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_observed",
    });
    await acknowledgement;
    client.disconnect();
    await waitForSignal(scheduled.promise, "disconnect pause diagnostic");

    expect(commandRecords).toEqual([
      {
        commandId: "command_observed",
        commandType: "start-round",
        outcome: "committed",
        idempotentReplay: false,
        eventSequence: stageEvent.eventSequence,
      },
    ]);
    expect(eventRecords).toEqual([
      {
        lobbyId: identities.host.lobbyId,
        eventType: stageEvent.type,
        eventSequence: stageEvent.eventSequence,
        source: "command",
      },
    ]);
    expect(disconnectRecords).toContainEqual({
      lobbyId: identities.host.lobbyId,
      participantId: identities.host.participantId,
      presenceGeneration: 1,
      outcome: "scheduled",
    });
    expect(restorationRecords).toEqual([
      { kind: "presence-grace", count: 1, outcome: "completed" },
      { kind: "automatic-call", count: 1, outcome: "completed" },
      { kind: "co-winner-settlement", count: 0, outcome: "completed" },
    ]);
  });

  test("keeps a committed command outcome when post-commit delivery fails", async () => {
    const commandRecords: Parameters<OperationalLogger["command"]>[0][] = [];
    const logger: OperationalLogger = {
      withCommandCorrelation: (_commandId, operation) => operation(),
      command: (record) => commandRecords.push(record),
      lobbyEvent: () => {},
      transactionRetry: () => {},
      disconnectPause: () => {},
      restartRestoration: () => {},
    };
    const credential = ticket(80);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      operationalLogger: logger,
      execute: async (_identity, command) => ({
        ok: true,
        acknowledgement: CommandAckSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          commandId: command.commandId,
          occurredAt: NOW,
          idempotentReplay: false,
          scope: "active-lobby",
          eventSequence: stageEvent.eventSequence,
        }),
        activeLobbyEvent: ActiveLobbyEventSchema.parse({ ...stageEvent, occurredAt: LATER }),
        participantPrivateEvents: [],
      }),
    });
    await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
    const client = await harness.connect(credential);
    const error = once<unknown>(client, "v1:error");

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_committed_delivery_failure",
    });

    await expect(error).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(commandRecords).toEqual([
      {
        commandId: "command_committed_delivery_failure",
        commandType: "start-round",
        outcome: "committed",
        idempotentReplay: false,
        eventSequence: stageEvent.eventSequence,
      },
    ]);
  });

  test("keeps a committed command outcome when committed result validation fails", async () => {
    const commandRecords: Parameters<OperationalLogger["command"]>[0][] = [];
    const logger: OperationalLogger = {
      withCommandCorrelation: (_commandId, operation) => operation(),
      command: (record) => commandRecords.push(record),
      lobbyEvent: () => {},
      transactionRetry: () => {},
      disconnectPause: () => {},
      restartRestoration: () => {},
    };
    const credential = ticket(81);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      operationalLogger: logger,
      execute: async (_identity, command) => ({
        ok: true,
        acknowledgement: {
          commandId: command.commandId,
          occurredAt: new Date(Number.NaN),
          idempotentReplay: false,
          scope: "active-lobby",
          eventSequence: stageEvent.eventSequence,
        },
        activeLobbyEvent: stageEvent,
        participantPrivateEvents: [],
      }),
    });
    const client = await harness.connect(credential);
    const error = once<unknown>(client, "v1:error");

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_committed_invalid_result",
    });

    await expect(error).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(commandRecords).toEqual([
      {
        commandId: "command_committed_invalid_result",
        commandType: "start-round",
        outcome: "committed",
      },
    ]);
  });

  test("records a delivered lobby event before scheduler reconciliation fails", async () => {
    const eventRecords: Parameters<OperationalLogger["lobbyEvent"]>[0][] = [];
    const logger: OperationalLogger = {
      withCommandCorrelation: (_commandId, operation) => operation(),
      command: () => {},
      lobbyEvent: (record) => eventRecords.push(record),
      transactionRetry: () => {},
      disconnectPause: () => {},
      restartRestoration: () => {},
    };
    const credential = ticket(82);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      operationalLogger: logger,
      findAutomaticCallLease: async () => Promise.reject(new Error("scheduler failed")),
      execute: async (_identity, command) => ({
        ok: true,
        acknowledgement: CommandAckSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          commandId: command.commandId,
          occurredAt: NOW,
          idempotentReplay: false,
          scope: "active-lobby",
          eventSequence: stageEvent.eventSequence,
        }),
        activeLobbyEvent: stageEvent,
        participantPrivateEvents: [],
      }),
    });
    const client = await harness.connect(credential);
    const event = once<unknown>(client, "v1:lobby-event");

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_event_before_reconciliation_failure",
    });

    await expect(event).resolves.toMatchObject({ eventSequence: stageEvent.eventSequence });
    await expect(harness.server.failure).rejects.toThrow("Game server authority failed.");
    expect(eventRecords).toEqual([
      {
        lobbyId: identities.host.lobbyId,
        eventType: stageEvent.type,
        eventSequence: stageEvent.eventSequence,
        source: "command",
      },
    ]);
  });

  test.each([
    ["automatic-call", "automatic"],
    ["co-winner-settlement", "co-winner"],
  ] as const)(
    "records a failed %s restart restoration without error details",
    async (kind, source) => {
      const restorationRecords: Parameters<OperationalLogger["restartRestoration"]>[0][] = [];
      const logger: OperationalLogger = {
        withCommandCorrelation: (_commandId, operation) => operation(),
        command: () => {},
        lobbyEvent: () => {},
        transactionRetry: () => {},
        disconnectPause: () => {},
        restartRestoration: (record) => restorationRecords.push(record),
      };
      const privateMarker = `private-${source}-restoration-detail`;

      await expect(
        createHarness({
          operationalLogger: logger,
          findAutomaticCallLeases: async () => {
            if (source === "automatic") throw new Error(privateMarker);
            return [];
          },
          findCoWinnerSettlementLeases: async () => {
            if (source === "co-winner") throw new Error(privateMarker);
            return [];
          },
        }),
      ).rejects.toThrow(privateMarker);
      expect(restorationRecords).toContainEqual({ kind, count: 0, outcome: "failed" });
      expect(JSON.stringify(restorationRecords)).not.toContain(privateMarker);
    },
  );

  test("consumes a strict handshake ticket and stores only persisted identity", async () => {
    const credential = ticket(1);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
    });

    const client = await harness.connect(credential);

    expect(client.connected).toBe(true);
    expect(harness.consumedHashes).toEqual([ticketHash(credential)]);
  });

  test("rejects malformed, replayed, and identity-bearing authentication safely", async () => {
    const credential = ticket(2);
    const spoofedCredential = ticket(13);
    const harness = await createHarness({
      tickets: new Map<string, AuthenticatedRealtimeIdentity>([
        [ticketHash(credential), identities.host],
        [ticketHash(spoofedCredential), identities.player],
      ]),
    });

    await harness.connect(credential);
    const replay = await harness.reject(credential);
    const malformed = await harness.reject("malformed");
    const spoofed = await harness.reject(spoofedCredential, {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      ticket: spoofedCredential,
      participantId: "participant_attacker",
    });

    for (const error of [replay, malformed, spoofed]) {
      expect(error.message).toBe("Authentication is required.");
      expect(ErrorSchema.parse(error.data)).toMatchObject({
        code: "UNAUTHORIZED",
        commandId: null,
      });
      expect(JSON.stringify(error)).not.toContain(credential);
      expect(JSON.stringify(error)).not.toContain(spoofedCredential);
    }
    expect(harness.consumedHashes).toEqual([
      ticketHash(credential),
      ticketHash(credential),
      ticketHash(spoofedCredential),
    ]);
    await expect(harness.reject(spoofedCredential)).resolves.toMatchObject({
      message: "Authentication is required.",
    });
  });

  test("rejects a disallowed origin before consuming the ticket", async () => {
    const credential = ticket(3);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
    });

    const error = await harness.reject(credential, undefined, "https://attacker.example");

    expect(error.message).toBe("websocket error");
    expect(harness.consumedHashes).toEqual([]);
  });

  test("bounds repeated namespace authentication on one admitted transport", async () => {
    const credential = ticket(19);
    const rateLimitedCredential = ticket(42);
    const laterCredential = ticket(48);
    const firstConsumptionStarted = deferred();
    const releaseConsumption = deferred();
    const rateLimitedConsumptionStarted = deferred();
    const releaseRateLimitedConsumption = deferred();
    let rateLimitedTicketAvailable = true;
    let now = new Date(NOW);
    const harness = await createHarness({
      clock: () => now,
      limits: { connectionsPerMinute: 1 },
      consumeTicket: async (hash) => {
        if (hash === ticketHash(credential)) {
          firstConsumptionStarted.resolve();
          await releaseConsumption.promise;
          return null;
        }
        if (hash === ticketHash(rateLimitedCredential)) {
          rateLimitedTicketAvailable = false;
          rateLimitedConsumptionStarted.resolve();
          await releaseRateLimitedConsumption.promise;
          return null;
        }
        return hash === ticketHash(laterCredential) ? identities.player : null;
      },
    });
    const manager = new Manager(harness.url, {
      autoConnect: false,
      extraHeaders: { Origin: ORIGIN },
      reconnection: false,
      transports: ["websocket"],
    });
    managers.push(manager);
    const packets: Array<{ data?: unknown; type: number }> = [];
    manager.on("packet", (packet) => packets.push(packet));
    const closed = new Promise<void>((resolve) => {
      manager.once("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      manager.open((error) => (error === undefined ? resolve() : reject(error)));
    });
    const auth = { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket: credential };

    manager._packet({ type: 0, nsp: "/", data: auth });
    try {
      await waitForSignal(firstConsumptionStarted.promise, "ticket consumption to start");
      manager._packet({
        type: 0,
        nsp: "/",
        data: { ...auth, ticket: rateLimitedCredential },
      });
      await waitForSignal(
        rateLimitedConsumptionStarted.promise,
        "the rate-limited ticket burn to start",
      );
      now = new Date(new Date(NOW).getTime() + 60_000);
      manager._packet({
        type: 0,
        nsp: "/",
        data: { ...auth, ticket: laterCredential },
      });
      await waitForSignal(closed, "the rate-limited transport to close");
    } finally {
      releaseConsumption.resolve();
      releaseRateLimitedConsumption.resolve();
    }

    expect(harness.consumedHashes).toEqual([
      ticketHash(credential),
      ticketHash(rateLimitedCredential),
    ]);
    expect(rateLimitedTicketAvailable).toBe(false);
    expect(packets).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          data: expect.objectContaining({ code: "RATE_LIMITED" }),
        }),
        type: 4,
      }),
    );
  });

  test("does not authenticate in-flight middleware after its transport becomes terminal", async () => {
    const credential = ticket(49);
    const rateLimitedCredential = ticket(50);
    const firstConsumptionStarted = deferred();
    const releaseFirstConsumption = deferred();
    const rateLimitedConsumptionStarted = deferred();
    const releaseRateLimitedConsumption = deferred();
    const harness = await createHarness({
      limits: { connectionsPerMinute: 1 },
      consumeTicket: async (hash) => {
        if (hash === ticketHash(credential)) {
          firstConsumptionStarted.resolve();
          await releaseFirstConsumption.promise;
          return identities.host;
        }
        if (hash === ticketHash(rateLimitedCredential)) {
          rateLimitedConsumptionStarted.resolve();
          await releaseRateLimitedConsumption.promise;
        }
        return null;
      },
    });
    const manager = new Manager(harness.url, {
      autoConnect: false,
      extraHeaders: { Origin: ORIGIN },
      reconnection: false,
      transports: ["websocket"],
    });
    managers.push(manager);
    const packets: Array<{ data?: unknown; type: number }> = [];
    manager.on("packet", (packet) => packets.push(packet));
    const closed = new Promise<void>((resolve) => {
      manager.once("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      manager.open((error) => (error === undefined ? resolve() : reject(error)));
    });
    const auth = { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket: credential };

    manager._packet({ type: 0, nsp: "/", data: auth });
    try {
      await waitForSignal(firstConsumptionStarted.promise, "ticket consumption to start");
      manager._packet({
        type: 0,
        nsp: "/",
        data: { ...auth, ticket: rateLimitedCredential },
      });
      await waitForSignal(
        rateLimitedConsumptionStarted.promise,
        "the rate-limited ticket burn to start",
      );
      releaseFirstConsumption.resolve();
      await waitForSignal(closed, "the terminal transport to close");
    } finally {
      releaseFirstConsumption.resolve();
      releaseRateLimitedConsumption.resolve();
    }

    expect(harness.consumedHashes).toEqual([
      ticketHash(credential),
      ticketHash(rateLimitedCredential),
    ]);
    expect(packets).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          data: expect.objectContaining({ code: "RATE_LIMITED" }),
        }),
        type: 4,
      }),
    );
    expect(packets).not.toContainEqual(expect.objectContaining({ type: 0 }));
  });

  test("does not authenticate concurrent middleware after any authentication rejection", async () => {
    const rejectedCredential = ticket(51);
    const validCredential = ticket(52);
    const rejectedConsumptionStarted = deferred();
    const releaseRejectedConsumption = deferred();
    const validConsumptionStarted = deferred();
    const releaseValidConsumption = deferred();
    const harness = await createHarness({
      consumeTicket: async (hash) => {
        if (hash === ticketHash(rejectedCredential)) {
          rejectedConsumptionStarted.resolve();
          await releaseRejectedConsumption.promise;
          return null;
        }
        if (hash === ticketHash(validCredential)) {
          validConsumptionStarted.resolve();
          await releaseValidConsumption.promise;
          return identities.host;
        }
        return null;
      },
    });
    const manager = new Manager(harness.url, {
      autoConnect: false,
      extraHeaders: { Origin: ORIGIN },
      reconnection: false,
      transports: ["websocket"],
    });
    managers.push(manager);
    const packets: Array<{ data?: unknown; type: number }> = [];
    manager.on("packet", (packet) => packets.push(packet));
    const closed = new Promise<void>((resolve) => {
      manager.once("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      manager.open((error) => (error === undefined ? resolve() : reject(error)));
    });

    manager._packet({
      type: 0,
      nsp: "/",
      data: { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket: rejectedCredential },
    });
    try {
      await waitForSignal(rejectedConsumptionStarted.promise, "rejected ticket consumption");
      manager._packet({
        type: 0,
        nsp: "/",
        data: { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket: validCredential },
      });
      await waitForSignal(validConsumptionStarted.promise, "valid ticket consumption");
      releaseRejectedConsumption.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseValidConsumption.resolve();
      await waitForSignal(closed, "rejected authentication transport to close");
    } finally {
      releaseRejectedConsumption.resolve();
      releaseValidConsumption.resolve();
    }

    expect(packets).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          data: expect.objectContaining({ code: "UNAUTHORIZED" }),
        }),
        type: 4,
      }),
    );
    expect(packets).not.toContainEqual(expect.objectContaining({ type: 0 }));
  });

  test("makes a malformed canonical-ticket envelope terminal before burning its ticket", async () => {
    const malformedCredential = ticket(53);
    const validCredential = ticket(54);
    const malformedConsumptionStarted = deferred();
    const releaseMalformedConsumption = deferred();
    const validConsumptionStarted = deferred();
    const harness = await createHarness({
      consumeTicket: async (hash) => {
        if (hash === ticketHash(malformedCredential)) {
          malformedConsumptionStarted.resolve();
          await releaseMalformedConsumption.promise;
          return null;
        }
        if (hash === ticketHash(validCredential)) {
          validConsumptionStarted.resolve();
          return identities.host;
        }
        return null;
      },
    });
    const manager = new Manager(harness.url, {
      autoConnect: false,
      extraHeaders: { Origin: ORIGIN },
      reconnection: false,
      transports: ["websocket"],
    });
    managers.push(manager);
    const packets: Array<{ data?: unknown; type: number }> = [];
    manager.on("packet", (packet) => packets.push(packet));
    const closed = new Promise<void>((resolve) => {
      manager.once("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      manager.open((error) => (error === undefined ? resolve() : reject(error)));
    });

    manager._packet({
      type: 0,
      nsp: "/",
      data: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        ticket: malformedCredential,
        participantId: "participant_attacker",
      },
    });
    try {
      await waitForSignal(malformedConsumptionStarted.promise, "malformed ticket consumption");
      manager._packet({
        type: 0,
        nsp: "/",
        data: { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket: validCredential },
      });
      await waitForSignal(closed, "malformed authentication transport to close");
    } finally {
      releaseMalformedConsumption.resolve();
    }

    expect(harness.consumedHashes).toEqual([ticketHash(malformedCredential)]);
    await expect(
      Promise.race([
        validConsumptionStarted.promise.then(() => "consumed" as const),
        new Promise<"not-consumed">((resolve) => setImmediate(() => resolve("not-consumed"))),
      ]),
    ).resolves.toBe("not-consumed");
    expect(packets).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          data: expect.objectContaining({ code: "UNAUTHORIZED" }),
        }),
        type: 4,
      }),
    );
    expect(packets).not.toContainEqual(expect.objectContaining({ type: 0 }));
  });

  test("caps concurrent sockets globally and per participant session", async () => {
    const perSessionCredentials = [ticket(22), ticket(23), ticket(24)];
    const perSessionHarness = await createHarness({
      tickets: new Map(
        perSessionCredentials.map((credential) => [ticketHash(credential), identities.host]),
      ),
      limits: { connectionsPerSession: 1, maximumConnections: 2 },
    });
    const first = await perSessionHarness.connect(perSessionCredentials[0]!);
    await expect(perSessionHarness.reject(perSessionCredentials[1]!)).resolves.toMatchObject({
      data: expect.objectContaining({ code: "RATE_LIMITED" }),
    });
    first.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(perSessionHarness.connect(perSessionCredentials[2]!)).resolves.toBeDefined();

    const globalCredentials = [ticket(25), ticket(26)];
    const globalHarness = await createHarness({
      tickets: new Map<string, AuthenticatedRealtimeIdentity>([
        [ticketHash(globalCredentials[0]!), identities.host],
        [ticketHash(globalCredentials[1]!), identities.player],
      ]),
      limits: { connectionsPerSession: 2, maximumConnections: 1 },
    });
    await globalHarness.connect(globalCredentials[0]!);
    await expect(globalHarness.reject(globalCredentials[1]!)).resolves.toMatchObject({
      data: expect.objectContaining({ code: "RATE_LIMITED" }),
    });
  });

  test("does not reserve capacity after a transport closes during ticket consumption", async () => {
    const abandonedCredential = ticket(29);
    const replacementCredential = ticket(30);
    const consumptionStarted = deferred();
    const releaseConsumption = deferred();
    const harness = await createHarness({
      limits: { maximumConnections: 1 },
      consumeTicket: async (hash) => {
        if (hash === ticketHash(abandonedCredential)) {
          consumptionStarted.resolve();
          await releaseConsumption.promise;
          return identities.host;
        }
        return hash === ticketHash(replacementCredential) ? identities.player : null;
      },
    });
    const abandoned = createClient(harness.url, {
      autoConnect: false,
      transports: ["websocket"],
      extraHeaders: { Origin: ORIGIN },
      auth: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        ticket: abandonedCredential,
      },
      reconnection: false,
    });
    clients.push(abandoned);
    const transportClosed = new Promise<void>((resolve) => {
      abandoned.io.once("close", () => resolve());
    });

    abandoned.connect();
    try {
      await waitForSignal(consumptionStarted.promise, "ticket consumption to start");
      abandoned.io.engine?.close();
      await waitForSignal(transportClosed, "the abandoned transport to close");
    } finally {
      releaseConsumption.resolve();
    }

    const replacement = await harness.connect(replacementCredential);
    expect(replacement.connected).toBe(true);
    expect(harness.consumedHashes).toEqual([
      ticketHash(abandonedCredential),
      ticketHash(replacementCredential),
    ]);
  });

  test("routes every versioned mutation using only the authenticated identity", async () => {
    const credential = ticket(4);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
    });
    const client = await harness.connect(credential);
    const commands = [
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "configure",
        commandId: "command_configure",
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      },
      ...[
        "create-round",
        "start-round",
        "pause-round",
        "resume-round",
        "call-next",
        "end-round",
      ].map((type, index) => ({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type,
        commandId: `command_control_${index}`,
      })),
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "continue-round",
        commandId: "command_continue",
        patternId: "standard-two-lines",
      },
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "mark-card",
        commandId: "command_mark_card",
        ball: 1,
      },
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "override-absence",
        commandId: "command_override",
        participantId: "participant_player",
        presenceGeneration: 1,
      },
    ].map((command) => MutationCommandSchema.parse(command));

    for (const command of commands) {
      const acknowledged = once(client, "v1:ack");
      client.emit("v1:command", command);
      await acknowledged;
    }

    expect(harness.executed).toEqual(
      commands.map((command) => ({ identity: identities.host, command })),
    );
  });

  test("rejects malformed, chat, and event-history commands before execution", async () => {
    const credential = ticket(5);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
    });
    const client = await harness.connect(credential);

    for (const command of [
      { schemaVersion: 2, type: "heartbeat" },
      { schemaVersion: CONTRACT_SCHEMA_VERSION, type: "chat", message: "secret" },
      { schemaVersion: CONTRACT_SCHEMA_VERSION, type: "event-history" },
    ]) {
      const error = once<unknown>(client, "v1:error");
      client.emit("v1:command", command);
      expect(ErrorSchema.parse(await error)).toMatchObject({
        code: "INVALID_PAYLOAD",
        commandId: null,
      });
    }
    expect(harness.executed).toEqual([]);
  });

  test("accepts packets below the transport payload cap and disconnects oversized packets", async () => {
    const credentials = [ticket(42), ticket(43)];
    const heartbeatRecorded = deferred<AuthenticatedRealtimeIdentity>();
    const harness = await createHarness({
      tickets: new Map(credentials.map((credential) => [ticketHash(credential), identities.host])),
      recordHeartbeat: async (identity) => {
        heartbeatRecorded.resolve(identity);
        return true;
      },
    });
    const payloadCap = 16 * 1024;
    const validPayload = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "heartbeat",
    };
    const encodedSize = (payload: unknown) =>
      Buffer.byteLength(`42${JSON.stringify(["v1:command", payload])}`);
    const boundaryPayload = (encodedBytes: number) => {
      const payload = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "chat",
        padding: "",
      };
      return {
        ...payload,
        padding: "a".repeat(encodedBytes - encodedSize(payload)),
      };
    };
    const acceptedBoundaryPayload = boundaryPayload(payloadCap - 1);
    const oversizedPayload = boundaryPayload(payloadCap + 1);

    expect(encodedSize(validPayload)).toBeLessThan(payloadCap);
    expect(encodedSize(acceptedBoundaryPayload)).toBe(payloadCap - 1);
    expect(encodedSize(oversizedPayload)).toBe(payloadCap + 1);

    const acceptedClient = await harness.connect(credentials[0]!);
    acceptedClient.emit("v1:command", validPayload);
    await expect(
      waitForSignal(heartbeatRecorded.promise, "the valid below-cap heartbeat"),
    ).resolves.toEqual(identities.host);

    const validationError = once<unknown>(acceptedClient, "v1:error");
    acceptedClient.emit("v1:command", acceptedBoundaryPayload);
    expect(ErrorSchema.parse(await validationError)).toMatchObject({
      code: "INVALID_PAYLOAD",
      commandId: null,
    });
    expect(acceptedClient.connected).toBe(true);

    const oversizedClient = await harness.connect(credentials[1]!);
    const disconnected = once<void>(oversizedClient, "disconnect");
    oversizedClient.emit("v1:command", oversizedPayload);
    await disconnected;

    expect(harness.executed).toEqual([]);
  });

  test("broadcasts only a fresh committed lobby event before acknowledging the caller", async () => {
    const credentials = [ticket(6), ticket(7), ticket(8)];
    let attempts = 0;
    const harness = await createHarness({
      tickets: new Map<string, AuthenticatedRealtimeIdentity>([
        [ticketHash(credentials[0]!), identities.host],
        [ticketHash(credentials[1]!), identities.hostTab],
        [ticketHash(credentials[2]!), identities.otherLobby],
      ]),
      execute: async (_identity, command) => {
        attempts += 1;
        return {
          ok: true,
          acknowledgement: CommandAckSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "ack",
            commandId: command.commandId,
            occurredAt: NOW,
            idempotentReplay: attempts > 1,
            scope: "active-lobby",
            eventSequence: 1,
          }),
          activeLobbyEvent: attempts === 1 ? stageEvent : null,
          participantPrivateEvents: [],
        };
      },
    });
    const caller = await harness.connect(credentials[0]!);
    const sameLobby = await harness.connect(credentials[1]!);
    const otherLobby = await harness.connect(credentials[2]!);
    const deliveryOrder: string[] = [];
    caller.on("v1:lobby-event", () => deliveryOrder.push("event"));
    caller.on("v1:ack", () => deliveryOrder.push("ack"));
    const callerEvent = once<unknown>(caller, "v1:lobby-event");
    const peerEvent = once<unknown>(sameLobby, "v1:lobby-event");
    const acknowledgement = once<unknown>(caller, "v1:ack");
    const noCrossLobbyEvent = expectNoEvent(otherLobby, "v1:lobby-event");

    caller.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_start",
    });

    await expect(callerEvent).resolves.toEqual(stageEvent);
    await expect(peerEvent).resolves.toEqual(stageEvent);
    await expect(acknowledgement).resolves.toMatchObject({ commandId: "command_start" });
    await noCrossLobbyEvent;
    expect(deliveryOrder).toEqual(["event", "ack"]);

    const replayAcknowledgement = once<unknown>(caller, "v1:ack");
    const noReplayBroadcast = expectNoEvent(sameLobby, "v1:lobby-event");
    caller.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_start",
    });
    await expect(replayAcknowledgement).resolves.toMatchObject({ idempotentReplay: true });
    await noReplayBroadcast;
  });

  test("acknowledges a fresh command when its notification echo publishes first", async () => {
    const credential = ticket(43);
    const notificationPublisher = deferred<() => Promise<void>>();
    const eventRecords: Parameters<OperationalLogger["lobbyEvent"]>[0][] = [];
    const logger: OperationalLogger = {
      withCommandCorrelation: (_commandId, operation) => operation(),
      command: () => {},
      lobbyEvent: (record) => eventRecords.push(record),
      transactionRetry: () => {},
      disconnectPause: () => {},
      restartRestoration: () => {},
    };
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      operationalLogger: logger,
      execute: async (_identity, command) => {
        const publishNotificationEcho = await notificationPublisher.promise;
        await publishNotificationEcho();
        return {
          ok: true,
          acknowledgement: CommandAckSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "ack",
            commandId: command.commandId,
            occurredAt: NOW,
            idempotentReplay: false,
            scope: "active-lobby",
            eventSequence: stageEvent.eventSequence,
          }),
          activeLobbyEvent: stageEvent,
          participantPrivateEvents: [],
        };
      },
    });
    notificationPublisher.resolve(() =>
      harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent),
    );
    const client = await harness.connect(credential);
    const lobbyEvent = once<unknown>(client, "v1:lobby-event");
    const acknowledgement = once<unknown>(client, "v1:ack");
    const errors: unknown[] = [];
    let eventCount = 0;
    client.on("v1:lobby-event", () => {
      eventCount += 1;
    });
    client.on("v1:error", (error) => errors.push(error));

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_notification_echo",
    });

    await expect(lobbyEvent).resolves.toEqual(stageEvent);
    await expect(acknowledgement).resolves.toMatchObject({
      commandId: "command_notification_echo",
    });
    expect(eventCount).toBe(1);
    expect(errors).toEqual([]);
    expect(eventRecords).toEqual([
      {
        lobbyId: identities.host.lobbyId,
        eventType: stageEvent.type,
        eventSequence: stageEvent.eventSequence,
        source: "authority",
      },
    ]);
  });

  test("rejects a fresh acknowledgement that has no committed event", async () => {
    const credential = ticket(31);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      execute: async (_identity, command) => ({
        ok: true,
        acknowledgement: CommandAckSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          commandId: command.commandId,
          occurredAt: NOW,
          idempotentReplay: false,
          scope: "active-lobby",
          eventSequence: 1,
        }),
        activeLobbyEvent: null,
        participantPrivateEvents: [],
      }),
    });
    const client = await harness.connect(credential);
    const error = once<unknown>(client, "v1:error");
    const acknowledgements: unknown[] = [];
    client.on("v1:ack", (acknowledgement) => acknowledgements.push(acknowledgement));

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_missing_event",
    });

    await expect(error).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(acknowledgements).toEqual([]);
  });

  test("rejects a private event for a different command before delivery", async () => {
    const credential = ticket(32);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      execute: async (_identity, command) => ({
        ok: true,
        acknowledgement: CommandAckSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          commandId: command.commandId,
          occurredAt: NOW,
          idempotentReplay: false,
          scope: "participant-private",
          eventSequence: null,
        }),
        activeLobbyEvent: null,
        participantPrivateEvents: [markEvent],
      }),
    });
    const client = await harness.connect(credential);
    const error = once<unknown>(client, "v1:error");
    const privateEvents: unknown[] = [];
    const acknowledgements: unknown[] = [];
    client.on("v1:private-event", (event) => privateEvents.push(event));
    client.on("v1:ack", (acknowledgement) => acknowledgements.push(acknowledgement));

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: "command_mismatched_event",
      ball: 1,
    });

    await expect(error).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(privateEvents).toEqual([]);
    expect(acknowledgements).toEqual([]);
  });

  test.each([
    { name: "reversed", events: [nearWinEvent, markEvent] },
    { name: "duplicate mark", events: [markEvent, markEvent] },
    { name: "lone near-win", events: [nearWinEvent] },
  ])("rejects a $name private batch before delivery", async ({ events }) => {
    const credential = ticket(52 + events.length);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      execute: async () => ({
        ok: true,
        acknowledgement: CommandAckSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          commandId: markEvent.commandId,
          occurredAt: NOW,
          idempotentReplay: false,
          scope: "participant-private",
          eventSequence: null,
        }),
        activeLobbyEvent: null,
        participantPrivateEvents: events,
      }),
    });
    const client = await harness.connect(credential);
    const error = once<unknown>(client, "v1:error");
    const noPrivateEvent = expectNoEvent(client, "v1:private-event");
    const acknowledgements: unknown[] = [];
    client.on("v1:ack", (acknowledgement) => acknowledgements.push(acknowledgement));

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: markEvent.commandId,
      ball: 1,
    });

    await noPrivateEvent;
    await expect(error).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(acknowledgements).toEqual([]);
  });

  test.each([
    {
      name: "fresh lobby result",
      fill: 37,
      acknowledgement: CommandAckSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "ack",
        commandId: "command_wrong",
        occurredAt: NOW,
        idempotentReplay: false,
        scope: "active-lobby",
        eventSequence: 1,
      }),
      activeLobbyEvent: stageEvent,
      participantPrivateEvents: [],
    },
    {
      name: "lobby replay",
      fill: 38,
      acknowledgement: CommandAckSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "ack",
        commandId: "command_wrong",
        occurredAt: NOW,
        idempotentReplay: true,
        scope: "active-lobby",
        eventSequence: 1,
      }),
      activeLobbyEvent: null,
      participantPrivateEvents: [],
    },
    {
      name: "fresh private result",
      fill: 39,
      acknowledgement: CommandAckSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "ack",
        commandId: markEvent.commandId,
        occurredAt: NOW,
        idempotentReplay: false,
        scope: "participant-private",
        eventSequence: null,
      }),
      activeLobbyEvent: null,
      participantPrivateEvents: [markEvent],
    },
    {
      name: "private replay",
      fill: 40,
      acknowledgement: CommandAckSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "ack",
        commandId: markEvent.commandId,
        occurredAt: NOW,
        idempotentReplay: true,
        scope: "participant-private",
        eventSequence: null,
      }),
      activeLobbyEvent: null,
      participantPrivateEvents: [markEvent],
    },
  ])("rejects a $name acknowledgement for a different incoming command", async (scenario) => {
    const credential = ticket(scenario.fill);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      execute: async () => ({
        ok: true,
        acknowledgement: scenario.acknowledgement,
        activeLobbyEvent: scenario.activeLobbyEvent,
        participantPrivateEvents: scenario.participantPrivateEvents,
      }),
    });
    const client = await harness.connect(credential);
    const error = once<unknown>(client, "v1:error");
    const lobbyEvents: unknown[] = [];
    const privateEvents: unknown[] = [];
    const acknowledgements: unknown[] = [];
    client.on("v1:lobby-event", (event) => lobbyEvents.push(event));
    client.on("v1:private-event", (event) => privateEvents.push(event));
    client.on("v1:ack", (acknowledgement) => acknowledgements.push(acknowledgement));

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: "command_expected",
      ball: 1,
    });

    await expect(error).resolves.toMatchObject({
      code: "INTERNAL_ERROR",
      commandId: "command_expected",
    });
    expect(lobbyEvents).toEqual([]);
    expect(privateEvents).toEqual([]);
    expect(acknowledgements).toEqual([]);
  });

  test("acknowledges a legacy eventless participant-private replay", async () => {
    const credential = ticket(41);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      execute: async (_identity, command) => ({
        ok: true,
        acknowledgement: CommandAckSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          commandId: command.commandId,
          occurredAt: NOW,
          idempotentReplay: true,
          scope: "participant-private",
          eventSequence: null,
        }),
        activeLobbyEvent: null,
        participantPrivateEvents: [],
      }),
    });
    const client = await harness.connect(credential);
    const acknowledgement = once<unknown>(client, "v1:ack");
    const noPrivateEvent = expectNoEvent(client, "v1:private-event");

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: "command_legacy_private",
      ball: 1,
    });

    await expect(acknowledgement).resolves.toMatchObject({
      commandId: "command_legacy_private",
      idempotentReplay: true,
      scope: "participant-private",
    });
    await noPrivateEvent;
  });

  test("serializes concurrent lobby delivery by committed sequence", async () => {
    const credential = ticket(20);
    const firstAuthorizationStarted = deferred();
    const releaseFirstAuthorization = deferred();
    let authorizationCount = 0;
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      authorize: async () => {
        authorizationCount += 1;
        if (authorizationCount === 1) {
          firstAuthorizationStarted.resolve();
          await releaseFirstAuthorization.promise;
        }
        return true;
      },
    });
    const client = await harness.connect(credential);
    const receivedSequences = collectLobbySequences(client, 2);
    const secondEvent = ActiveLobbyEventSchema.parse({
      ...stageEvent,
      eventSequence: 2,
      occurredAt: LATER,
    });

    const firstDelivery = harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
    try {
      await waitForSignal(firstAuthorizationStarted.promise, "lobby authorization to start");
      const secondDelivery = harness.server.publishLobbyEvent(identities.host.lobbyId, secondEvent);
      releaseFirstAuthorization.resolve();
      await Promise.all([firstDelivery, secondDelivery]);
    } finally {
      releaseFirstAuthorization.resolve();
    }

    await expect(receivedSequences).resolves.toEqual([1, 2]);
  });

  test("orders concurrently published lobby events by committed sequence", async () => {
    const credential = ticket(33);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
    });
    const client = await harness.connect(credential);
    const receivedSequences = collectLobbySequences(client, 2);
    const secondEvent = ActiveLobbyEventSchema.parse({
      ...stageEvent,
      eventSequence: 2,
      occurredAt: LATER,
    });

    await Promise.all([
      harness.server.publishLobbyEvent(identities.host.lobbyId, secondEvent),
      harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent),
    ]);

    await expect(receivedSequences).resolves.toEqual([1, 2]);
  });

  test("reserves a relayed sequence before its durable event finishes loading", async () => {
    const credential = ticket(53);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
    });
    const client = await harness.connect(credential);
    const receivedSequences = collectLobbySequences(client, 2);
    const loadStarted = deferred();
    const releaseLoad = deferred();
    const secondEvent = ActiveLobbyEventSchema.parse({
      ...stageEvent,
      eventSequence: 2,
      occurredAt: LATER,
    });
    const firstDelivery = harness.server.publishLobbyEventFromSource(
      identities.host.lobbyId,
      stageEvent.eventSequence,
      async () => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return stageEvent;
      },
    );
    try {
      await waitForSignal(loadStarted.promise, "relayed event load to start");
      const secondDelivery = harness.server.publishLobbyEvent(identities.host.lobbyId, secondEvent);
      releaseLoad.resolve();
      await Promise.all([firstDelivery, secondDelivery]);
    } finally {
      releaseLoad.resolve();
    }

    await expect(receivedSequences).resolves.toEqual([1, 2]);
  });

  test("rejects a late lower sequence instead of emitting an inversion", async () => {
    const credential = ticket(35);
    const authorizationStarted = deferred();
    const releaseAuthorization = deferred();
    let authorizationCount = 0;
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      authorize: async () => {
        authorizationCount += 1;
        if (authorizationCount === 1) {
          authorizationStarted.resolve();
          await releaseAuthorization.promise;
        }
        return true;
      },
    });
    const client = await harness.connect(credential);
    const receivedEvent = once<{ eventSequence: number }>(client, "v1:lobby-event");
    const secondEvent = ActiveLobbyEventSchema.parse({
      ...stageEvent,
      eventSequence: 2,
      occurredAt: LATER,
    });

    const secondDelivery = harness.server.publishLobbyEvent(identities.host.lobbyId, secondEvent);
    try {
      await waitForSignal(authorizationStarted.promise, "higher-sequence authorization to start");
      const staleDelivery = harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
      releaseAuthorization.resolve();

      await secondDelivery;
      await expect(staleDelivery).rejects.toThrow("Lobby event sequence is stale.");
    } finally {
      releaseAuthorization.resolve();
    }
    await expect(receivedEvent).resolves.toMatchObject({ eventSequence: 2 });
  });

  test("remembers the last delivered sequence after a lobby queue drains", async () => {
    const credential = ticket(36);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
    });
    await harness.connect(credential);
    const secondEvent = ActiveLobbyEventSchema.parse({
      ...stageEvent,
      eventSequence: 2,
      occurredAt: LATER,
    });

    await harness.server.publishLobbyEvent(identities.host.lobbyId, secondEvent);

    await expect(
      harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent),
    ).rejects.toThrow("Lobby event sequence is stale.");
  });

  test("rejects conflicting content for a delivered lobby sequence", async () => {
    const credential = ticket(44);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
    });
    await harness.connect(credential);
    const conflictingEvent = ActiveLobbyEventSchema.parse({
      ...stageEvent,
      occurredAt: LATER,
    });

    await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);

    await expect(
      harness.server.publishLobbyEvent(identities.host.lobbyId, conflictingEvent),
    ).rejects.toThrow("Lobby event sequence conflicts.");
  });

  test("accepts an exact delayed echo after a newer lobby sequence", async () => {
    const credential = ticket(45);
    const eventRecords: Parameters<OperationalLogger["lobbyEvent"]>[0][] = [];
    const logger: OperationalLogger = {
      withCommandCorrelation: (_commandId, operation) => operation(),
      command: () => {},
      lobbyEvent: (record) => eventRecords.push(record),
      transactionRetry: () => {},
      disconnectPause: () => {},
      restartRestoration: () => {},
    };
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      operationalLogger: logger,
    });
    const client = await harness.connect(credential);
    const receivedSequences = collectLobbySequences(client, 2);
    const secondEvent = ActiveLobbyEventSchema.parse({
      ...stageEvent,
      eventSequence: 2,
      occurredAt: LATER,
    });

    await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
    await harness.server.publishLobbyEvent(identities.host.lobbyId, secondEvent);

    await expect(
      harness.server.publishLobbyEventFromSource(
        identities.host.lobbyId,
        stageEvent.eventSequence,
        async () => stageEvent,
      ),
    ).resolves.toBeUndefined();
    await expect(receivedSequences).resolves.toEqual([1, 2]);
    expect(eventRecords).toEqual([
      {
        lobbyId: identities.host.lobbyId,
        eventType: stageEvent.type,
        eventSequence: stageEvent.eventSequence,
        source: "authority",
      },
      {
        lobbyId: identities.host.lobbyId,
        eventType: secondEvent.type,
        eventSequence: secondEvent.eventSequence,
        source: "authority",
      },
    ]);
  });

  test("keeps participant-private results out of lobby and other participant streams", async () => {
    const credentials = [ticket(9), ticket(10), ticket(11)];
    let attempts = 0;
    const harness = await createHarness({
      tickets: new Map<string, AuthenticatedRealtimeIdentity>([
        [ticketHash(credentials[0]!), identities.host],
        [ticketHash(credentials[1]!), identities.hostTab],
        [ticketHash(credentials[2]!), identities.player],
      ]),
      execute: async () => {
        attempts += 1;
        return {
          ok: true,
          acknowledgement: CommandAckSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "ack",
            commandId: markEvent.commandId,
            occurredAt: NOW,
            idempotentReplay: attempts > 1,
            scope: "participant-private",
            eventSequence: null,
          }),
          activeLobbyEvent: null,
          participantPrivateEvents: [markEvent, nearWinEvent],
        };
      },
    });
    const caller = await harness.connect(credentials[0]!);
    const sameParticipant = await harness.connect(credentials[1]!);
    const otherParticipant = await harness.connect(credentials[2]!);
    const collectPrivateEvents = (client: Socket) =>
      new Promise<unknown[]>((resolve) => {
        const events: unknown[] = [];
        client.on("v1:private-event", (event: unknown) => {
          events.push(event);
          if (events.length === 2) resolve(events);
        });
      });
    const callerEvents = collectPrivateEvents(caller);
    const sameParticipantEvents = collectPrivateEvents(sameParticipant);
    const noOtherParticipantEvent = expectNoEvent(otherParticipant, "v1:private-event");
    const noLobbyEvent = expectNoEvent(otherParticipant, "v1:lobby-event");

    caller.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: markEvent.commandId,
      ball: 1,
    });

    await expect(callerEvents).resolves.toEqual([markEvent, nearWinEvent]);
    await expect(sameParticipantEvents).resolves.toEqual([markEvent, nearWinEvent]);
    await Promise.all([noOtherParticipantEvent, noLobbyEvent]);

    const replayEvents = collectPrivateEvents(caller);
    const replayAcknowledgement = once<unknown>(caller, "v1:ack");
    const noReplayToOtherTab = expectNoEvent(sameParticipant, "v1:private-event");
    caller.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: markEvent.commandId,
      ball: 1,
    });
    await expect(replayEvents).resolves.toEqual([markEvent, nearWinEvent]);
    await expect(replayAcknowledgement).resolves.toMatchObject({ idempotentReplay: true });
    await noReplayToOtherTab;
  });

  test("disconnects an identity rejected by transactional revalidation", async () => {
    const credential = ticket(14);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      execute: async () => ({ ok: false, error: { code: "UNAUTHORIZED" } }),
    });
    const client = await harness.connect(credential);
    const unauthorized = once<unknown>(client, "v1:error");
    const disconnected = once<void>(client, "disconnect");

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_revoked",
    });

    await expect(unauthorized).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    await disconnected;
    const noEvent = expectNoEvent(client, "v1:lobby-event");
    await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
    await noEvent;
  });

  test.each(["NOT_FOUND", "LOBBY_EXPIRED"] as const)(
    "disconnects when transactional revalidation returns terminal %s",
    async (code) => {
      const credential = ticket(code === "NOT_FOUND" ? 46 : 47);
      const harness = await createHarness({
        tickets: new Map([[ticketHash(credential), identities.host]]),
        execute: async () => ({ ok: false, error: { code } }),
      });
      const client = await harness.connect(credential);
      const terminalError = once<unknown>(client, "v1:error");
      const disconnected = once<void>(client, "disconnect");

      client.emit("v1:command", {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "start-round",
        commandId: `command_terminal_${code.toLowerCase()}`,
      });

      await expect(terminalError).resolves.toMatchObject({ code });
      await disconnected;
      const noEvent = expectNoEvent(client, "v1:lobby-event");
      await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
      await noEvent;
    },
  );

  test("ejects inactive identities before publishing committed events", async () => {
    const credential = ticket(15);
    let active = true;
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      authorize: async () => active,
    });
    const client = await harness.connect(credential);
    active = false;
    const disconnected = once<void>(client, "disconnect");
    const noEvent = expectNoEvent(client, "v1:lobby-event");

    await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);

    await disconnected;
    await noEvent;
  });

  test("authorizes one persisted identity once per room delivery", async () => {
    const credentials = [ticket(27), ticket(28)];
    let authorizationCount = 0;
    const harness = await createHarness({
      tickets: new Map(credentials.map((credential) => [ticketHash(credential), identities.host])),
      authorize: async () => {
        authorizationCount += 1;
        return true;
      },
    });
    const first = await harness.connect(credentials[0]!);
    const second = await harness.connect(credentials[1]!);
    const firstEvent = once(first, "v1:lobby-event");
    const secondEvent = once(second, "v1:lobby-event");

    await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);

    await Promise.all([firstEvent, secondEvent]);
    expect(authorizationCount).toBe(1);
  });

  test("bounds connection attempts and serialized command work", async () => {
    const credentials = [ticket(16), ticket(17)];
    const connectionLimited = await createHarness({
      tickets: new Map<string, AuthenticatedRealtimeIdentity>([
        [ticketHash(credentials[0]!), identities.host],
        [ticketHash(credentials[1]!), identities.player],
      ]),
      limits: { connectionsPerMinute: 1 },
    });
    await connectionLimited.connect(credentials[0]!);
    await expect(connectionLimited.reject(credentials[1]!)).resolves.toMatchObject({
      message: "websocket error",
    });
    expect(connectionLimited.consumedHashes).toEqual([ticketHash(credentials[0]!)]);

    const commandCredential = ticket(18);
    const commandLimited = await createHarness({
      tickets: new Map([[ticketHash(commandCredential), identities.host]]),
      limits: { commandsPerMinute: 1 },
    });
    const client = await commandLimited.connect(commandCredential);
    const command = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_rate_one",
    } as const;
    const acknowledged = once<unknown>(client, "v1:ack");
    client.emit("v1:command", command);
    await acknowledged;
    const limited = once<unknown>(client, "v1:error");
    client.emit("v1:command", { ...command, commandId: "command_rate_two" });
    await expect(limited).resolves.toMatchObject({ code: "RATE_LIMITED" });
    expect(commandLimited.executed).toHaveLength(1);
  });

  test("charges overlapping command attempts before rejecting in-flight work", async () => {
    const credential = ticket(21);
    const firstExecutionStarted = deferred();
    const releaseFirstExecution = deferred();
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      limits: { commandsPerMinute: 2 },
      execute: async (_identity, command) => {
        firstExecutionStarted.resolve();
        await releaseFirstExecution.promise;
        return {
          ok: true,
          acknowledgement: CommandAckSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "ack",
            commandId: command.commandId,
            occurredAt: NOW,
            idempotentReplay: true,
            scope: "active-lobby",
            eventSequence: 1,
          }),
          activeLobbyEvent: null,
          participantPrivateEvents: [],
        };
      },
    });
    const client = await harness.connect(credential);
    const command = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_in_flight_one",
    } as const;

    const acknowledgement = once<unknown>(client, "v1:ack");
    client.emit("v1:command", command);
    try {
      await waitForSignal(firstExecutionStarted.promise, "the first command execution to start");
      const overlapError = once<unknown>(client, "v1:error");
      client.emit("v1:command", { ...command, commandId: "command_in_flight_two" });
      await expect(overlapError).resolves.toMatchObject({ code: "RATE_LIMITED" });
      releaseFirstExecution.resolve();
      await acknowledgement;
    } finally {
      releaseFirstExecution.resolve();
    }

    const exhaustedError = once<unknown>(client, "v1:error");
    client.emit("v1:command", { ...command, commandId: "command_after_overlap" });
    await expect(exhaustedError).resolves.toMatchObject({ code: "RATE_LIMITED" });
    expect(harness.executed).toHaveLength(1);
  });

  test("supports heartbeat, actor-scoped resync, and later committed event publishers", async () => {
    const credential = ticket(12);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      snapshot: async (identity) =>
        identity.participantSessionId === identities.host.participantSessionId
          ? waitingSnapshot
          : null,
    });
    const client = await harness.connect(credential);

    const noHeartbeatError = expectNoEvent(client, "v1:error");
    client.emit("v1:command", { schemaVersion: CONTRACT_SCHEMA_VERSION, type: "heartbeat" });
    await noHeartbeatError;

    const snapshot = once<unknown>(client, "v1:snapshot");
    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resync",
      lastEventSequence: null,
    });
    await expect(snapshot).resolves.toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "snapshot",
      snapshot: waitingSnapshot,
    });

    const presence = ActiveLobbyEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "presence",
      eventSequence: 2,
      occurredAt: NOW,
      presence: {
        participantId: identities.host.participantId,
        generation: 1,
        status: "grace",
        changedAt: NOW,
        graceEndsAt: LATER,
      },
    });
    const nearWin = ParticipantPrivateEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "near-win",
      occurredAt: NOW,
      requiredBall: 2,
    });
    const lobbyEvent = once<unknown>(client, "v1:lobby-event");
    const privateEvent = once<unknown>(client, "v1:private-event");
    await Promise.all([
      harness.server.publishLobbyEvent(identities.host.lobbyId, presence),
      harness.server.publishParticipantEvent(identities.host.participantId, nearWin),
    ]);
    await expect(lobbyEvent).resolves.toEqual(presence);
    await expect(privateEvent).resolves.toEqual(nearWin);
  });

  test("disconnects inactive heartbeat and unauthorized resync clients", async () => {
    const heartbeatCredential = ticket(43);
    const heartbeatHarness = await createHarness({
      tickets: new Map([[ticketHash(heartbeatCredential), identities.host]]),
      recordHeartbeat: async () => false,
    });
    const heartbeatClient = await heartbeatHarness.connect(heartbeatCredential);
    const heartbeatError = once<unknown>(heartbeatClient, "v1:error");
    const heartbeatDisconnect = once<void>(heartbeatClient, "disconnect");

    heartbeatClient.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "heartbeat",
    });

    await expect(heartbeatError).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    await heartbeatDisconnect;

    const resyncCredential = ticket(44);
    let resyncRequests = 0;
    const resyncHarness = await createHarness({
      tickets: new Map([[ticketHash(resyncCredential), identities.host]]),
      snapshot: async (identity) => {
        resyncRequests += 1;
        return resyncRequests === 1 ? waitingSnapshotForIdentity(identity) : null;
      },
    });
    const resyncClient = await resyncHarness.connect(resyncCredential);
    const resyncError = once<unknown>(resyncClient, "v1:error");
    const resyncDisconnect = once<void>(resyncClient, "disconnect");

    resyncClient.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resync",
      lastEventSequence: null,
    });

    await expect(resyncError).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    await resyncDisconnect;
  });

  test("returns a safe error without a snapshot when resync persistence fails", async () => {
    const credential = ticket(45);
    let snapshotRequests = 0;
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      snapshot: async (identity) => {
        snapshotRequests += 1;
        if (snapshotRequests === 1) return waitingSnapshotForIdentity(identity);
        throw new Error("private snapshot persistence detail");
      },
    });
    const client = await harness.connect(credential);
    const error = once<unknown>(client, "v1:error");
    const snapshots: unknown[] = [];
    client.on("v1:snapshot", (snapshot) => snapshots.push(snapshot));

    client.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resync",
      lastEventSequence: null,
    });

    const receivedError = await error;
    expect(receivedError).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(receivedError)).not.toContain("private snapshot persistence detail");
    expect(snapshots).toEqual([]);
    expect(client.connected).toBe(true);
  });

  test("broadcasts a winner window while keeping its committed mark private", async () => {
    const hostCredential = ticket(72);
    const playerCredential = ticket(73);
    const playerTabCredential = ticket(74);
    const playerTabIdentity: AuthenticatedRealtimeIdentity = {
      ...identities.player,
      participantSessionId: "session_player_tab",
    };
    const command = MutationCommandSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: "command_open_co_winner",
      ball: 1,
    });
    const windowEvent = ActiveLobbyEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "co-winner-window",
      eventSequence: 1,
      occurredAt: NOW,
      window: { triggeringCallId: "call_one", openedAt: NOW, closesAt: LATER },
    });
    const privateMark = ParticipantPrivateEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-result",
      commandId: command.commandId,
      occurredAt: NOW,
      mark: {
        id: "mark_co_winner",
        cardId: "card_player",
        ball: 1,
        markedAt: NOW,
      },
    });
    let commandExecutions = 0;
    const harness = await createHarness({
      tickets: new Map<string, AuthenticatedRealtimeIdentity>([
        [ticketHash(hostCredential), identities.host],
        [ticketHash(playerCredential), identities.player],
        [ticketHash(playerTabCredential), playerTabIdentity],
      ]),
      execute: async () => {
        commandExecutions += 1;
        const idempotentReplay = commandExecutions > 1;
        return {
          ok: true,
          acknowledgement: CommandAckSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "ack",
            commandId: command.commandId,
            occurredAt: NOW,
            idempotentReplay,
            scope: "active-lobby",
            eventSequence: 1,
          }),
          activeLobbyEvent: idempotentReplay ? null : windowEvent,
          participantPrivateEvents: [privateMark],
        };
      },
    });
    const [host, player, playerTab] = await Promise.all([
      harness.connect(hostCredential),
      harness.connect(playerCredential),
      harness.connect(playerTabCredential),
    ]);
    const hostWindow = once<unknown>(host, "v1:lobby-event");
    const playerWindow = once<unknown>(player, "v1:lobby-event");
    const playerTabWindow = once<unknown>(playerTab, "v1:lobby-event");
    const playerPrivate = once<unknown>(player, "v1:private-event");
    const playerTabPrivate = once<unknown>(playerTab, "v1:private-event");
    const acknowledgement = once<unknown>(player, "v1:ack");
    const hostPrivate = expectNoEvent(host, "v1:private-event");

    player.emit("v1:command", command);

    await expect(hostWindow).resolves.toEqual(windowEvent);
    await expect(playerWindow).resolves.toEqual(windowEvent);
    await expect(playerTabWindow).resolves.toEqual(windowEvent);
    await expect(playerPrivate).resolves.toEqual(privateMark);
    await expect(playerTabPrivate).resolves.toEqual(privateMark);
    await expect(acknowledgement).resolves.toMatchObject({
      commandId: command.commandId,
      scope: "active-lobby",
      eventSequence: 1,
    });
    await hostPrivate;

    const replayedPrivate = once<unknown>(player, "v1:private-event");
    const replayedAck = once<unknown>(player, "v1:ack");
    const hostReplayWindow = expectNoEvent(host, "v1:lobby-event");
    const playerTabReplayWindow = expectNoEvent(playerTab, "v1:lobby-event");
    const playerTabReplayPrivate = expectNoEvent(playerTab, "v1:private-event");
    player.emit("v1:command", command);
    await expect(replayedPrivate).resolves.toEqual(privateMark);
    await expect(replayedAck).resolves.toMatchObject({ idempotentReplay: true });
    await Promise.all([hostReplayWindow, playerTabReplayWindow, playerTabReplayPrivate]);

    const resultEvent = ActiveLobbyEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "co-winner-result",
      eventSequence: 2,
      occurredAt: LATER,
      result: {
        triggeringCallId: "call_one",
        openedAt: NOW,
        closesAt: LATER,
        settledAt: LATER,
        winnerParticipantIds: [identities.player.participantId],
      },
    });
    const hostResult = once<unknown>(host, "v1:lobby-event");
    const playerResult = once<unknown>(player, "v1:lobby-event");
    const playerTabResult = once<unknown>(playerTab, "v1:lobby-event");
    await harness.server.publishLobbyEvent(identities.host.lobbyId, resultEvent);
    await expect(hostResult).resolves.toEqual(resultEvent);
    await expect(playerResult).resolves.toEqual(resultEvent);
    await expect(playerTabResult).resolves.toEqual(resultEvent);
  });

  test("rejects an invalid mixed private batch before broadcasting its lobby event", async () => {
    const credential = ticket(75);
    const command = MutationCommandSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: "command_invalid_mixed_result",
      ball: 1,
    });
    const windowEvent = ActiveLobbyEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "co-winner-window",
      eventSequence: 1,
      occurredAt: NOW,
      window: { triggeringCallId: "call_one", openedAt: NOW, closesAt: LATER },
    });
    const invalidPrivateEvent = ParticipantPrivateEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "near-win",
      occurredAt: NOW,
      requiredBall: 1,
    });
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.player]]),
      execute: async () => ({
        ok: true,
        acknowledgement: CommandAckSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          commandId: command.commandId,
          occurredAt: NOW,
          idempotentReplay: false,
          scope: "active-lobby",
          eventSequence: 1,
        }),
        activeLobbyEvent: windowEvent,
        participantPrivateEvents: [invalidPrivateEvent],
      }),
    });
    const client = await harness.connect(credential);
    const error = once<unknown>(client, "v1:error");
    const noLobbyEvent = expectNoEvent(client, "v1:lobby-event");
    const noPrivateEvent = expectNoEvent(client, "v1:private-event");

    client.emit("v1:command", command);

    await expect(error).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
    await Promise.all([noLobbyEvent, noPrivateEvent]);
  });

  test("publishes every active-lobby and participant-private event variant", async () => {
    const credential = ticket(34);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
    });
    const client = await harness.connect(credential);
    const activeLobbyEvents = [
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "presence",
        eventSequence: 1,
        occurredAt: NOW,
        presence: {
          participantId: identities.host.participantId,
          generation: 1,
          status: "connected",
          changedAt: NOW,
        },
      },
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "call",
        eventSequence: 2,
        occurredAt: NOW,
        call: {
          id: "call_one",
          roundId: "round_one",
          position: 1,
          ball: 1,
          calledAt: NOW,
        },
      },
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "co-winner-window",
        eventSequence: 3,
        occurredAt: NOW,
        window: { triggeringCallId: "call_one", openedAt: NOW, closesAt: LATER },
      },
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "co-winner-result",
        eventSequence: 4,
        occurredAt: LATER,
        result: {
          triggeringCallId: "call_one",
          openedAt: NOW,
          closesAt: LATER,
          settledAt: LATER,
          winnerParticipantIds: [identities.host.participantId],
        },
      },
      { ...stageEvent, eventSequence: 5, occurredAt: LATER },
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "round-end",
        eventSequence: 6,
        occurredAt: LATER,
        round: {
          id: "round_one",
          lobbyId: identities.host.lobbyId,
          patternId: "standard-one-line",
          callConfiguration: { mode: "manual" },
          stage: "ended",
          startedAt: NOW,
          endedAt: LATER,
          result: null,
        },
      },
    ].map((event) => ActiveLobbyEventSchema.parse(event));
    const privateEvents = [
      markEvent,
      ParticipantPrivateEventSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "near-win",
        occurredAt: NOW,
        requiredBall: 2,
      }),
    ];

    for (const event of activeLobbyEvents) {
      const received = once<unknown>(client, "v1:lobby-event");
      await harness.server.publishLobbyEvent(identities.host.lobbyId, event);
      await expect(received).resolves.toEqual(event);
    }
    for (const event of privateEvents) {
      const received = once<unknown>(client, "v1:private-event");
      await harness.server.publishParticipantEvent(identities.host.participantId, event);
      await expect(received).resolves.toEqual(event);
    }
  });
});
