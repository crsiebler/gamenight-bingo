import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  ActiveLobbyEventSchema,
  CallNextCommandSchema,
  ConfigureCommandSchema,
  ContinueRoundCommandSchema,
  CreateRoundCommandSchema,
  EndRoundCommandSchema,
  MarkCardCommandSchema,
  OverrideAbsenceCommandSchema,
  PauseRoundCommandSchema,
  ParticipantPrivateEventSchema,
  ResumeRoundCommandSchema,
  SnapshotSchema,
  StartRoundCommandSchema,
} from "@gamenight-bingo/contracts";
import {
  calculatePatternProgress,
  patternCatalog,
  type PatternDefinition,
} from "@gamenight-bingo/patterns";

import {
  CommandReplayMismatchError,
  connectDatabase,
  type ActiveLobbyEventNotification,
  type CommandTransactionRepositories,
  type CommandTransactionRequest,
  type ConsumedRealtimeTicket,
  type CreateActiveLobbyResult,
  type DurableLobbyState,
  type JsonObject,
  type NewActiveLobbyState,
  type NewLobbyParticipant,
  type NewParticipantSession,
  type ReserveParticipantResult,
  type TransactionRetryEvent,
} from "./index.js";
import {
  ACTIVE_LOBBY_EVENT_CHANNEL,
  encodeActiveLobbyEventReference,
} from "./active-lobby-events.js";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const describeDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomLobbyCode(): string {
  return Array.from(randomBytes(6), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve,
    wait(label: string): Promise<void> {
      return new Promise((waitResolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          2_000,
        );
        promise.then(
          () => {
            clearTimeout(timeout);
            waitResolve();
          },
          (error: unknown) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
      });
    },
  };
}

function createCardCells(offset: number): readonly number[] {
  return [
    1 + offset,
    16 + offset,
    31 + offset,
    46 + offset,
    61 + offset,
    2 + offset,
    17 + offset,
    32 + offset,
    47 + offset,
    62 + offset,
    3 + offset,
    18 + offset,
    0,
    48 + offset,
    63 + offset,
    4 + offset,
    19 + offset,
    34 + offset,
    49 + offset,
    64 + offset,
    5 + offset,
    20 + offset,
    35 + offset,
    50 + offset,
    65 + offset,
  ];
}

function createLobbyState(
  overrides: {
    readonly code?: string;
    readonly duplicateUsername?: boolean;
    readonly duplicateCard?: boolean;
    readonly duplicateCall?: boolean;
    readonly duplicateEvent?: boolean;
    readonly duplicateCommand?: boolean;
    readonly disconnectedWithoutRejoin?: boolean;
    readonly graceWithoutDeadline?: boolean;
    readonly automaticWithoutInterval?: boolean;
  } = {},
): DurableLobbyState {
  const suffix = randomUUID();
  const lobbyId = `lobby-${suffix}`;
  const hostId = `participant-host-${suffix}`;
  const playerId = `participant-player-${suffix}`;
  const roundId = `round-${suffix}`;
  const hostCardId = `card-host-${suffix}`;
  const playerCardId = `card-player-${suffix}`;
  const callId = `call-${suffix}`;
  const createdAt = new Date("2026-07-17T08:00:00.000Z");
  const startedAt = new Date("2026-07-17T08:01:00.000Z");
  const calledAt = new Date("2026-07-17T08:02:00.000Z");
  const openedAt = new Date("2026-07-17T08:02:01.000Z");
  const closesAt = new Date("2026-07-17T08:02:03.000Z");
  const settledAt = new Date("2026-07-17T08:02:03.000Z");

  return {
    lobby: {
      id: lobbyId,
      code: overrides.code ?? randomLobbyCode(),
      status: "active",
      themeId: "theme-nature",
      createdAt,
      lastActivityAt: settledAt,
      endedAt: null,
      lastEventSequence: 1n,
    },
    participants: [
      {
        id: hostId,
        username: "Host Player",
        normalizedUsername: "host player",
        role: "host",
        roundEligibility: "playing",
        joinedAt: createdAt,
        departedAt: null,
      },
      {
        id: playerId,
        username: overrides.duplicateUsername === true ? "Host Player" : "Guest Player",
        normalizedUsername: overrides.duplicateUsername === true ? "host player" : "guest player",
        role: "player",
        roundEligibility: "playing",
        joinedAt: createdAt,
        departedAt: null,
      },
    ],
    sessions: [
      {
        id: `session-host-${suffix}`,
        participantId: hostId,
        tokenHash: new Uint8Array(randomBytes(32)),
        status: overrides.disconnectedWithoutRejoin === true ? "disconnected" : "active",
        issuedAt: createdAt,
        disconnectedAt: overrides.disconnectedWithoutRejoin === true ? startedAt : null,
        rejoinUntil: null,
        departedAt: null,
      },
      {
        id: `session-player-${suffix}`,
        participantId: playerId,
        tokenHash: new Uint8Array(randomBytes(32)),
        status: "active",
        issuedAt: createdAt,
        disconnectedAt: null,
        rejoinUntil: null,
        departedAt: null,
      },
    ],
    presenceGenerations: [
      {
        participantId: hostId,
        generation: 1n,
        status: overrides.graceWithoutDeadline === true ? "grace" : "connected",
        connectionCount: overrides.graceWithoutDeadline === true ? 0 : 1,
        changedAt: startedAt,
        graceEndsAt: null,
        absentSince: null,
        departedAt: null,
        overridden: false,
        endedAt: null,
      },
      {
        participantId: playerId,
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
      callIntervalSeconds: overrides.automaticWithoutInterval === true ? null : 30,
      createdAt,
      startedAt,
      activeAt: startedAt,
      pausedAt: null,
      pauseReason: null,
      nextCallAt: null,
      coWinnerTriggeringCallId: callId,
      coWinnerOpenedAt: openedAt,
      coWinnerClosesAt: closesAt,
      resultSettledAt: settledAt,
      endedAt: null,
      drawOrder: Array.from({ length: 75 }, (_, index) => ({
        position: index + 1,
        ball: index + 1,
      })),
      cards: [
        {
          id: hostCardId,
          participantId: hostId,
          cells: createCardCells(0),
          createdAt,
          marks: [
            {
              id: `mark-${suffix}`,
              ball: 1,
              markedAt: calledAt,
            },
          ],
        },
        {
          id: playerCardId,
          participantId: playerId,
          cells: overrides.duplicateCard === true ? createCardCells(0) : createCardCells(5),
          createdAt,
          marks: [],
        },
      ],
      calls: [
        {
          id: callId,
          position: 1,
          ball: 1,
          calledAt,
        },
        ...(overrides.duplicateCall === true
          ? [
              {
                id: `call-duplicate-${suffix}`,
                position: 1,
                ball: 1,
                calledAt,
              },
            ]
          : []),
      ],
      coWinners: [
        {
          participantId: hostId,
          cardId: hostCardId,
          triggeringCallId: callId,
          confirmedAt: settledAt,
        },
      ],
    },
    events: [
      {
        sequence: 1n,
        roundId,
        eventType: "round-result",
        schemaVersion: 1,
        payload: { winnerParticipantIds: [hostId] },
        createdAt: settledAt,
      },
      ...(overrides.duplicateEvent === true
        ? [
            {
              sequence: 1n,
              roundId,
              eventType: "duplicate",
              schemaVersion: 1,
              payload: {},
              createdAt: settledAt,
            },
          ]
        : []),
    ],
    commandResults: [
      {
        participantId: hostId,
        commandId: `command-${suffix}`,
        roundId,
        commandType: "settle-result",
        deliveryScope: "active-lobby",
        eventSequence: 1n,
        result: { ok: true },
        createdAt: settledAt,
      },
      ...(overrides.duplicateCommand === true
        ? [
            {
              participantId: hostId,
              commandId: `command-${suffix}`,
              roundId,
              commandType: "settle-result",
              deliveryScope: "active-lobby" as const,
              eventSequence: 1n,
              result: { ok: true },
              createdAt: settledAt,
            },
          ]
        : []),
    ],
  };
}

function omitLobbyCode(state: DurableLobbyState): NewActiveLobbyState {
  const status = state.lobby.status;
  if (status !== "waiting" && status !== "active") {
    throw new Error("The test lobby must be active.");
  }
  return {
    ...state,
    lobby: {
      id: state.lobby.id,
      status,
      themeId: state.lobby.themeId,
      createdAt: state.lobby.createdAt,
      lastActivityAt: state.lobby.lastActivityAt,
      ...(state.lobby.endedAt === undefined ? {} : { endedAt: state.lobby.endedAt }),
      lastEventSequence: state.lobby.lastEventSequence,
    },
  };
}

function scriptedCodes(codes: readonly string[]): () => string {
  let index = 0;

  return () => {
    const code = codes[index];
    if (code === undefined) {
      throw new Error("Lobby code test sequence exhausted.");
    }
    index += 1;
    return code;
  };
}

describeDatabase("PostgreSQL durable game state", () => {
  const connections: Awaited<ReturnType<typeof connectDatabase>>[] = [];
  let pool: Pool;

  beforeAll(() => {
    if (testDatabaseUrl === undefined) {
      return;
    }
    pool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
  });

  afterEach(async () => {
    await Promise.all(connections.map(async (connection) => connection.disconnect()));
    connections.length = 0;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function connect() {
    const connection = await connectDatabase(testDatabaseUrl!);
    connections.push(connection);
    return connection;
  }

  async function connectWithRetryObserver(events: TransactionRetryEvent[]) {
    const connection = await connectDatabase(testDatabaseUrl!, {
      transactionRetry: {
        observer: (event) => events.push(event),
      },
    });
    connections.push(connection);
    return connection;
  }

  async function connectWithLifecycleClock(clock: () => Date) {
    const connection = await connectDatabase(testDatabaseUrl!, { lifecycleClock: clock });
    connections.push(connection);
    return connection;
  }

  async function connectWithRoundCommands(
    clock: () => Date,
    overrides: {
      readonly nextId?: (prefix: "round" | "card" | "call" | "mark") => string;
      readonly nearWinFeedbackEnabled?: boolean;
      readonly patterns?: readonly PatternDefinition[];
      readonly coWinnerWindowMs?: number;
    } = {},
  ) {
    const connection = await connectDatabase(testDatabaseUrl!, {
      lifecycleClock: clock,
      roundCommands: {
        patterns: overrides.patterns ?? patternCatalog,
        nearWinFeedbackEnabled: overrides.nearWinFeedbackEnabled ?? true,
        coWinnerWindowMs: overrides.coWinnerWindowMs ?? 2_000,
        clock,
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
        nextId: overrides.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`),
      },
    });
    connections.push(connection);
    return connection;
  }

  async function createPersistedLobby(
    connection: Awaited<ReturnType<typeof connectDatabase>>,
    state: DurableLobbyState,
  ): Promise<void> {
    const result = await connection.lobbyStates.createActive(omitLobbyCode(state), {
      maxActiveLobbies: Number.MAX_SAFE_INTEGER,
      nextCode: () => state.lobby.code,
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }

  async function waitForBlockedCommandFences(
    expectedCount: number,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE '%UPDATE "lobbies"%'
            AND query LIKE '%last_event_sequence%'`,
      );
      if ((result.rows[0]?.count ?? 0) >= expectedCount) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(
      `Timed out waiting for ${expectedCount} concurrent operation(s) to block on the lobby fence.`,
    );
  }

  async function waitForBlockedCommandFence(timeoutMs = 5_000): Promise<void> {
    await waitForBlockedCommandFences(1, timeoutMs);
  }

  async function waitForBlockedLobbyAdmissions(
    expectedCount: number,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event = 'advisory'
            AND query LIKE '%pg_advisory_xact_lock%'`,
      );
      if (result.rows[0]?.count === expectedCount) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("Timed out waiting for concurrent lobby admissions to block.");
  }

  async function waitForBlockedParticipantReservations(
    expectedCount: number,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%UPDATE "lobbies"%'
            AND query LIKE '%"status" IN%'`,
      );
      if (result.rows[0]?.count === expectedCount) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("Timed out waiting for concurrent participant reservations to block.");
  }

  async function waitForBlockedRealtimeTicketConsumers(
    expectedCount: number,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE '%DELETE FROM "realtime_tickets"%'`,
      );
      if (result.rows[0]?.count === expectedCount) return;

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("Timed out waiting for concurrent realtime ticket consumption.");
  }

  function commandRequest(
    state: DurableLobbyState,
    commandId: string,
    commandType = "test-command",
  ): CommandTransactionRequest<JsonObject> {
    return {
      lobbyId: state.lobby.id,
      participantId: state.participants[0]!.id,
      commandId,
      commandType,
      roundId: state.round!.id,
      createdAt: new Date("2026-07-17T09:00:00.000Z"),
      decodeResult: (result) => result,
    };
  }

  function newParticipant(
    lobbyId: string,
    username = `Player ${randomUUID()}`,
  ): NewLobbyParticipant {
    return {
      id: `participant-${randomUUID()}`,
      lobbyId,
      username,
      role: "player",
      joinedAt: new Date("2026-07-17T08:03:00.000Z"),
    };
  }

  test("restores the complete authoritative state after reconnecting the client", async () => {
    const expected = createLobbyState();
    const firstConnection = await connect();

    await createPersistedLobby(firstConnection, expected);
    await firstConnection.disconnect();
    connections.splice(connections.indexOf(firstConnection), 1);

    const restartedConnection = await connect();
    const restored = await restartedConnection.lobbyStates.findById(expected.lobby.id);

    expect(restored).toEqual(expected);
  });

  test("enforces aggregate scoped uniqueness", async () => {
    const connection = await connect();

    for (const invalidState of [
      createLobbyState({ duplicateUsername: true }),
      createLobbyState({ duplicateCard: true }),
      createLobbyState({ duplicateCall: true }),
      createLobbyState({ duplicateEvent: true }),
      createLobbyState({ duplicateCommand: true }),
      createLobbyState({ disconnectedWithoutRejoin: true }),
      createLobbyState({ graceWithoutDeadline: true }),
      createLobbyState({ automaticWithoutInterval: true }),
    ]) {
      await expect(createPersistedLobby(connection, invalidState)).rejects.toBeDefined();
    }

    await expect(createPersistedLobby(connection, createLobbyState())).resolves.toBeUndefined();
  });

  test("retries active-code collisions and resolves codes only as active lobby locators", async () => {
    const connection = await connect();
    const existing = createLobbyState();
    const created = createLobbyState();
    const availableCode = randomLobbyCode();
    await createPersistedLobby(connection, existing);

    await expect(
      connection.lobbyStates.createActive(omitLobbyCode(created), {
        maxActiveLobbies: Number.MAX_SAFE_INTEGER,
        nextCode: scriptedCodes([existing.lobby.code, availableCode]),
      }),
    ).resolves.toEqual({
      ok: true,
      lobbyId: created.lobby.id,
      code: availableCode,
    });
    await expect(connection.lobbyStates.findActiveLobbyIdByCode(availableCode)).resolves.toBe(
      created.lobby.id,
    );

    await pool.query(`UPDATE lobbies SET status = 'COMPLETED' WHERE id = $1`, [created.lobby.id]);
    await expect(connection.lobbyStates.findActiveLobbyIdByCode(availableCode)).resolves.toBeNull();
  });

  test("enforces the configured active-lobby limit without inserting", async () => {
    const connection = await connect();
    const activeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM lobbies WHERE status IN ('WAITING', 'ACTIVE')`,
    );
    const state = createLobbyState();

    await expect(
      connection.lobbyStates.createActive(omitLobbyCode(state), {
        maxActiveLobbies: Number(activeCount.rows[0]!.count),
        nextCode: () => state.lobby.code,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "ACTIVE_LOBBY_LIMIT_REACHED",
        message: "The active lobby limit has been reached.",
      },
    });
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toBeNull();
  });

  test("creates a lobby, host, presence, and hash-only session atomically", async () => {
    const connection = await connect();
    const suffix = randomUUID();
    const issuedAt = new Date("2026-07-17T12:00:00.000Z");
    const tokenHash = new Uint8Array(randomBytes(32));
    const code = randomLobbyCode();
    const result = await connection.lobbyStates.createLobbyWithHost({
      lobbyId: `lobby-${suffix}`,
      participantId: `participant-${suffix}`,
      sessionId: `session-${suffix}`,
      commandId: `command-${suffix}`,
      username: "  Host   Player  ",
      themeId: "classic",
      tokenHash,
      issuedAt,
      maxActiveLobbies: Number.MAX_SAFE_INTEGER,
      nextCode: () => code,
    });

    expect(result).toEqual({
      ok: true,
      entry: {
        commandId: `command-${suffix}`,
        idempotentReplay: false,
        lobbyId: `lobby-${suffix}`,
        lobbyCode: code,
        themeId: "classic",
        participantId: `participant-${suffix}`,
        username: "Host Player",
        role: "host",
        roundEligibility: "playing",
        sessionId: `session-${suffix}`,
        issuedAt,
      },
    });
    await expect(connection.lobbyStates.findById(`lobby-${suffix}`)).resolves.toMatchObject({
      lobby: { code, status: "waiting", themeId: "classic" },
      participants: [
        {
          id: `participant-${suffix}`,
          username: "Host Player",
          normalizedUsername: "host player",
          role: "host",
          roundEligibility: "playing",
        },
      ],
      sessions: [
        {
          id: `session-${suffix}`,
          participantId: `participant-${suffix}`,
          tokenHash,
          status: "active",
        },
      ],
      presenceGenerations: [
        {
          participantId: `participant-${suffix}`,
          generation: 1n,
          status: "absent",
          connectionCount: 0,
          changedAt: issuedAt,
          absentSince: issuedAt,
        },
      ],
    });
  });

  test("aggregates realtime tabs and sequences only visible presence transitions", async () => {
    let now = new Date("2026-07-17T12:30:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const suffix = randomUUID();
    const lobbyId = `lobby-presence-${suffix}`;
    const participantId = `participant-presence-${suffix}`;
    const participantSessionId = `session-presence-${suffix}`;
    const created = await connection.lobbyStates.createLobbyWithHost({
      lobbyId,
      participantId,
      sessionId: participantSessionId,
      commandId: `command-presence-${suffix}`,
      username: `Presence Host ${suffix}`,
      themeId: "classic",
      tokenHash: new Uint8Array(randomBytes(32)),
      issuedAt: new Date("2026-07-17T12:29:00.000Z"),
      maxActiveLobbies: Number.MAX_SAFE_INTEGER,
      nextCode: randomLobbyCode,
    });
    expect(created.ok).toBe(true);
    const identity = { lobbyId, participantId, participantSessionId };
    const notifiedEvents: Awaited<ReturnType<ActiveLobbyEventNotification["loadEvent"]>>[] = [];
    const twoNotifications = deferredSignal();
    const subscription = await connection.activeLobbyEvents.subscribe(async (notification) => {
      if (notification.lobbyId !== lobbyId) return;
      notifiedEvents.push(await notification.loadEvent());
      if (notifiedEvents.length === 2) twoNotifications.resolve();
    });

    await expect(connection.lobbyStates.registerRealtimeConnection(identity)).resolves.toBe(2);
    now = new Date("2026-07-17T12:31:00.000Z");
    await expect(connection.lobbyStates.registerRealtimeConnection(identity)).resolves.toBe(2);

    let state = await connection.lobbyStates.findById(lobbyId);
    expect(state?.presenceGenerations).toEqual([
      expect.objectContaining({
        participantId,
        generation: 1n,
        status: "absent",
        connectionCount: 0,
        endedAt: new Date("2026-07-17T12:30:00.000Z"),
      }),
      expect.objectContaining({
        participantId,
        generation: 2n,
        status: "connected",
        connectionCount: 2,
        changedAt: new Date("2026-07-17T12:30:00.000Z"),
        endedAt: null,
      }),
    ]);
    expect(state?.lobby.lastEventSequence).toBe(1n);
    expect(state?.events.at(-1)).toMatchObject({
      sequence: 1n,
      eventType: "presence",
      payload: {
        presence: {
          participantId,
          generation: 2,
          status: "connected",
          changedAt: "2026-07-17T12:30:00.000Z",
        },
      },
    });
    expect(() =>
      ActiveLobbyEventSchema.parse({
        ...state!.events.at(-1)!.payload,
        schemaVersion: state!.events.at(-1)!.schemaVersion,
        type: state!.events.at(-1)!.eventType,
        eventSequence: Number(state!.events.at(-1)!.sequence),
        occurredAt: state!.events.at(-1)!.createdAt.toISOString(),
      }),
    ).not.toThrow();

    now = new Date("2026-07-17T12:32:00.000Z");
    await expect(
      connection.lobbyStates.unregisterRealtimeConnection({
        ...identity,
        presenceGeneration: 2,
        reconnectWindowSeconds: 120,
        disconnectPauseGraceSeconds: 10,
      }),
    ).resolves.toBeNull();
    state = await connection.lobbyStates.findById(lobbyId);
    expect(state?.presenceGenerations.at(-1)).toMatchObject({
      status: "connected",
      connectionCount: 1,
      changedAt: new Date("2026-07-17T12:30:00.000Z"),
    });
    expect(state?.sessions[0]).toMatchObject({
      status: "active",
      disconnectedAt: null,
      rejoinUntil: null,
    });
    expect(state?.lobby.lastEventSequence).toBe(1n);

    now = new Date("2026-07-17T12:33:00.000Z");
    await expect(
      connection.lobbyStates.unregisterRealtimeConnection({
        ...identity,
        presenceGeneration: 2,
        reconnectWindowSeconds: 120,
        disconnectPauseGraceSeconds: 10,
      }),
    ).resolves.toEqual({
      lobbyId,
      participantId,
      presenceGeneration: 2,
      graceEndsAt: new Date("2026-07-17T12:33:10.000Z"),
    });
    state = await connection.lobbyStates.findById(lobbyId);
    expect(state?.presenceGenerations.at(-1)).toMatchObject({
      participantId,
      generation: 2n,
      status: "grace",
      connectionCount: 0,
      changedAt: now,
      graceEndsAt: new Date("2026-07-17T12:33:10.000Z"),
      overridden: false,
    });
    expect(state?.sessions[0]).toMatchObject({
      status: "disconnected",
      disconnectedAt: now,
      rejoinUntil: new Date("2026-07-17T12:35:00.000Z"),
    });
    expect(state?.lobby.lastEventSequence).toBe(2n);
    expect(state?.events.at(-1)).toMatchObject({
      sequence: 2n,
      eventType: "presence",
      payload: {
        presence: {
          participantId,
          generation: 2,
          status: "grace",
          changedAt: "2026-07-17T12:33:00.000Z",
          graceEndsAt: "2026-07-17T12:33:10.000Z",
        },
      },
    });
    await twoNotifications.wait("the committed connected and grace presence notifications");
    expect(notifiedEvents.map((event) => event.sequence)).toEqual([1n, 2n]);
    await subscription.close();
  });

  test.each([
    ["host", "host-absent"],
    ["player", "participant-absent"],
  ] as const)(
    "persists the required pause when the %s disconnect grace expires",
    async (role, expectedPauseReason) => {
      let now = new Date("2026-07-17T14:00:00.000Z");
      const connection = await connectWithRoundCommands(() => now);
      const base = createLobbyState();
      const state: DurableLobbyState = {
        ...base,
        round: {
          ...base.round!,
          stage: role === "host" ? "paused" : "active",
          pausedAt: role === "host" ? new Date("2026-07-17T13:59:00.000Z") : null,
          pauseReason: role === "host" ? "participant-absent" : null,
          nextCallAt: role === "host" ? null : new Date("2026-07-17T14:00:30.000Z"),
          coWinnerTriggeringCallId: null,
          coWinnerOpenedAt: null,
          coWinnerClosesAt: null,
          resultSettledAt: null,
          endedAt: null,
          coWinners: [],
        },
      };
      await createPersistedLobby(connection, state);
      const participant = state.participants.find((candidate) => candidate.role === role)!;
      const session = state.sessions.find(
        (candidate) => candidate.participantId === participant.id,
      )!;
      const identity = {
        lobbyId: state.lobby.id,
        participantId: participant.id,
        participantSessionId: session.id,
      };

      const grace = await connection.lobbyStates.unregisterRealtimeConnection({
        ...identity,
        presenceGeneration: 1,
        reconnectWindowSeconds: 120,
        disconnectPauseGraceSeconds: 10,
      });
      expect(grace).toEqual({
        lobbyId: state.lobby.id,
        participantId: participant.id,
        presenceGeneration: 1,
        graceEndsAt: new Date("2026-07-17T14:00:10.000Z"),
      });
      await expect(
        connection.lobbyStates.findRealtimePresenceGracePeriods(),
      ).resolves.toContainEqual(grace);

      now = new Date("2026-07-17T14:00:09.999Z");
      await expect(connection.lobbyStates.expireRealtimePresenceGrace(grace!)).resolves.toBe(
        "too-early",
      );
      expect((await connection.lobbyStates.findById(state.lobby.id))?.round).toMatchObject({
        stage: role === "host" ? "paused" : "active",
        pauseReason: role === "host" ? "participant-absent" : null,
      });

      now = new Date("2026-07-17T14:00:10.000Z");
      await expect(connection.lobbyStates.expireRealtimePresenceGrace(grace!)).resolves.toBe(
        "expired",
      );
      const expired = await connection.lobbyStates.findById(state.lobby.id);
      expect(
        expired?.presenceGenerations
          .filter(({ participantId }) => participantId === participant.id)
          .at(-1),
      ).toMatchObject({
        generation: 1n,
        status: "absent",
        connectionCount: 0,
        graceEndsAt: null,
        absentSince: now,
      });
      expect(expired?.round).toMatchObject({
        stage: "paused",
        pausedAt: now,
        pauseReason: expectedPauseReason,
        nextCallAt: null,
      });
      expect(expired?.events.slice(-2)).toMatchObject([
        {
          eventType: "presence",
          payload: {
            presence: {
              participantId: participant.id,
              generation: 1,
              status: "absent",
              changedAt: now.toISOString(),
              absentSince: now.toISOString(),
              overridden: false,
            },
          },
        },
        {
          eventType: "stage",
          payload: {
            round: { stage: "paused", pauseReason: expectedPauseReason },
          },
        },
      ]);
      expect(expired?.events.at(-1)?.sequence).toBe(expired!.events.at(-2)!.sequence + 1n);
      for (const event of expired!.events.slice(-2)) {
        expect(() =>
          ActiveLobbyEventSchema.parse({
            ...event.payload,
            schemaVersion: event.schemaVersion,
            type: event.eventType,
            eventSequence: Number(event.sequence),
            occurredAt: event.createdAt.toISOString(),
          }),
        ).not.toThrow();
      }

      const host = state.participants.find((candidate) => candidate.role === "host")!;
      const hostSession = state.sessions.find((candidate) => candidate.participantId === host.id)!;
      const executeResume = (commandId: string) =>
        connection.roundCommands.executeAuthenticated({
          lobbyId: state.lobby.id,
          participantId: host.id,
          participantSessionId: hostSession.id,
          command: ResumeRoundCommandSchema.parse({
            schemaVersion: 1,
            type: "resume-round",
            commandId,
          }),
        });
      if (role === "player") {
        await expect(executeResume(`resume-while-absent-${randomUUID()}`)).resolves.toMatchObject({
          ok: false,
          error: { code: "INVALID_COMMAND" },
        });
      }

      now = new Date("2026-07-17T14:00:11.000Z");
      await expect(connection.lobbyStates.registerRealtimeConnection(identity)).resolves.toBe(2);
      const reconnected = await connection.lobbyStates.findById(state.lobby.id);
      expect(
        reconnected?.presenceGenerations
          .filter(({ participantId }) => participant.id === participantId)
          .at(-1),
      ).toMatchObject({ generation: 2n, status: "connected" });
      expect(reconnected?.round).toMatchObject({
        stage: "paused",
        pauseReason: expectedPauseReason,
      });
      await expect(connection.lobbyStates.expireRealtimePresenceGrace(grace!)).resolves.toBe(
        "stale",
      );
      await expect(executeResume(`resume-after-reconnect-${randomUUID()}`)).resolves.toMatchObject({
        ok: true,
      });
      expect((await connection.lobbyStates.findById(state.lobby.id))?.round).toMatchObject({
        stage: "active",
        pauseReason: null,
      });
    },
  );

  test("overrides only the requested current player absence without resuming calls", async () => {
    let now = new Date("2026-07-17T14:30:00.000Z");
    const connection = await connectWithRoundCommands(() => now);
    const base = createLobbyState();
    const state: DurableLobbyState = {
      ...base,
      round: {
        ...base.round!,
        stage: "active",
        pausedAt: null,
        pauseReason: null,
        nextCallAt: new Date("2026-07-17T14:30:30.000Z"),
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        endedAt: null,
        coWinners: [],
      },
    };
    await createPersistedLobby(connection, state);
    const host = state.participants.find(({ role }) => role === "host")!;
    const player = state.participants.find(({ role }) => role === "player")!;
    const hostSession = state.sessions.find(({ participantId }) => participantId === host.id)!;
    const playerSession = state.sessions.find(({ participantId }) => participantId === player.id)!;
    const playerIdentity = {
      lobbyId: state.lobby.id,
      participantId: player.id,
      participantSessionId: playerSession.id,
    };
    const grace = await connection.lobbyStates.unregisterRealtimeConnection({
      ...playerIdentity,
      presenceGeneration: 1,
      reconnectWindowSeconds: 120,
      disconnectPauseGraceSeconds: 10,
    });
    now = grace!.graceEndsAt;
    await expect(connection.lobbyStates.expireRealtimePresenceGrace(grace!)).resolves.toBe(
      "expired",
    );

    now = new Date("2026-07-17T14:30:11.000Z");
    const command = OverrideAbsenceCommandSchema.parse({
      schemaVersion: 1,
      type: "override-absence",
      commandId: `override-player-${randomUUID()}`,
      participantId: player.id,
      presenceGeneration: 1,
    });
    const executeOverride = () =>
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: host.id,
        participantSessionId: hostSession.id,
        command,
      });
    const committed = await executeOverride();
    const replayed = await executeOverride();
    let restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(committed).toMatchObject({
      ok: true,
      acknowledgement: {
        commandId: command.commandId,
        scope: "active-lobby",
        idempotentReplay: false,
      },
      activeLobbyEvent: {
        type: "presence",
        occurredAt: now.toISOString(),
        presence: {
          participantId: player.id,
          generation: 1,
          status: "absent",
          changedAt: now.toISOString(),
          absentSince: grace!.graceEndsAt.toISOString(),
          overridden: true,
        },
      },
    });
    expect(replayed).toMatchObject({
      ok: true,
      acknowledgement: { idempotentReplay: true },
      activeLobbyEvent: null,
    });
    expect(
      restored?.presenceGenerations
        .filter(({ participantId }) => participantId === player.id)
        .at(-1),
    ).toMatchObject({
      generation: 1n,
      status: "absent",
      changedAt: now,
      absentSince: grace!.graceEndsAt,
      overridden: true,
    });
    expect(restored?.round).toMatchObject({
      stage: "paused",
      pausedAt: grace!.graceEndsAt,
      pauseReason: "participant-absent",
      nextCallAt: null,
    });
    expect(restored?.events.at(-1)).toMatchObject({
      roundId: null,
      eventType: "presence",
      payload: {
        presence: {
          participantId: player.id,
          generation: 1,
          status: "absent",
          overridden: true,
        },
      },
    });

    now = new Date("2026-07-17T14:30:12.000Z");
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: host.id,
        participantSessionId: hostSession.id,
        command: ResumeRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "resume-round",
          commandId: `resume-overridden-${randomUUID()}`,
        }),
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(connection.lobbyStates.registerRealtimeConnection(playerIdentity)).resolves.toBe(
      2,
    );
    const secondGrace = await connection.lobbyStates.unregisterRealtimeConnection({
      ...playerIdentity,
      presenceGeneration: 2,
      reconnectWindowSeconds: 120,
      disconnectPauseGraceSeconds: 10,
    });
    now = secondGrace!.graceEndsAt;
    await expect(connection.lobbyStates.expireRealtimePresenceGrace(secondGrace!)).resolves.toBe(
      "expired",
    );

    const staleOverride = OverrideAbsenceCommandSchema.parse({
      ...command,
      commandId: `override-stale-${randomUUID()}`,
    });
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: host.id,
        participantSessionId: hostSession.id,
        command: staleOverride,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_COMMAND" } });
    restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(
      restored?.presenceGenerations
        .filter(({ participantId }) => participantId === player.id)
        .at(-1),
    ).toMatchObject({ generation: 2n, status: "absent", overridden: false });
    expect(restored?.round).toMatchObject({
      stage: "paused",
      pauseReason: "participant-absent",
    });
  });

  test("rejects player-issued and host-targeted absence overrides without mutation", async () => {
    const now = new Date("2026-07-17T14:35:00.000Z");
    const connection = await connectWithRoundCommands(() => now);
    const base = createLobbyState();
    const host = base.participants.find(({ role }) => role === "host")!;
    const player = base.participants.find(({ role }) => role === "player")!;
    const secondPlayerId = `participant-second-player-${randomUUID()}`;
    const secondPlayerSessionId = `session-second-player-${randomUUID()}`;
    const state: DurableLobbyState = {
      ...base,
      participants: [
        ...base.participants,
        {
          id: secondPlayerId,
          username: "Second Guest",
          normalizedUsername: "second guest",
          role: "player",
          roundEligibility: "waiting",
          joinedAt: now,
          departedAt: null,
        },
      ],
      sessions: [
        ...base.sessions,
        {
          id: secondPlayerSessionId,
          participantId: secondPlayerId,
          tokenHash: new Uint8Array(randomBytes(32)),
          status: "active",
          issuedAt: now,
          disconnectedAt: null,
          rejoinUntil: null,
          departedAt: null,
        },
      ],
      presenceGenerations: [
        ...base.presenceGenerations.map((presence) =>
          presence.participantId === host.id || presence.participantId === player.id
            ? {
                ...presence,
                status: "absent" as const,
                connectionCount: 0,
                changedAt: now,
                absentSince: now,
                overridden: false,
              }
            : presence,
        ),
        {
          participantId: secondPlayerId,
          generation: 1n,
          status: "connected",
          connectionCount: 1,
          changedAt: now,
          graceEndsAt: null,
          absentSince: null,
          departedAt: null,
          overridden: false,
          endedAt: null,
        },
      ],
      round: {
        ...base.round!,
        stage: "paused",
        pausedAt: now,
        pauseReason: "host-absent",
      },
    };
    await createPersistedLobby(connection, state);
    const hostSession = state.sessions.find(({ participantId }) => participantId === host.id)!;
    const playerCommand = OverrideAbsenceCommandSchema.parse({
      schemaVersion: 1,
      type: "override-absence",
      commandId: `player-override-${randomUUID()}`,
      participantId: player.id,
      presenceGeneration: 1,
    });

    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: secondPlayerId,
        participantSessionId: secondPlayerSessionId,
        command: playerCommand,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: host.id,
        participantSessionId: hostSession.id,
        command: OverrideAbsenceCommandSchema.parse({
          ...playerCommand,
          commandId: `host-override-self-${randomUUID()}`,
          participantId: host.id,
        }),
      }),
    ).resolves.toEqual({ ok: false, error: { code: "INVALID_COMMAND" } });
    const restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(
      restored?.presenceGenerations.filter(({ participantId }) => participantId === host.id).at(-1),
    ).toMatchObject({ status: "absent", overridden: false });
    expect(restored?.round).toMatchObject({ stage: "paused", pauseReason: "host-absent" });
    expect(restored?.events).toEqual(state.events);
    expect(restored?.commandResults).toEqual(state.commandResults);
  });

  test("expires a player at the rejoin deadline before attempting an absence override", async () => {
    let now = new Date("2026-07-17T14:40:00.000Z");
    const connection = await connectWithRoundCommands(() => now);
    const base = createLobbyState();
    const state: DurableLobbyState = {
      ...base,
      round: {
        ...base.round!,
        stage: "active",
        pausedAt: null,
        pauseReason: null,
        nextCallAt: new Date("2026-07-17T14:40:30.000Z"),
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        endedAt: null,
        coWinners: [],
      },
    };
    await createPersistedLobby(connection, state);
    const host = state.participants.find(({ role }) => role === "host")!;
    const player = state.participants.find(({ role }) => role === "player")!;
    const hostSession = state.sessions.find(({ participantId }) => participantId === host.id)!;
    const playerSession = state.sessions.find(({ participantId }) => participantId === player.id)!;
    const grace = await connection.lobbyStates.unregisterRealtimeConnection({
      lobbyId: state.lobby.id,
      participantId: player.id,
      participantSessionId: playerSession.id,
      presenceGeneration: 1,
      reconnectWindowSeconds: 120,
      disconnectPauseGraceSeconds: 10,
    });
    now = grace!.graceEndsAt;
    await expect(connection.lobbyStates.expireRealtimePresenceGrace(grace!)).resolves.toBe(
      "expired",
    );
    const before = await connection.lobbyStates.findById(state.lobby.id);
    const rejoinUntil = before?.sessions.find(({ id }) => id === playerSession.id)?.rejoinUntil;
    expect(rejoinUntil).not.toBeNull();
    expect(rejoinUntil).not.toBeUndefined();
    now = rejoinUntil!;

    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: host.id,
        participantSessionId: hostSession.id,
        command: OverrideAbsenceCommandSchema.parse({
          schemaVersion: 1,
          type: "override-absence",
          commandId: `override-expired-${randomUUID()}`,
          participantId: player.id,
          presenceGeneration: 1,
        }),
      }),
    ).resolves.toEqual({ ok: false, error: { code: "INVALID_COMMAND" } });
    const restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.participants.find(({ id }) => id === player.id)?.departedAt).toEqual(
      rejoinUntil,
    );
    expect(restored?.sessions.find(({ id }) => id === playerSession.id)).toMatchObject({
      status: "departed",
      departedAt: rejoinUntil,
    });
    expect(
      restored?.presenceGenerations
        .filter(({ participantId }) => participantId === player.id)
        .at(-1),
    ).toMatchObject({ status: "departed", overridden: false, endedAt: null });
    expect(restored?.events).toEqual(before?.events);
    expect(restored?.commandResults).toEqual(before?.commandResults);
  });

  test.each(["override-first", "reconnect-first"] as const)(
    "serializes absence override and reconnect with %s lock ordering",
    async (order) => {
      let now = new Date("2026-07-17T14:45:00.000Z");
      const setupConnection = await connectWithRoundCommands(() => now);
      const overrideConnection = await connectWithRoundCommands(() => now);
      const reconnectConnection = await connectWithRoundCommands(() => now);
      const base = createLobbyState();
      const state: DurableLobbyState = {
        ...base,
        round: {
          ...base.round!,
          stage: "active",
          pausedAt: null,
          pauseReason: null,
          nextCallAt: new Date("2026-07-17T14:45:30.000Z"),
          coWinnerTriggeringCallId: null,
          coWinnerOpenedAt: null,
          coWinnerClosesAt: null,
          resultSettledAt: null,
          endedAt: null,
          coWinners: [],
        },
      };
      await createPersistedLobby(setupConnection, state);
      const host = state.participants.find(({ role }) => role === "host")!;
      const player = state.participants.find(({ role }) => role === "player")!;
      const hostSession = state.sessions.find(({ participantId }) => participantId === host.id)!;
      const playerSession = state.sessions.find(
        ({ participantId }) => participantId === player.id,
      )!;
      const playerIdentity = {
        lobbyId: state.lobby.id,
        participantId: player.id,
        participantSessionId: playerSession.id,
      };
      const grace = await setupConnection.lobbyStates.unregisterRealtimeConnection({
        ...playerIdentity,
        presenceGeneration: 1,
        reconnectWindowSeconds: 120,
        disconnectPauseGraceSeconds: 10,
      });
      now = grace!.graceEndsAt;
      await setupConnection.lobbyStates.expireRealtimePresenceGrace(grace!);
      now = new Date("2026-07-17T14:45:11.000Z");
      const command = OverrideAbsenceCommandSchema.parse({
        schemaVersion: 1,
        type: "override-absence",
        commandId: `override-race-${order}-${randomUUID()}`,
        participantId: player.id,
        presenceGeneration: 1,
      });
      const override = () =>
        overrideConnection.roundCommands.executeAuthenticated({
          lobbyId: state.lobby.id,
          participantId: host.id,
          participantSessionId: hostSession.id,
          command,
        });
      const reconnect = () =>
        reconnectConnection.lobbyStates.registerRealtimeConnection(playerIdentity);
      const blocker = await pool.connect();
      let transactionOpen = false;
      const operations: Promise<unknown>[] = [];
      try {
        await blocker.query("BEGIN");
        transactionOpen = true;
        await blocker.query(`SELECT id FROM lobbies WHERE id = $1 FOR UPDATE`, [state.lobby.id]);
        operations.push(order === "override-first" ? override() : reconnect());
        await waitForBlockedCommandFences(1);
        operations.push(order === "override-first" ? reconnect() : override());
        await waitForBlockedCommandFences(2);
        await blocker.query("ROLLBACK");
        transactionOpen = false;
        const results = await Promise.all(operations);
        expect(results).toEqual(
          order === "override-first"
            ? [expect.objectContaining({ ok: true }), 2]
            : [2, expect.objectContaining({ ok: false, error: { code: "INVALID_COMMAND" } })],
        );
      } finally {
        if (transactionOpen) await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        await Promise.allSettled(operations);
      }

      const restored = await setupConnection.lobbyStates.findById(state.lobby.id);
      const generations = restored?.presenceGenerations.filter(
        ({ participantId }) => participantId === player.id,
      );
      expect(generations).toHaveLength(2);
      expect(generations?.[0]).toMatchObject({
        generation: 1n,
        status: "absent",
        overridden: order === "override-first",
        endedAt: now,
      });
      expect(generations?.[1]).toMatchObject({
        generation: 2n,
        status: "connected",
        overridden: false,
        endedAt: null,
      });
      const newEvents = restored?.events.slice(4) ?? [];
      expect(newEvents.map(({ eventType }) => eventType)).toEqual(
        order === "override-first" ? ["presence", "presence"] : ["presence"],
      );
      expect(newEvents.map(({ sequence }) => sequence)).toEqual(
        order === "override-first" ? [5n, 6n] : [5n],
      );
      expect(newEvents.at(-1)?.payload).toMatchObject({
        presence: { participantId: player.id, generation: 2, status: "connected" },
      });
      expect(
        restored?.commandResults.filter(({ commandId }) => commandId === command.commandId),
      ).toHaveLength(order === "override-first" ? 1 : 0);
    },
  );

  test("preserves host-absence precedence when a player grace expires later", async () => {
    let now = new Date("2026-07-17T14:05:00.000Z");
    const connection = await connectWithRoundCommands(() => now);
    const base = createLobbyState();
    const hostPausedAt = new Date("2026-07-17T14:04:00.000Z");
    const state: DurableLobbyState = {
      ...base,
      round: {
        ...base.round!,
        stage: "paused",
        pausedAt: hostPausedAt,
        pauseReason: "host-absent",
        nextCallAt: null,
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        endedAt: null,
        coWinners: [],
      },
    };
    await createPersistedLobby(connection, state);
    const player = state.participants.find(({ role }) => role === "player")!;
    const playerSession = state.sessions.find(({ participantId }) => participantId === player.id)!;
    const grace = await connection.lobbyStates.unregisterRealtimeConnection({
      lobbyId: state.lobby.id,
      participantId: player.id,
      participantSessionId: playerSession.id,
      presenceGeneration: 1,
      reconnectWindowSeconds: 120,
      disconnectPauseGraceSeconds: 10,
    });
    const eventsBeforeExpiry = (await connection.lobbyStates.findById(state.lobby.id))!.events
      .length;

    now = grace!.graceEndsAt;
    await expect(connection.lobbyStates.expireRealtimePresenceGrace(grace!)).resolves.toBe(
      "expired",
    );

    const expired = await connection.lobbyStates.findById(state.lobby.id);
    expect(expired?.round).toMatchObject({
      stage: "paused",
      pauseReason: "host-absent",
      pausedAt: hostPausedAt,
      nextCallAt: null,
    });
    expect(expired?.events.slice(eventsBeforeExpiry)).toMatchObject([
      {
        eventType: "presence",
        payload: {
          presence: { participantId: player.id, status: "absent" },
        },
      },
    ]);
  });

  test("blocks resume when grace expires during a manual pause", async () => {
    let now = new Date("2026-07-17T14:10:00.000Z");
    const connection = await connectWithRoundCommands(() => now);
    const base = createLobbyState();
    const state: DurableLobbyState = {
      ...base,
      round: {
        ...base.round!,
        stage: "paused",
        pausedAt: new Date("2026-07-17T14:09:00.000Z"),
        pauseReason: "host-command",
        nextCallAt: null,
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        endedAt: null,
        coWinners: [],
      },
    };
    await createPersistedLobby(connection, state);
    const host = state.participants.find(({ role }) => role === "host")!;
    const player = state.participants.find(({ role }) => role === "player")!;
    const hostSession = state.sessions.find(({ participantId }) => participantId === host.id)!;
    const playerSession = state.sessions.find(({ participantId }) => participantId === player.id)!;
    const grace = await connection.lobbyStates.unregisterRealtimeConnection({
      lobbyId: state.lobby.id,
      participantId: player.id,
      participantSessionId: playerSession.id,
      presenceGeneration: 1,
      reconnectWindowSeconds: 120,
      disconnectPauseGraceSeconds: 10,
    });
    now = new Date("2026-07-17T14:10:10.000Z");
    await expect(connection.lobbyStates.expireRealtimePresenceGrace(grace!)).resolves.toBe(
      "expired",
    );

    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: host.id,
        participantSessionId: hostSession.id,
        command: ResumeRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "resume-round",
          commandId: `resume-manual-absence-${randomUUID()}`,
        }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_COMMAND" } });
    expect((await connection.lobbyStates.findById(state.lobby.id))?.round).toMatchObject({
      stage: "paused",
      pauseReason: "host-command",
    });
  });

  test.each(["command-first", "expiry-first"] as const)(
    "rejects call-next at the grace deadline with %s lock ordering",
    async (order) => {
      let now = new Date("2026-07-17T14:20:00.000Z");
      const setupConnection = await connectWithRoundCommands(() => now);
      const commandConnection = await connectWithRoundCommands(() => now);
      const expiryConnection = await connectWithLifecycleClock(() => now);
      const base = createLobbyState();
      const state: DurableLobbyState = {
        ...base,
        round: {
          ...base.round!,
          stage: "active",
          pausedAt: null,
          pauseReason: null,
          nextCallAt: new Date("2026-07-17T14:20:30.000Z"),
          coWinnerTriggeringCallId: null,
          coWinnerOpenedAt: null,
          coWinnerClosesAt: null,
          resultSettledAt: null,
          endedAt: null,
          coWinners: [],
        },
      };
      await createPersistedLobby(setupConnection, state);
      const host = state.participants.find(({ role }) => role === "host")!;
      const player = state.participants.find(({ role }) => role === "player")!;
      const hostSession = state.sessions.find(({ participantId }) => participantId === host.id)!;
      const playerSession = state.sessions.find(
        ({ participantId }) => participantId === player.id,
      )!;
      const grace = await setupConnection.lobbyStates.unregisterRealtimeConnection({
        lobbyId: state.lobby.id,
        participantId: player.id,
        participantSessionId: playerSession.id,
        presenceGeneration: 1,
        reconnectWindowSeconds: 120,
        disconnectPauseGraceSeconds: 10,
      });
      now = grace!.graceEndsAt;
      const command = () =>
        commandConnection.roundCommands.executeAuthenticated({
          lobbyId: state.lobby.id,
          participantId: host.id,
          participantSessionId: hostSession.id,
          command: CallNextCommandSchema.parse({
            schemaVersion: 1,
            type: "call-next",
            commandId: `call-at-grace-${order}-${randomUUID()}`,
          }),
        });
      const expiry = () => expiryConnection.lobbyStates.expireRealtimePresenceGrace(grace!);
      const blocker = await pool.connect();
      let transactionOpen = false;
      const operations: Promise<unknown>[] = [];
      try {
        await blocker.query("BEGIN");
        transactionOpen = true;
        await blocker.query(`SELECT id FROM lobbies WHERE id = $1 FOR UPDATE`, [state.lobby.id]);
        operations.push(order === "command-first" ? command() : expiry());
        await waitForBlockedCommandFences(1);
        operations.push(order === "command-first" ? expiry() : command());
        await waitForBlockedCommandFences(2);
        await blocker.query("ROLLBACK");
        transactionOpen = false;
        const results = await Promise.all(operations);
        expect(results).toEqual(
          order === "command-first"
            ? [
                expect.objectContaining({ ok: false, error: { code: "INVALID_COMMAND" } }),
                "expired",
              ]
            : [
                "expired",
                expect.objectContaining({ ok: false, error: { code: "INVALID_COMMAND" } }),
              ],
        );
      } finally {
        if (transactionOpen) await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        await Promise.allSettled(operations);
      }
      const persisted = await setupConnection.lobbyStates.findById(state.lobby.id);
      expect(persisted?.round).toMatchObject({
        stage: "paused",
        pauseReason: "participant-absent",
      });
      expect(persisted?.round?.calls).toHaveLength(state.round!.calls.length);
    },
  );

  test("ignores stale disconnect cleanup after the session reconnects", async () => {
    let now = new Date("2026-07-17T12:50:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const suffix = randomUUID();
    const lobbyId = `lobby-stale-presence-${suffix}`;
    const participantId = `participant-stale-presence-${suffix}`;
    const participantSessionId = `session-stale-presence-${suffix}`;
    const created = await connection.lobbyStates.createLobbyWithHost({
      lobbyId,
      participantId,
      sessionId: participantSessionId,
      commandId: `command-stale-presence-${suffix}`,
      username: `Stale Presence ${suffix}`,
      themeId: "classic",
      tokenHash: new Uint8Array(randomBytes(32)),
      issuedAt: new Date("2026-07-17T12:49:00.000Z"),
      maxActiveLobbies: Number.MAX_SAFE_INTEGER,
      nextCode: randomLobbyCode,
    });
    expect(created.ok).toBe(true);
    const identity = { lobbyId, participantId, participantSessionId };
    const firstGeneration = await connection.lobbyStates.registerRealtimeConnection(identity);
    expect(firstGeneration).toBe(2);
    await connection.lobbyStates.unregisterRealtimeConnection({
      ...identity,
      presenceGeneration: firstGeneration!,
      reconnectWindowSeconds: 120,
      disconnectPauseGraceSeconds: 10,
    });

    now = new Date("2026-07-17T12:51:00.000Z");
    await expect(connection.lobbyStates.registerRealtimeConnection(identity)).resolves.toBe(3);
    await expect(
      connection.lobbyStates.unregisterRealtimeConnection({
        ...identity,
        presenceGeneration: firstGeneration!,
        reconnectWindowSeconds: 120,
        disconnectPauseGraceSeconds: 10,
      }),
    ).resolves.toBeNull();

    const restored = await connection.lobbyStates.findById(lobbyId);
    expect(restored?.presenceGenerations.at(-1)).toMatchObject({
      generation: 3n,
      status: "connected",
      connectionCount: 1,
    });
    expect(restored?.sessions[0]).toMatchObject({
      status: "active",
      disconnectedAt: null,
      rejoinUntil: null,
    });
  });

  test.each(["disconnect-first", "register-first"] as const)(
    "serializes a realtime connection handoff with %s lock ordering",
    async (order) => {
      const now = new Date("2026-07-17T12:55:00.000Z");
      const setupConnection = await connectWithLifecycleClock(() => now);
      const disconnectConnection = await connectWithLifecycleClock(() => now);
      const registerConnection = await connectWithLifecycleClock(() => now);
      const suffix = randomUUID();
      const lobbyId = `lobby-presence-handoff-${suffix}`;
      const participantId = `participant-presence-handoff-${suffix}`;
      const participantSessionId = `session-presence-handoff-${suffix}`;
      const sessionTokenHash = new Uint8Array(randomBytes(32));
      const outstandingTicketHash = new Uint8Array(randomBytes(32));
      const created = await setupConnection.lobbyStates.createLobbyWithHost({
        lobbyId,
        participantId,
        sessionId: participantSessionId,
        commandId: `command-presence-handoff-${suffix}`,
        username: `Presence Handoff ${suffix}`,
        themeId: "classic",
        tokenHash: sessionTokenHash,
        issuedAt: new Date("2026-07-17T12:54:00.000Z"),
        maxActiveLobbies: Number.MAX_SAFE_INTEGER,
        nextCode: randomLobbyCode,
      });
      expect(created.ok).toBe(true);
      const identity = { lobbyId, participantId, participantSessionId };
      await expect(setupConnection.lobbyStates.registerRealtimeConnection(identity)).resolves.toBe(
        2,
      );
      await expect(
        setupConnection.lobbyStates.issueRealtimeTicket({
          lobbyId,
          sessionTokenHash,
          ticketHash: outstandingTicketHash,
          ttlSeconds: 60,
        }),
      ).resolves.toMatchObject({ ok: true });

      const disconnect = () =>
        disconnectConnection.lobbyStates.unregisterRealtimeConnection({
          ...identity,
          presenceGeneration: 2,
          reconnectWindowSeconds: 120,
          disconnectPauseGraceSeconds: 10,
        });
      const register = () => registerConnection.lobbyStates.registerRealtimeConnection(identity);
      const blocker = await pool.connect();
      let transactionOpen = false;
      const operations: Promise<unknown>[] = [];
      try {
        await blocker.query("BEGIN");
        transactionOpen = true;
        await blocker.query(`SELECT id FROM lobbies WHERE id = $1 FOR UPDATE`, [lobbyId]);

        operations.push(order === "disconnect-first" ? disconnect() : register());
        await waitForBlockedCommandFences(1);
        operations.push(order === "disconnect-first" ? register() : disconnect());
        await waitForBlockedCommandFences(2);

        await blocker.query("ROLLBACK");
        transactionOpen = false;
        await expect(Promise.all(operations)).resolves.toEqual(
          order === "disconnect-first"
            ? [
                {
                  lobbyId,
                  participantId,
                  presenceGeneration: 2,
                  graceEndsAt: new Date("2026-07-17T12:55:10.000Z"),
                },
                3,
              ]
            : [2, null],
        );
      } finally {
        if (transactionOpen) await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        await Promise.allSettled(operations);
      }

      const state = await setupConnection.lobbyStates.findById(lobbyId);
      expect(state?.sessions.find(({ id }) => id === participantSessionId)).toMatchObject({
        status: "active",
        disconnectedAt: null,
        rejoinUntil: null,
      });
      expect(state?.presenceGenerations.at(-1)).toMatchObject({
        generation: order === "disconnect-first" ? 3n : 2n,
        status: "connected",
        connectionCount: 1,
      });
      expect(
        state?.events
          .filter(({ eventType }) => eventType === "presence")
          .map(({ payload }) => (payload["presence"] as { status: string }).status),
      ).toEqual(order === "disconnect-first" ? ["connected", "grace", "connected"] : ["connected"]);
      await expect(
        setupConnection.lobbyStates.consumeRealtimeTicket({ ticketHash: outstandingTicketHash }),
      ).resolves.toEqual(order === "disconnect-first" ? null : identity);
    },
  );

  test.each(["departed-first", "active-first"] as const)(
    "disconnects the canonical session when sibling tabs close %s",
    async (closeOrder) => {
      let now = new Date("2026-07-17T13:00:00.000Z");
      const connection = await connectWithLifecycleClock(() => now);
      const suffix = randomUUID();
      const lobbyId = `lobby-sibling-presence-${suffix}`;
      const participantId = `participant-sibling-presence-${suffix}`;
      const firstSessionId = `session-sibling-first-${suffix}`;
      const secondSessionId = `session-sibling-second-${suffix}`;
      const secondTokenHash = new Uint8Array(randomBytes(32));
      const outstandingTicketHash = new Uint8Array(randomBytes(32));
      const created = await connection.lobbyStates.createLobbyWithHost({
        lobbyId,
        participantId,
        sessionId: firstSessionId,
        commandId: `command-sibling-presence-${suffix}`,
        username: `Sibling Presence ${suffix}`,
        themeId: "classic",
        tokenHash: new Uint8Array(randomBytes(32)),
        issuedAt: new Date("2026-07-17T12:59:00.000Z"),
        maxActiveLobbies: Number.MAX_SAFE_INTEGER,
        nextCode: randomLobbyCode,
      });
      expect(created.ok).toBe(true);
      await expect(
        connection.lobbyStates.registerRealtimeConnection({
          lobbyId,
          participantId,
          participantSessionId: firstSessionId,
        }),
      ).resolves.toBe(2);
      await expect(
        connection.lobbyStates.createParticipantSession({
          id: secondSessionId,
          lobbyId,
          participantId,
          tokenHash: secondTokenHash,
          issuedAt: new Date("2026-07-17T12:59:30.000Z"),
        }),
      ).resolves.toBe("created");
      await expect(
        connection.lobbyStates.registerRealtimeConnection({
          lobbyId,
          participantId,
          participantSessionId: secondSessionId,
        }),
      ).resolves.toBe(2);

      let state = await connection.lobbyStates.findById(lobbyId);
      expect(state?.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: firstSessionId, status: "departed", departedAt: now }),
          expect.objectContaining({ id: secondSessionId, status: "active" }),
        ]),
      );
      expect(state?.presenceGenerations.at(-1)).toMatchObject({
        generation: 2n,
        status: "connected",
        connectionCount: 2,
      });
      await expect(
        connection.lobbyStates.issueRealtimeTicket({
          lobbyId,
          sessionTokenHash: secondTokenHash,
          ticketHash: outstandingTicketHash,
          ttlSeconds: 60,
        }),
      ).resolves.toMatchObject({ ok: true });

      const firstClosingSessionId =
        closeOrder === "departed-first" ? firstSessionId : secondSessionId;
      const finalClosingSessionId =
        closeOrder === "departed-first" ? secondSessionId : firstSessionId;
      now = new Date("2026-07-17T13:01:00.000Z");
      await connection.lobbyStates.unregisterRealtimeConnection({
        lobbyId,
        participantId,
        participantSessionId: firstClosingSessionId,
        presenceGeneration: 2,
        reconnectWindowSeconds: 120,
        disconnectPauseGraceSeconds: 10,
      });
      state = await connection.lobbyStates.findById(lobbyId);
      expect(state?.sessions.find(({ id }) => id === secondSessionId)?.status).toBe("active");
      expect(state?.presenceGenerations.at(-1)).toMatchObject({
        status: "connected",
        connectionCount: 1,
      });

      now = new Date("2026-07-17T13:02:00.000Z");
      await connection.lobbyStates.unregisterRealtimeConnection({
        lobbyId,
        participantId,
        participantSessionId: finalClosingSessionId,
        presenceGeneration: 2,
        reconnectWindowSeconds: 120,
        disconnectPauseGraceSeconds: 10,
      });
      state = await connection.lobbyStates.findById(lobbyId);
      expect(state?.sessions.find(({ id }) => id === secondSessionId)).toMatchObject({
        status: "disconnected",
        disconnectedAt: now,
        rejoinUntil: new Date("2026-07-17T13:04:00.000Z"),
      });
      expect(state?.presenceGenerations.at(-1)).toMatchObject({
        status: "grace",
        connectionCount: 0,
        graceEndsAt: new Date("2026-07-17T13:02:10.000Z"),
      });
      await expect(
        connection.lobbyStates.consumeRealtimeTicket({ ticketHash: outstandingTicketHash }),
      ).resolves.toBeNull();
    },
  );

  test("heartbeats revalidate identity without inflating durable presence", async () => {
    let now = new Date("2026-07-17T12:40:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[0]!;
    const identity = {
      lobbyId: state.lobby.id,
      participantId: session.participantId,
      participantSessionId: session.id,
    };
    const before = await connection.lobbyStates.findById(state.lobby.id);

    now = new Date("2026-07-17T12:41:00.000Z");
    await expect(connection.lobbyStates.recordRealtimeHeartbeat(identity)).resolves.toBe(true);
    await expect(
      connection.lobbyStates.recordRealtimeHeartbeat({
        ...identity,
        participantSessionId: `wrong-${session.id}`,
      }),
    ).resolves.toBe(false);

    const after = await connection.lobbyStates.findById(state.lobby.id);
    expect(after?.presenceGenerations).toEqual(before?.presenceGenerations);
    expect(after?.lobby.lastEventSequence).toBe(before?.lobby.lastEventSequence);
    expect(after?.events).toEqual(before?.events);
  });

  test("replays lobby creation without creating another lobby or participant", async () => {
    const connection = await connect();
    const suffix = randomUUID();
    const base = {
      lobbyId: `lobby-${suffix}`,
      participantId: `participant-${suffix}`,
      sessionId: `session-${suffix}`,
      commandId: `command-${suffix}`,
      username: "Replay Host",
      themeId: "classic",
      tokenHash: new Uint8Array(randomBytes(32)),
      issuedAt: new Date("2026-07-17T12:00:00.000Z"),
      maxActiveLobbies: Number.MAX_SAFE_INTEGER,
      nextCode: () => randomLobbyCode(),
    };
    const first = await connection.lobbyStates.createLobbyWithHost(base);
    if (!first.ok) throw new Error(first.error.message);
    await pool.query(`UPDATE lobbies SET theme_id = 'changed-theme' WHERE id = $1`, [
      first.entry.lobbyId,
    ]);
    const replay = await connection.lobbyStates.createLobbyWithHost({
      ...base,
      lobbyId: `lobby-replay-${suffix}`,
      participantId: `participant-replay-${suffix}`,
      sessionId: `session-replay-${suffix}`,
      tokenHash: new Uint8Array(randomBytes(32)),
    });

    expect(replay).toMatchObject({
      ok: true,
      entry: {
        commandId: base.commandId,
        idempotentReplay: true,
        lobbyId: first.entry.lobbyId,
        participantId: first.entry.participantId,
        themeId: first.entry.themeId,
        sessionId: base.sessionId,
        issuedAt: base.issuedAt,
      },
    });
    await expect(connection.lobbyStates.findById(`lobby-replay-${suffix}`)).resolves.toBeNull();
    const stored = await connection.lobbyStates.findById(first.entry.lobbyId);
    expect(stored?.sessions).toHaveLength(1);
  });

  test("reserves lobby-unique normalized usernames", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const participant = newParticipant(state.lobby.id, "  CASE  Player ");

    await expect(
      connection.lobbyStates.reserveParticipant(participant, { maxPlayersPerLobby: 3 }),
    ).resolves.toEqual({ ok: true, participantId: participant.id });
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        {
          id: participant.id,
          username: "CASE Player",
          normalizedUsername: "case player",
          role: "player",
          roundEligibility: "waiting",
          joinedAt: participant.joinedAt,
          departedAt: null,
        },
      ]),
    });
    await expect(
      connection.lobbyStates.reserveParticipant(newParticipant(state.lobby.id, "case player"), {
        maxPlayersPerLobby: 4,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "USERNAME_TAKEN",
        message: "That username is already in use.",
      },
    });
  });

  test("admits a normalized participant and session in one transaction", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const suffix = randomUUID();
    const issuedAt = new Date("2026-07-17T12:00:00.000Z");
    const tokenHash = new Uint8Array(randomBytes(32));

    await expect(
      connection.lobbyStates.joinLobbyWithSession({
        lobbyId: state.lobby.id,
        lobbyCode: state.lobby.code,
        participantId: `participant-${suffix}`,
        sessionId: `session-${suffix}`,
        commandId: `command-${suffix}`,
        username: "  New   Player ",
        tokenHash,
        issuedAt,
        maxPlayersPerLobby: 3,
      }),
    ).resolves.toMatchObject({
      ok: true,
      entry: {
        commandId: `command-${suffix}`,
        idempotentReplay: false,
        lobbyId: state.lobby.id,
        lobbyCode: state.lobby.code,
        participantId: `participant-${suffix}`,
        username: "New Player",
        role: "player",
        roundEligibility: "waiting",
        sessionId: `session-${suffix}`,
        issuedAt,
      },
    });
    await expect(
      connection.lobbyStates.joinLobbyWithSession({
        lobbyId: state.lobby.id,
        lobbyCode: state.lobby.code,
        participantId: `participant-replay-${suffix}`,
        sessionId: `session-replay-${suffix}`,
        commandId: `command-${suffix}`,
        username: "New Player",
        tokenHash: new Uint8Array(randomBytes(32)),
        issuedAt,
        maxPlayersPerLobby: 3,
      }),
    ).resolves.toMatchObject({
      ok: true,
      entry: {
        commandId: `command-${suffix}`,
        idempotentReplay: true,
        participantId: `participant-${suffix}`,
        sessionId: `session-${suffix}`,
        issuedAt,
      },
    });
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({
          id: `participant-${suffix}`,
          username: "New Player",
          normalizedUsername: "new player",
          roundEligibility: "waiting",
        }),
      ]),
      sessions: expect.arrayContaining([
        expect.objectContaining({
          id: `session-${suffix}`,
          participantId: `participant-${suffix}`,
          tokenHash,
          status: "active",
        }),
      ]),
      presenceGenerations: expect.arrayContaining([
        expect.objectContaining({
          participantId: `participant-${suffix}`,
          generation: 1n,
          status: "absent",
          connectionCount: 0,
        }),
      ]),
    });
    expect(
      (await connection.lobbyStates.findById(state.lobby.id))?.sessions.filter(
        (session) => session.participantId === `participant-${suffix}`,
      ),
    ).toHaveLength(1);
  });

  test("rolls back participant admission when the session hash collides", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const suffix = randomUUID();

    await expect(
      connection.lobbyStates.joinLobbyWithSession({
        lobbyId: state.lobby.id,
        lobbyCode: state.lobby.code,
        participantId: `participant-${suffix}`,
        sessionId: `session-${suffix}`,
        commandId: `command-${suffix}`,
        username: "Rolled Back Player",
        tokenHash: state.sessions[0]!.tokenHash,
        issuedAt: new Date("2026-07-17T12:00:00.000Z"),
        maxPlayersPerLobby: 3,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "TOKEN_HASH_COLLISION",
        message: "The participant session credential collided.",
      },
    });
    const stored = await connection.lobbyStates.findById(state.lobby.id);
    expect(
      stored?.participants.some((participant) => participant.id === `participant-${suffix}`),
    ).toBe(false);
  });

  test("rejects a join command replay with different normalized intent", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const suffix = randomUUID();
    const input = {
      lobbyId: state.lobby.id,
      lobbyCode: state.lobby.code,
      participantId: `participant-${suffix}`,
      sessionId: `session-${suffix}`,
      commandId: `command-${suffix}`,
      username: "Original Player",
      tokenHash: new Uint8Array(randomBytes(32)),
      issuedAt: new Date("2026-07-17T12:00:00.000Z"),
      maxPlayersPerLobby: 3,
    };
    await expect(connection.lobbyStates.joinLobbyWithSession(input)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      connection.lobbyStates.joinLobbyWithSession({
        ...input,
        participantId: `participant-other-${suffix}`,
        sessionId: `session-other-${suffix}`,
        username: "Different Player",
        tokenHash: new Uint8Array(randomBytes(32)),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "COMMAND_REPLAY_MISMATCH",
        message: "The command ID was already used for different lobby entry intent.",
      },
    });
  });

  test("replays the original immutable entry after participant state changes", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const suffix = randomUUID();
    const input = {
      lobbyId: state.lobby.id,
      lobbyCode: state.lobby.code,
      participantId: `participant-${suffix}`,
      sessionId: `session-${suffix}`,
      commandId: `command-${suffix}`,
      username: "Immutable Replay",
      tokenHash: new Uint8Array(randomBytes(32)),
      issuedAt: new Date("2026-07-17T12:00:00.000Z"),
      maxPlayersPerLobby: 3,
    };
    const committed = await connection.lobbyStates.joinLobbyWithSession(input);
    if (!committed.ok) throw new Error(committed.error.message);
    await pool.query(`UPDATE participants SET round_eligibility = 'PLAYING' WHERE id = $1`, [
      committed.entry.participantId,
    ]);

    const replay = await connection.lobbyStates.joinLobbyWithSession({
      ...input,
      participantId: `participant-replay-${suffix}`,
      sessionId: `session-replay-${suffix}`,
      tokenHash: new Uint8Array(randomBytes(32)),
    });

    expect(replay).toEqual({
      ok: true,
      entry: { ...committed.entry, idempotentReplay: true },
    });
  });

  test("serializes atomic joins at normalized-name and capacity boundaries", async () => {
    const firstConnection = await connect();
    const secondConnection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(firstConnection, state);
    const issuedAt = new Date("2026-07-17T12:00:00.000Z");
    const input = (suffix: string, username: string) => ({
      lobbyId: state.lobby.id,
      lobbyCode: state.lobby.code,
      participantId: `participant-${suffix}`,
      sessionId: `session-${suffix}`,
      commandId: `command-${suffix}`,
      username,
      tokenHash: new Uint8Array(randomBytes(32)),
      issuedAt,
      maxPlayersPerLobby: 3,
    });

    const sameName = await Promise.all([
      firstConnection.lobbyStates.joinLobbyWithSession(input(randomUUID(), "Race Player")),
      secondConnection.lobbyStates.joinLobbyWithSession(input(randomUUID(), " race   player ")),
    ]);
    expect(sameName.filter((result) => result.ok)).toHaveLength(1);
    expect(sameName.filter((result) => !result.ok)).toMatchObject([
      { error: { code: "USERNAME_TAKEN" } },
    ]);

    const capacityInput = (suffix: string, username: string) => ({
      ...input(suffix, username),
      maxPlayersPerLobby: 4,
    });
    const capacity = await Promise.all([
      firstConnection.lobbyStates.joinLobbyWithSession(capacityInput(randomUUID(), "Capacity One")),
      secondConnection.lobbyStates.joinLobbyWithSession(
        capacityInput(randomUUID(), "Capacity Two"),
      ),
    ]);
    expect(capacity.filter((result) => result.ok)).toHaveLength(1);
    expect(capacity.filter((result) => !result.ok)).toMatchObject([
      { error: { code: "LOBBY_FULL" } },
    ]);
  });

  test("issues and resolves a hash-only session within one active lobby", async () => {
    const connection = await connect();
    const firstLobby = createLobbyState();
    const secondLobby = createLobbyState();
    await createPersistedLobby(connection, firstLobby);
    await createPersistedLobby(connection, secondLobby);
    const participant = newParticipant(firstLobby.lobby.id, "Session Player");
    await connection.lobbyStates.reserveParticipant(participant, { maxPlayersPerLobby: 3 });
    const tokenHash = new Uint8Array(randomBytes(32));
    const session: NewParticipantSession = {
      id: `session-${randomUUID()}`,
      lobbyId: firstLobby.lobby.id,
      participantId: participant.id,
      tokenHash,
      issuedAt: new Date("2026-07-17T08:04:00.000Z"),
    };

    await expect(connection.lobbyStates.createParticipantSession(session)).resolves.toBe("created");
    await expect(
      connection.lobbyStates.resolveParticipantSessionByTokenHash({
        lobbyId: firstLobby.lobby.id,
        tokenHash,
      }),
    ).resolves.toEqual({
      sessionId: session.id,
      lobbyId: firstLobby.lobby.id,
      participantId: participant.id,
      username: "Session Player",
      role: "player",
      status: "active",
    });
    await expect(
      connection.lobbyStates.resolveParticipantSessionByTokenHash({
        lobbyId: secondLobby.lobby.id,
        tokenHash,
      }),
    ).resolves.toBeNull();

    const stored = await connection.lobbyStates.findById(firstLobby.lobby.id);
    expect(stored?.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: session.id,
          participantId: participant.id,
          tokenHash,
          status: "active",
        }),
      ]),
    );
  });

  test("rejects session issuance outside the active lobby participant scope", async () => {
    const connection = await connect();
    const firstLobby = createLobbyState();
    const secondLobby = createLobbyState();
    await createPersistedLobby(connection, firstLobby);
    await createPersistedLobby(connection, secondLobby);
    const tokenHash = new Uint8Array(randomBytes(32));

    await expect(
      connection.lobbyStates.createParticipantSession({
        id: `session-${randomUUID()}`,
        lobbyId: firstLobby.lobby.id,
        participantId: secondLobby.participants[0]!.id,
        tokenHash,
        issuedAt: new Date("2026-07-17T08:04:00.000Z"),
      }),
    ).resolves.toBe("scope-not-found");

    await pool.query(`UPDATE lobbies SET status = 'COMPLETED' WHERE id = $1`, [
      firstLobby.lobby.id,
    ]);
    await expect(
      connection.lobbyStates.createParticipantSession({
        id: `session-${randomUUID()}`,
        lobbyId: firstLobby.lobby.id,
        participantId: firstLobby.participants[0]!.id,
        tokenHash,
        issuedAt: new Date("2026-07-17T08:04:00.000Z"),
      }),
    ).resolves.toBe("scope-not-found");
  });

  test("reports only exact token-hash uniqueness collisions", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const existing = state.sessions[0]!;

    await expect(
      connection.lobbyStates.createParticipantSession({
        id: `session-${randomUUID()}`,
        lobbyId: state.lobby.id,
        participantId: state.participants[0]!.id,
        tokenHash: existing.tokenHash,
        issuedAt: new Date("2026-07-17T08:04:00.000Z"),
      }),
    ).resolves.toBe("token-hash-collision");
    await expect(
      connection.lobbyStates.createParticipantSession({
        id: existing.id,
        lobbyId: state.lobby.id,
        participantId: state.participants[0]!.id,
        tokenHash: new Uint8Array(randomBytes(32)),
        issuedAt: new Date("2026-07-17T08:04:00.000Z"),
      }),
    ).rejects.toBeDefined();
  });

  test("issues hash-only realtime tickets from an active scoped session", async () => {
    const issuedAt = new Date("2026-07-17T12:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => issuedAt);
    const state = createLobbyState();
    const otherState = createLobbyState();
    await createPersistedLobby(connection, state);
    await createPersistedLobby(connection, otherState);
    const ticket = randomBytes(32).toString("base64url");
    const ticketHash = new Uint8Array(createHash("sha256").update(ticket, "ascii").digest());

    await expect(
      connection.lobbyStates.issueRealtimeTicket({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        ticketHash,
        ttlSeconds: 60,
      }),
    ).resolves.toEqual({ ok: true, expiresAt: new Date("2026-07-17T12:01:00.000Z") });
    const stored = await pool.query<{
      token_hash: Buffer;
      lobby_id: string;
      participant_id: string;
      participant_session_id: string;
      issued_at: Date;
      expires_at: Date;
    }>(
      `SELECT token_hash, lobby_id, participant_id, participant_session_id, issued_at, expires_at
         FROM realtime_tickets
        WHERE token_hash = $1`,
      [Buffer.from(ticketHash)],
    );
    expect(stored.rows).toEqual([
      {
        token_hash: Buffer.from(ticketHash),
        lobby_id: state.lobby.id,
        participant_id: state.sessions[0]!.participantId,
        participant_session_id: state.sessions[0]!.id,
        issued_at: issuedAt,
        expires_at: new Date("2026-07-17T12:01:00.000Z"),
      },
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(ticket);

    await expect(
      connection.lobbyStates.issueRealtimeTicket({
        lobbyId: state.lobby.id,
        sessionTokenHash: otherState.sessions[0]!.tokenHash,
        ticketHash: new Uint8Array(randomBytes(32)),
        ttlSeconds: 60,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "UNAUTHORIZED" } });
  });

  test("atomically consumes one ticket once and derives its persisted scope", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    const firstConnection = await connectWithLifecycleClock(() => now);
    const secondConnection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(firstConnection, state);
    const ticketHash = new Uint8Array(randomBytes(32));
    await firstConnection.lobbyStates.issueRealtimeTicket({
      lobbyId: state.lobby.id,
      sessionTokenHash: state.sessions[0]!.tokenHash,
      ticketHash,
      ttlSeconds: 60,
    });

    const lock = await pool.connect();
    const consumers: Promise<ConsumedRealtimeTicket | null>[] = [];
    let transactionOpen = false;
    let consumed: (ConsumedRealtimeTicket | null)[];

    try {
      await lock.query("BEGIN");
      transactionOpen = true;
      await lock.query(`SELECT token_hash FROM realtime_tickets WHERE token_hash = $1 FOR UPDATE`, [
        Buffer.from(ticketHash),
      ]);
      consumers.push(
        firstConnection.lobbyStates.consumeRealtimeTicket({ ticketHash }),
        secondConnection.lobbyStates.consumeRealtimeTicket({ ticketHash }),
      );
      await waitForBlockedRealtimeTicketConsumers(2);
      await lock.query("COMMIT");
      transactionOpen = false;
      consumed = await Promise.all(consumers);
    } finally {
      if (transactionOpen) await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
      await Promise.allSettled(consumers);
    }

    expect(consumed.filter((result) => result !== null)).toEqual([
      {
        lobbyId: state.lobby.id,
        participantId: state.sessions[0]!.participantId,
        participantSessionId: state.sessions[0]!.id,
      },
    ]);
    await expect(
      firstConnection.lobbyStates.consumeRealtimeTicket({ ticketHash }),
    ).resolves.toBeNull();
  });

  test("expires tickets at the exact deadline and accepts a fresh reconnect ticket", async () => {
    let now = new Date("2026-07-17T12:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const expiredHash = new Uint8Array(randomBytes(32));
    const abandonedHash = new Uint8Array(randomBytes(32));
    await connection.lobbyStates.issueRealtimeTicket({
      lobbyId: state.lobby.id,
      sessionTokenHash: state.sessions[0]!.tokenHash,
      ticketHash: expiredHash,
      ttlSeconds: 60,
    });
    await connection.lobbyStates.issueRealtimeTicket({
      lobbyId: state.lobby.id,
      sessionTokenHash: state.sessions[0]!.tokenHash,
      ticketHash: abandonedHash,
      ttlSeconds: 60,
    });
    now = new Date("2026-07-17T12:01:00.000Z");
    await expect(
      connection.lobbyStates.consumeRealtimeTicket({ ticketHash: expiredHash }),
    ).resolves.toBeNull();
    await expect(
      pool.query(`SELECT COUNT(*)::int AS count FROM realtime_tickets WHERE token_hash = $1`, [
        Buffer.from(expiredHash),
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const reconnectHash = new Uint8Array(randomBytes(32));
    await expect(
      connection.lobbyStates.issueRealtimeTicket({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        ticketHash: reconnectHash,
        ttlSeconds: 60,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      pool.query(`SELECT COUNT(*)::int AS count FROM realtime_tickets WHERE token_hash = $1`, [
        Buffer.from(abandonedHash),
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      connection.lobbyStates.consumeRealtimeTicket({ ticketHash: reconnectHash }),
    ).resolves.toEqual({
      lobbyId: state.lobby.id,
      participantId: state.sessions[0]!.participantId,
      participantSessionId: state.sessions[0]!.id,
    });
  });

  test("does not revive a pre-disconnect ticket after the same session rejoins", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[0]!;
    const ticketHash = new Uint8Array(randomBytes(32));
    await connection.lobbyStates.issueRealtimeTicket({
      lobbyId: state.lobby.id,
      sessionTokenHash: session.tokenHash,
      ticketHash,
      ttlSeconds: 60,
    });
    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: session.id,
      reconnectWindowSeconds: 120,
    });
    await connection.lobbyStates.rejoinParticipantSessionByTokenHash({
      lobbyId: state.lobby.id,
      tokenHash: session.tokenHash,
    });

    await expect(connection.lobbyStates.consumeRealtimeTicket({ ticketHash })).resolves.toBeNull();
  });

  test("returns a contract-valid actor-scoped snapshot without private aggregate data", async () => {
    const generatedAt = new Date("2026-07-17T12:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => generatedAt);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[0]!;
    const participant = state.participants[0]!;

    const result = await connection.lobbyStates.findAuthorizedSnapshot({
      lobbyId: state.lobby.id,
      tokenHash: session.tokenHash,
    });

    expect(SnapshotSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      generatedAt: generatedAt.toISOString(),
      lobby: { id: state.lobby.id, code: state.lobby.code, status: "active" },
      session: { id: session.id, participantId: participant.id, status: "active" },
      self: { id: participant.id, username: participant.username },
      ownCard: { id: state.round!.cards[0]!.id, participantId: participant.id },
      calls: [{ id: state.round!.calls[0]!.id, position: 1, ball: 1 }],
    });
    expect(result?.participants).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("tokenHash");
    expect(JSON.stringify(result)).not.toContain("drawOrder");
    expect(JSON.stringify(result)).not.toContain("events");
    expect(JSON.stringify(result)).not.toContain("commandResults");
    expect(JSON.stringify(result)).not.toContain(state.round!.cards[1]!.id);

    const realtimeResult = await connection.lobbyStates.findAuthorizedSnapshotByIdentity({
      lobbyId: state.lobby.id,
      participantId: participant.id,
      participantSessionId: session.id,
    });
    expect(realtimeResult).toEqual(result);
    await expect(
      connection.lobbyStates.isParticipantSessionIdentityActive({
        lobbyId: state.lobby.id,
        participantId: participant.id,
        participantSessionId: session.id,
      }),
    ).resolves.toBe(true);

    await expect(
      connection.lobbyStates.findAuthorizedSnapshot({
        lobbyId: state.lobby.id,
        tokenHash: new Uint8Array(randomBytes(32)),
      }),
    ).resolves.toBeNull();
    await expect(
      connection.lobbyStates.findAuthorizedSnapshotByIdentity({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: session.id,
      }),
    ).resolves.toBeNull();
    await expect(
      connection.lobbyStates.isParticipantSessionIdentityActive({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: session.id,
      }),
    ).resolves.toBe(false);
  });

  test.each(["inactive session", "departed participant", "completed lobby"] as const)(
    "rejects realtime identity authorization for an %s",
    async (lifecycleState) => {
      const now = new Date("2026-07-17T12:00:00.000Z");
      const connection = await connectWithLifecycleClock(() => now);
      const state = createLobbyState();
      const session = state.sessions[0]!;
      const participant = state.participants[0]!;
      await createPersistedLobby(connection, state);

      if (lifecycleState === "inactive session") {
        await pool.query(
          `UPDATE participant_sessions
              SET status = 'DISCONNECTED', disconnected_at = $1, rejoin_until = $2
            WHERE id = $3`,
          [now, new Date(now.getTime() + 120_000), session.id],
        );
      } else if (lifecycleState === "departed participant") {
        await pool.query(`UPDATE participants SET departed_at = $1 WHERE id = $2`, [
          now,
          participant.id,
        ]);
      } else {
        await pool.query(`UPDATE lobbies SET status = 'COMPLETED', ended_at = $1 WHERE id = $2`, [
          now,
          state.lobby.id,
        ]);
      }

      const identity = {
        lobbyId: state.lobby.id,
        participantId: participant.id,
        participantSessionId: session.id,
      };
      await expect(
        connection.lobbyStates.isParticipantSessionIdentityActive(identity),
      ).resolves.toBe(false);
      await expect(
        connection.lobbyStates.findAuthorizedSnapshotByIdentity(identity),
      ).resolves.toBeNull();
    },
  );

  test("returns a co-winner-window snapshot before the result settles", async () => {
    const connection = await connect();
    const initial = createLobbyState();
    const state: DurableLobbyState = {
      ...initial,
      round: {
        ...initial.round!,
        stage: "co-winner-window",
        resultSettledAt: null,
      },
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);

    const result = await connection.lobbyStates.findAuthorizedSnapshot({
      lobbyId: state.lobby.id,
      tokenHash: state.sessions[0]!.tokenHash,
    });

    expect(result).toMatchObject({
      round: {
        stage: "co-winner-window",
        window: {
          triggeringCallId: state.round!.coWinnerTriggeringCallId,
          closesAt: state.round!.coWinnerClosesAt!.toISOString(),
        },
      },
      timer: {
        kind: "co-winner",
        triggeringCallId: state.round!.coWinnerTriggeringCallId,
        deadline: state.round!.coWinnerClosesAt!.toISOString(),
      },
    });
    expect(SnapshotSchema.safeParse(result).success).toBe(true);
  });

  test("samples the snapshot timestamp after acquiring the lobby fence", async () => {
    let now = new Date("2026-07-17T12:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);

    const blocker = await pool.connect();
    let snapshotRequest:
      ReturnType<typeof connection.lobbyStates.findAuthorizedSnapshot> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `UPDATE lobbies SET last_event_sequence = last_event_sequence WHERE id = $1`,
        [state.lobby.id],
      );
      snapshotRequest = connection.lobbyStates.findAuthorizedSnapshot({
        lobbyId: state.lobby.id,
        tokenHash: state.sessions[0]!.tokenHash,
      });
      await waitForBlockedParticipantReservations(1);
      now = new Date("2026-07-17T12:05:00.000Z");
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    await expect(snapshotRequest!).resolves.toMatchObject({ generatedAt: now.toISOString() });
  });

  test("returns a valid no-card snapshot for a participant joining an existing round", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const suffix = randomUUID();
    const issuedAt = new Date("2026-07-17T12:00:00.000Z");
    const tokenHash = new Uint8Array(randomBytes(32));
    const admitted = await connection.lobbyStates.joinLobbyWithSession({
      lobbyId: state.lobby.id,
      lobbyCode: state.lobby.code,
      participantId: `participant-${suffix}`,
      sessionId: `session-${suffix}`,
      commandId: `command-${suffix}`,
      username: "Waiting Snapshot Player",
      tokenHash,
      issuedAt,
      maxPlayersPerLobby: 3,
    });
    if (!admitted.ok) throw new Error(admitted.error.message);

    const result = await connection.lobbyStates.findAuthorizedSnapshot({
      lobbyId: state.lobby.id,
      tokenHash,
    });

    expect(SnapshotSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      self: { id: admitted.entry.participantId, roundEligibility: "waiting" },
      ownCard: null,
      ownMarks: [],
    });
  });

  test.each(["waiting", "ended"] as const)(
    "keeps a no-card join waiting while the current round is %s",
    async (stage) => {
      const connection = await connect();
      const initial = createLobbyState();
      const state: DurableLobbyState = {
        ...initial,
        lobby: { ...initial.lobby, status: stage === "waiting" ? "waiting" : "active" },
        round: {
          ...initial.round!,
          stage,
          startedAt: stage === "waiting" ? null : initial.round!.startedAt,
          activeAt: stage === "waiting" ? null : initial.round!.activeAt,
          endedAt: stage === "ended" ? new Date("2026-07-17T08:03:00.000Z") : null,
          coWinnerTriggeringCallId:
            stage === "waiting" ? null : initial.round!.coWinnerTriggeringCallId,
          coWinnerOpenedAt: stage === "waiting" ? null : initial.round!.coWinnerOpenedAt,
          coWinnerClosesAt: stage === "waiting" ? null : initial.round!.coWinnerClosesAt,
          resultSettledAt: stage === "waiting" ? null : initial.round!.resultSettledAt,
          cards:
            stage === "waiting"
              ? initial.round!.cards.map((card) => ({ ...card, marks: [] }))
              : initial.round!.cards,
          calls: stage === "waiting" ? [] : initial.round!.calls,
          coWinners: stage === "waiting" ? [] : initial.round!.coWinners,
        },
        events: [],
        commandResults: [],
      };
      await createPersistedLobby(connection, state);
      const suffix = randomUUID();

      const result = await connection.lobbyStates.joinLobbyWithSession({
        lobbyId: state.lobby.id,
        lobbyCode: state.lobby.code,
        participantId: `participant-${suffix}`,
        sessionId: `session-${suffix}`,
        commandId: `command-${suffix}`,
        username: `Stage ${stage} Player`,
        tokenHash: new Uint8Array(randomBytes(32)),
        issuedAt: new Date("2026-07-17T12:00:00.000Z"),
        maxPlayersPerLobby: 3,
      });

      expect(result).toMatchObject({
        ok: true,
        entry: { roundEligibility: "waiting" },
      });
    },
  );

  test("excludes unrelated departed history from the bounded snapshot roster", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[1]!;
    const participant = state.participants[1]!;
    const suffix = randomUUID();
    for (let index = 0; index < 30; index += 1) {
      await pool.query(
        `INSERT INTO participants
           (id, lobby_id, username, normalized_username, role, round_eligibility, joined_at, departed_at)
         VALUES ($1, $2, $3, $4, 'PLAYER', 'WAITING', $5, $6)`,
        [
          `participant-departed-${index}-${suffix}`,
          state.lobby.id,
          `Departed ${index} ${suffix}`,
          `departed ${index} ${suffix}`,
          new Date(`2026-07-17T09:${String(index).padStart(2, "0")}:00.000Z`),
          new Date(`2026-07-17T10:${String(index).padStart(2, "0")}:00.000Z`),
        ],
      );
    }

    const result = await connection.lobbyStates.findAuthorizedSnapshot({
      lobbyId: state.lobby.id,
      tokenHash: session.tokenHash,
    });

    expect(result?.participants).toHaveLength(2);
    expect(result?.participants.map(({ id }) => id)).toEqual(
      expect.arrayContaining([participant.id, state.participants[0]!.id]),
    );
    expect(SnapshotSchema.safeParse(result).success).toBe(true);
  });

  test("returns actor-valid rosters when a waiting replacement extends a full round", async () => {
    const connection = await connect();
    const initial = createLobbyState();
    const suffix = randomUUID();
    const extraParticipants = Array.from({ length: 23 }, (_, index) => ({
      id: `participant-winner-${index}-${suffix}`,
      username: `Winner ${index} ${suffix}`,
      normalizedUsername: `winner ${index} ${suffix}`,
      role: "player" as const,
      roundEligibility: "playing" as const,
      joinedAt: new Date(`2026-07-17T08:00:${String(index).padStart(2, "0")}.000Z`),
      departedAt: index === 0 ? new Date("2026-07-17T10:00:00.000Z") : null,
    }));
    const triggeringCallId = initial.round!.calls[0]!.id;
    const state: DurableLobbyState = {
      ...initial,
      participants: [...initial.participants, ...extraParticipants],
      round: {
        ...initial.round!,
        cards: [
          ...initial.round!.cards,
          ...extraParticipants.map((participant, index) => {
            const cells = [...createCardCells(10)];
            cells[0] = 1 + (index % 10);
            cells[1] = 16 + Math.floor(index / 10);
            return {
              id: `card-winner-${index}-${suffix}`,
              participantId: participant.id,
              cells,
              createdAt: initial.round!.createdAt,
              marks: [],
            };
          }),
        ],
        coWinners: [
          ...initial.round!.coWinners,
          {
            participantId: initial.participants[1]!.id,
            cardId: initial.round!.cards[1]!.id,
            triggeringCallId,
            confirmedAt: initial.round!.resultSettledAt!,
          },
          ...extraParticipants.map((participant, index) => ({
            participantId: participant.id,
            cardId: `card-winner-${index}-${suffix}`,
            triggeringCallId,
            confirmedAt: initial.round!.resultSettledAt!,
          })),
        ],
      },
    };
    await createPersistedLobby(connection, state);
    const joinedAt = new Date("2026-07-17T12:00:00.000Z");
    const tokenHash = new Uint8Array(randomBytes(32));
    const admitted = await connection.lobbyStates.joinLobbyWithSession({
      lobbyId: state.lobby.id,
      lobbyCode: state.lobby.code,
      participantId: `participant-waiting-${suffix}`,
      sessionId: `session-waiting-${suffix}`,
      commandId: `command-waiting-${suffix}`,
      username: `Waiting ${suffix}`,
      tokenHash,
      issuedAt: joinedAt,
      maxPlayersPerLobby: 25,
    });
    if (!admitted.ok) throw new Error(admitted.error.message);

    const waitingSnapshot = await connection.lobbyStates.findAuthorizedSnapshot({
      lobbyId: state.lobby.id,
      tokenHash,
    });
    const playingSnapshot = await connection.lobbyStates.findAuthorizedSnapshot({
      lobbyId: state.lobby.id,
      tokenHash: state.sessions[0]!.tokenHash,
    });

    const winnerIds = state.round!.coWinners.map(({ participantId }) => participantId);
    expect(waitingSnapshot?.participants).toHaveLength(26);
    expect(waitingSnapshot?.participants.map(({ id }) => id)).toEqual(
      expect.arrayContaining([admitted.entry.participantId, ...winnerIds]),
    );
    expect(SnapshotSchema.safeParse(waitingSnapshot).success).toBe(true);
    expect(playingSnapshot?.participants).toHaveLength(25);
    expect(playingSnapshot?.participants.map(({ id }) => id)).not.toContain(
      admitted.entry.participantId,
    );
    expect(playingSnapshot?.participants.map(({ id }) => id)).toEqual(
      expect.arrayContaining(winnerIds),
    );
    expect(SnapshotSchema.safeParse(playingSnapshot).success).toBe(true);

    await pool.query(`UPDATE lobbies SET status = 'WAITING' WHERE id = $1`, [state.lobby.id]);
    await pool.query(
      `UPDATE rounds
          SET stage = 'WAITING',
              started_at = NULL,
              active_at = NULL,
              paused_at = NULL,
              pause_reason = NULL,
              next_call_at = NULL,
              co_winner_triggering_call_id = NULL,
              co_winner_opened_at = NULL,
              co_winner_closes_at = NULL,
              result_settled_at = NULL,
              ended_at = NULL
        WHERE lobby_id = $1`,
      [state.lobby.id],
    );
    await pool.query(`DELETE FROM co_winners WHERE lobby_id = $1`, [state.lobby.id]);
    await pool.query(`DELETE FROM calls WHERE round_id = $1`, [state.round!.id]);
    const waitingLobbySnapshot = await connection.lobbyStates.findAuthorizedSnapshot({
      lobbyId: state.lobby.id,
      tokenHash,
    });

    expect(waitingLobbySnapshot?.lobby.status).toBe("waiting");
    expect(waitingLobbySnapshot?.participants).toHaveLength(25);
    expect(SnapshotSchema.safeParse(waitingLobbySnapshot).success).toBe(true);
  });

  test("bounds a waiting snapshot when a partial round refills to lobby capacity", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const departedParticipant = state.participants[1]!;
    const departedAt = new Date("2026-07-17T10:00:00.000Z");
    await pool.query(`UPDATE participants SET departed_at = $1 WHERE id = $2`, [
      departedAt,
      departedParticipant.id,
    ]);
    await pool.query(
      `UPDATE participant_sessions
          SET status = 'DEPARTED', departed_at = $1
        WHERE participant_id = $2`,
      [departedAt, departedParticipant.id],
    );

    let waitingTokenHash: Uint8Array | undefined;
    let waitingParticipantId: string | undefined;
    for (let index = 0; index < 24; index += 1) {
      const suffix = randomUUID();
      const tokenHash = new Uint8Array(randomBytes(32));
      const admitted = await connection.lobbyStates.joinLobbyWithSession({
        lobbyId: state.lobby.id,
        lobbyCode: state.lobby.code,
        participantId: `participant-refill-${suffix}`,
        sessionId: `session-refill-${suffix}`,
        commandId: `command-refill-${suffix}`,
        username: `Refill ${index} ${suffix}`,
        tokenHash,
        issuedAt: new Date(`2026-07-17T11:00:${String(index).padStart(2, "0")}.000Z`),
        maxPlayersPerLobby: 25,
      });
      if (!admitted.ok) throw new Error(admitted.error.message);
      waitingTokenHash = tokenHash;
      waitingParticipantId = admitted.entry.participantId;
    }

    const result = await connection.lobbyStates.findAuthorizedSnapshot({
      lobbyId: state.lobby.id,
      tokenHash: waitingTokenHash!,
    });

    expect(result?.self).toMatchObject({
      id: waitingParticipantId,
      roundEligibility: "waiting",
    });
    expect(result?.participants).toHaveLength(25);
    expect(SnapshotSchema.safeParse(result).success).toBe(true);
  });

  test("rejoins within 120 seconds and preserves the participant slot", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[0]!;
    const disconnectedAt = now;
    const rejoinUntil = new Date("2026-07-17T10:02:00.000Z");

    await expect(
      connection.lobbyStates.markParticipantSessionDisconnected({
        lobbyId: state.lobby.id,
        sessionId: session.id,
        reconnectWindowSeconds: 120,
      }),
    ).resolves.toMatchObject({
      sessionId: session.id,
      participantId: session.participantId,
      status: "disconnected",
      disconnectedAt,
      rejoinUntil,
    });
    now = new Date("2026-07-17T10:01:59.999Z");
    await expect(
      connection.lobbyStates.resolveParticipantSessionByTokenHash({
        lobbyId: state.lobby.id,
        tokenHash: session.tokenHash,
      }),
    ).resolves.toMatchObject({
      sessionId: session.id,
      participantId: session.participantId,
      status: "disconnected",
      rejoinUntil,
    });
    const commandId = `command-rejoin-${randomUUID()}`;

    await expect(
      connection.lobbyStates.rejoinLobbyWithSession({
        lobbyId: state.lobby.id,
        tokenHash: session.tokenHash,
        commandId,
      }),
    ).resolves.toMatchObject({ ok: true, entry: { idempotentReplay: false } });
    await expect(
      connection.lobbyStates.rejoinLobbyWithSession({
        lobbyId: state.lobby.id,
        tokenHash: session.tokenHash,
        commandId,
      }),
    ).resolves.toMatchObject({ ok: true, entry: { idempotentReplay: true } });

    const restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.participants.find(({ id }) => id === session.participantId)).toEqual(
      state.participants.find(({ id }) => id === session.participantId),
    );
    expect(restored?.sessions.find(({ id }) => id === session.id)).toMatchObject({
      status: "active",
      disconnectedAt: null,
      rejoinUntil: null,
      departedAt: null,
    });
    expect(restored?.commandResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: session.participantId,
          commandId,
          commandType: "rejoin-lobby",
          createdAt: now,
        }),
      ]),
    );
  });

  test("does not activate a rejoin when its command scope conflicts", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[0]!;
    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: session.id,
      reconnectWindowSeconds: 120,
    });
    now = new Date("2026-07-17T10:01:00.000Z");

    await expect(
      connection.lobbyStates.rejoinLobbyWithSession({
        lobbyId: state.lobby.id,
        tokenHash: session.tokenHash,
        commandId: state.commandResults[0]!.commandId,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "COMMAND_REPLAY_MISMATCH" },
    });

    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          id: session.id,
          status: "disconnected",
          rejoinUntil: new Date("2026-07-17T10:02:00.000Z"),
        }),
      ]),
    });
  });

  test("samples atomic rejoin expiry after acquiring the lobby fence", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[0]!;
    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: session.id,
      reconnectWindowSeconds: 120,
    });

    const blocker = await pool.connect();
    let rejoinRequest: ReturnType<typeof connection.lobbyStates.rejoinLobbyWithSession> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `UPDATE lobbies SET last_event_sequence = last_event_sequence WHERE id = $1`,
        [state.lobby.id],
      );
      now = new Date("2026-07-17T10:01:59.999Z");
      rejoinRequest = connection.lobbyStates.rejoinLobbyWithSession({
        lobbyId: state.lobby.id,
        tokenHash: session.tokenHash,
        commandId: `command-rejoin-fenced-${randomUUID()}`,
      });
      await waitForBlockedParticipantReservations(1);
      now = new Date("2026-07-17T10:02:00.000Z");
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    await expect(rejoinRequest!).resolves.toBeNull();
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({ id: session.participantId, departedAt: now }),
      ]),
      commandResults: expect.not.arrayContaining([
        expect.objectContaining({ commandType: "rejoin-lobby" }),
      ]),
    });
  });

  test("retains the original deadline when disconnect handling repeats", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[0]!;
    const firstDisconnect = await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: session.id,
      reconnectWindowSeconds: 120,
    });

    now = new Date("2026-07-17T10:01:00.000Z");
    await expect(
      connection.lobbyStates.markParticipantSessionDisconnected({
        lobbyId: state.lobby.id,
        sessionId: session.id,
        reconnectWindowSeconds: 120,
      }),
    ).resolves.toEqual(firstDisconnect);

    now = new Date("2026-07-17T10:02:00.000Z");
    await expect(
      connection.lobbyStates.resolveParticipantSessionByTokenHash({
        lobbyId: state.lobby.id,
        tokenHash: session.tokenHash,
      }),
    ).resolves.toBeNull();
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({ id: session.participantId, departedAt: now }),
      ]),
      sessions: expect.arrayContaining([
        expect.objectContaining({
          id: session.id,
          disconnectedAt: new Date("2026-07-17T10:00:00.000Z"),
          rejoinUntil: now,
          departedAt: now,
        }),
      ]),
    });
  });

  test("departs the prior slot at the exact rejoin deadline", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[1]!;
    const disconnectedAt = now;
    const rejoinUntil = new Date("2026-07-17T10:02:00.000Z");

    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: session.id,
      reconnectWindowSeconds: 120,
    });
    now = rejoinUntil;
    const replacement = newParticipant(state.lobby.id, "Replacement Player");
    await expect(
      connection.lobbyStates.reserveParticipant(replacement, {
        maxPlayersPerLobby: state.participants.length,
      }),
    ).resolves.toEqual({ ok: true, participantId: replacement.id });
    await expect(
      connection.lobbyStates.rejoinParticipantSessionByTokenHash({
        lobbyId: state.lobby.id,
        tokenHash: session.tokenHash,
      }),
    ).resolves.toBeNull();

    const restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(
      restored?.participants.find(({ id }) => id === session.participantId)?.departedAt,
    ).toEqual(rejoinUntil);
    expect(restored?.sessions.find(({ id }) => id === session.id)).toMatchObject({
      status: "departed",
      disconnectedAt,
      rejoinUntil,
      departedAt: rejoinUntil,
    });
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({
          id: replacement.id,
          roundEligibility: "waiting",
        }),
      ]),
    });
  });

  test("retires a grace generation when its participant rejoin window expires", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[1]!;
    const grace = await connection.lobbyStates.unregisterRealtimeConnection({
      lobbyId: state.lobby.id,
      participantId: session.participantId,
      participantSessionId: session.id,
      presenceGeneration: 1,
      reconnectWindowSeconds: 120,
      disconnectPauseGraceSeconds: 10,
    });

    now = new Date("2026-07-17T10:02:00.000Z");
    await expect(
      connection.lobbyStates.expireParticipantRejoinWindows(state.lobby.id),
    ).resolves.toBe(1);

    const restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(
      restored?.participants.find(({ id }) => id === session.participantId)?.departedAt,
    ).toEqual(now);
    expect(
      restored?.presenceGenerations
        .filter(({ participantId }) => participantId === session.participantId)
        .at(-1),
    ).toMatchObject({
      status: "departed",
      connectionCount: 0,
      changedAt: now,
      graceEndsAt: null,
      absentSince: null,
      departedAt: now,
      overridden: false,
    });
    await expect(
      connection.lobbyStates.findRealtimePresenceGracePeriods(),
    ).resolves.not.toContainEqual(grace);
    await expect(connection.lobbyStates.expireRealtimePresenceGrace(grace!)).resolves.toBe("stale");
  });

  test("fails closed instead of truncating bounded grace recovery", async () => {
    const connection = await connectWithLifecycleClock(() => new Date("2026-07-17T10:00:00.000Z"));
    for (const state of [createLobbyState(), createLobbyState()]) {
      await createPersistedLobby(connection, state);
      const session = state.sessions[1]!;
      await connection.lobbyStates.unregisterRealtimeConnection({
        lobbyId: state.lobby.id,
        participantId: session.participantId,
        participantSessionId: session.id,
        presenceGeneration: 1,
        reconnectWindowSeconds: 120,
        disconnectPauseGraceSeconds: 10,
      });
    }

    await expect(connection.lobbyStates.findRealtimePresenceGracePeriods(1)).rejects.toThrow(
      "recovery limit",
    );
  });

  test("samples rejoin expiry after acquiring the lobby fence", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[0]!;
    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: session.id,
      reconnectWindowSeconds: 120,
    });

    const blocker = await pool.connect();
    let rejoin:
      ReturnType<typeof connection.lobbyStates.rejoinParticipantSessionByTokenHash> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `UPDATE lobbies SET last_event_sequence = last_event_sequence WHERE id = $1`,
        [state.lobby.id],
      );
      now = new Date("2026-07-17T10:01:59.999Z");
      rejoin = connection.lobbyStates.rejoinParticipantSessionByTokenHash({
        lobbyId: state.lobby.id,
        tokenHash: session.tokenHash,
      });
      await waitForBlockedParticipantReservations(1);
      now = new Date("2026-07-17T10:02:00.000Z");
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    await expect(rejoin!).resolves.toBeNull();
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({ id: session.participantId, departedAt: now }),
      ]),
    });
  });

  test("does not issue a replacement credential for an expired prior slot", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const session = state.sessions[0]!;
    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: session.id,
      reconnectWindowSeconds: 120,
    });

    now = new Date("2026-07-17T10:02:00.000Z");
    await expect(
      connection.lobbyStates.createParticipantSession({
        id: `session-replacement-${randomUUID()}`,
        lobbyId: state.lobby.id,
        participantId: session.participantId,
        tokenHash: new Uint8Array(randomBytes(32)),
        issuedAt: now,
      }),
    ).resolves.toBe("scope-not-found");
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({ id: session.participantId, departedAt: now }),
      ]),
    });
  });

  test("invalidates stale sibling credentials when one session rejoins", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const selected = state.sessions[0]!;
    const siblingHash = new Uint8Array(randomBytes(32));
    const siblingId = `session-sibling-${randomUUID()}`;
    await connection.lobbyStates.createParticipantSession({
      id: siblingId,
      lobbyId: state.lobby.id,
      participantId: selected.participantId,
      tokenHash: siblingHash,
      issuedAt: now,
    });

    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: selected.id,
      reconnectWindowSeconds: 120,
    });
    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: siblingId,
      reconnectWindowSeconds: 120,
    });
    now = new Date("2026-07-17T10:01:00.000Z");
    await expect(
      connection.lobbyStates.rejoinParticipantSessionByTokenHash({
        lobbyId: state.lobby.id,
        tokenHash: selected.tokenHash,
      }),
    ).resolves.toMatchObject({ sessionId: selected.id, status: "active" });

    now = new Date("2026-07-17T10:03:00.000Z");
    await expect(
      connection.lobbyStates.resolveParticipantSessionByTokenHash({
        lobbyId: state.lobby.id,
        tokenHash: siblingHash,
      }),
    ).resolves.toBeNull();
    const restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.participants.find(({ id }) => id === selected.participantId)?.departedAt).toBe(
      null,
    );
    expect(restored?.sessions.find(({ id }) => id === selected.id)?.status).toBe("active");
    expect(restored?.sessions.find(({ id }) => id === siblingId)).toMatchObject({
      status: "departed",
      departedAt: new Date("2026-07-17T10:01:00.000Z"),
    });
  });

  test("keeps a participant eligible while a sibling rejoin deadline remains open", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const connection = await connectWithLifecycleClock(() => now);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const selected = state.sessions[0]!;
    const siblingHash = new Uint8Array(randomBytes(32));
    const siblingId = `session-sibling-${randomUUID()}`;
    await connection.lobbyStates.createParticipantSession({
      id: siblingId,
      lobbyId: state.lobby.id,
      participantId: selected.participantId,
      tokenHash: siblingHash,
      issuedAt: now,
    });
    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: selected.id,
      reconnectWindowSeconds: 120,
    });

    now = new Date("2026-07-17T10:01:00.000Z");
    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: state.lobby.id,
      sessionId: siblingId,
      reconnectWindowSeconds: 120,
    });
    now = new Date("2026-07-17T10:02:00.000Z");
    await expect(
      connection.lobbyStates.expireParticipantRejoinWindows(state.lobby.id),
    ).resolves.toBe(0);
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({ id: selected.participantId, departedAt: null }),
      ]),
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: selected.id, status: "departed", departedAt: now }),
        expect.objectContaining({ id: siblingId, status: "disconnected", departedAt: null }),
      ]),
    });
    await expect(
      connection.lobbyStates.rejoinParticipantSessionByTokenHash({
        lobbyId: state.lobby.id,
        tokenHash: siblingHash,
      }),
    ).resolves.toMatchObject({ sessionId: siblingId, status: "active" });
  });

  test("rejects rejoin credentials outside their active lobby", async () => {
    const connection = await connect();
    const firstLobby = createLobbyState();
    const secondLobby = createLobbyState();
    await createPersistedLobby(connection, firstLobby);
    await createPersistedLobby(connection, secondLobby);
    const session = firstLobby.sessions[0]!;

    await expect(
      connection.lobbyStates.rejoinParticipantSessionByTokenHash({
        lobbyId: secondLobby.lobby.id,
        tokenHash: session.tokenHash,
      }),
    ).resolves.toBeNull();
    await pool.query(`UPDATE lobbies SET status = 'COMPLETED' WHERE id = $1`, [
      firstLobby.lobby.id,
    ]);
    await expect(
      connection.lobbyStates.rejoinParticipantSessionByTokenHash({
        lobbyId: firstLobby.lobby.id,
        tokenHash: session.tokenHash,
      }),
    ).resolves.toBeNull();
    await expect(
      connection.lobbyStates.rejoinParticipantSessionByTokenHash({
        lobbyId: "deleted-lobby",
        tokenHash: session.tokenHash,
      }),
    ).resolves.toBeNull();
  });

  test("derives waiting eligibility for a new join during an active round", async () => {
    const connection = await connect();
    const initialState = createLobbyState();
    const state: DurableLobbyState = {
      ...initialState,
      round: { ...initialState.round!, stage: "active" },
    };
    await createPersistedLobby(connection, state);
    const participant = newParticipant(state.lobby.id, "Late Player");

    await expect(
      connection.lobbyStates.reserveParticipant(participant, { maxPlayersPerLobby: 3 }),
    ).resolves.toEqual({ ok: true, participantId: participant.id });
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({
          id: participant.id,
          roundEligibility: "waiting",
        }),
      ]),
    });
  });

  test("derives playing eligibility when no round is active", async () => {
    const connection = await connect();
    const initialState = createLobbyState();
    const state: DurableLobbyState = {
      ...initialState,
      lobby: { ...initialState.lobby, status: "waiting" },
      round: null,
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);
    const participant = newParticipant(state.lobby.id, "Pre-round Player");

    await expect(
      connection.lobbyStates.reserveParticipant(participant, { maxPlayersPerLobby: 3 }),
    ).resolves.toEqual({ ok: true, participantId: participant.id });
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({
          id: participant.id,
          roundEligibility: "playing",
        }),
      ]),
    });
  });

  test("scopes normalized username reservations to one lobby", async () => {
    const connection = await connect();
    const firstLobby = createLobbyState();
    const secondLobby = createLobbyState();
    await createPersistedLobby(connection, firstLobby);
    await createPersistedLobby(connection, secondLobby);
    const first = newParticipant(firstLobby.lobby.id, "Shared Name");
    const second = newParticipant(secondLobby.lobby.id, "shared name");

    await expect(
      connection.lobbyStates.reserveParticipant(first, { maxPlayersPerLobby: 3 }),
    ).resolves.toEqual({ ok: true, participantId: first.id });
    await expect(
      connection.lobbyStates.reserveParticipant(second, { maxPlayersPerLobby: 3 }),
    ).resolves.toEqual({ ok: true, participantId: second.id });
  });

  test("rejects participant limits above the product maximum", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);

    await expect(
      connection.lobbyStates.reserveParticipant(newParticipant(state.lobby.id), {
        maxPlayersPerLobby: 26,
      }),
    ).rejects.toThrow("The participant limit must be a safe integer between 1 and 25.");
  });

  test("enforces configured participant limits without reserving a username", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const rejected = newParticipant(state.lobby.id);
    const accepted = newParticipant(state.lobby.id);

    await expect(
      connection.lobbyStates.reserveParticipant(rejected, {
        maxPlayersPerLobby: state.participants.length,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "LOBBY_FULL", message: "The lobby is full." },
    });
    await expect(
      connection.lobbyStates.reserveParticipant(accepted, {
        maxPlayersPerLobby: state.participants.length + 1,
      }),
    ).resolves.toEqual({ ok: true, participantId: accepted.id });
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      participants: expect.not.arrayContaining([expect.objectContaining({ id: rejected.id })]),
    });
  });

  test("never exceeds the participant limit under concurrent reservations", async () => {
    const retryEvents: TransactionRetryEvent[] = [];
    const firstConnection = await connectWithRetryObserver(retryEvents);
    const secondConnection = await connectWithRetryObserver(retryEvents);
    const state = createLobbyState();
    await createPersistedLobby(firstConnection, state);
    const first = newParticipant(state.lobby.id);
    const second = newParticipant(state.lobby.id);
    const blocker = await pool.connect();
    let firstReservation: Promise<ReserveParticipantResult> | undefined;
    let secondReservation: Promise<ReserveParticipantResult> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `UPDATE lobbies SET last_event_sequence = last_event_sequence WHERE id = $1`,
        [state.lobby.id],
      );
      firstReservation = firstConnection.lobbyStates.reserveParticipant(first, {
        maxPlayersPerLobby: state.participants.length + 1,
      });
      secondReservation = secondConnection.lobbyStates.reserveParticipant(second, {
        maxPlayersPerLobby: state.participants.length + 1,
      });
      await waitForBlockedParticipantReservations(2);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    const results = await Promise.all([firstReservation!, secondReservation!]);
    const restored = await firstConnection.lobbyStates.findById(state.lobby.id);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: { code: "LOBBY_FULL", message: "The lobby is full." },
      },
    ]);
    expect(restored?.participants).toHaveLength(state.participants.length + 1);
    expect(retryEvents.some((event) => event.kind === "retry")).toBe(true);
  });

  test("returns a stable result for concurrent normalized-username collisions", async () => {
    const firstConnection = await connect();
    const secondConnection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(firstConnection, state);
    const first = newParticipant(state.lobby.id, "  Concurrent   Name ");
    const second = newParticipant(state.lobby.id, "concurrent name");
    const blocker = await pool.connect();
    let firstReservation: Promise<ReserveParticipantResult> | undefined;
    let secondReservation: Promise<ReserveParticipantResult> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `UPDATE lobbies SET last_event_sequence = last_event_sequence WHERE id = $1`,
        [state.lobby.id],
      );
      firstReservation = firstConnection.lobbyStates.reserveParticipant(first, {
        maxPlayersPerLobby: 4,
      });
      secondReservation = secondConnection.lobbyStates.reserveParticipant(second, {
        maxPlayersPerLobby: 4,
      });
      await waitForBlockedParticipantReservations(2);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    const results = await Promise.all([firstReservation!, secondReservation!]);
    const restored = await firstConnection.lobbyStates.findById(state.lobby.id);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: {
          code: "USERNAME_TAKEN",
          message: "That username is already in use.",
        },
      },
    ]);
    expect(
      restored?.participants.filter(
        (participant) => participant.normalizedUsername === "concurrent name",
      ),
    ).toHaveLength(1);
  });

  test("never exceeds the active-lobby limit under concurrent creation", async () => {
    const connection = await connect();
    const activeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM lobbies WHERE status IN ('WAITING', 'ACTIVE')`,
    );
    const countBefore = Number(activeCount.rows[0]!.count);
    const first = createLobbyState();
    const second = createLobbyState();

    const results = await Promise.all([
      connection.lobbyStates.createActive(omitLobbyCode(first), {
        maxActiveLobbies: countBefore + 1,
        nextCode: () => first.lobby.code,
      }),
      connection.lobbyStates.createActive(omitLobbyCode(second), {
        maxActiveLobbies: countBefore + 1,
        nextCode: () => second.lobby.code,
      }),
    ]);
    const countAfter = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM lobbies WHERE status IN ('WAITING', 'ACTIVE')`,
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: {
          code: "ACTIVE_LOBBY_LIMIT_REACHED",
          message: "The active lobby limit has been reached.",
        },
      },
    ]);
    expect(Number(countAfter.rows[0]!.count)).toBe(countBefore + 1);
  });

  test("retries the losing candidate when concurrent creators choose the same code", async () => {
    const firstConnection = await connect();
    const secondConnection = await connect();
    const first = createLobbyState();
    const second = createLobbyState();
    const sharedCode = randomLobbyCode();
    const firstFallback = randomLobbyCode();
    const secondFallback = randomLobbyCode();
    const blocker = await pool.connect();
    let firstCreation: Promise<CreateActiveLobbyResult> | undefined;
    let secondCreation: Promise<CreateActiveLobbyResult> | undefined;

    try {
      await blocker.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await blocker.query("SELECT pg_advisory_xact_lock(17742, 23001)");
      firstCreation = firstConnection.lobbyStates.createActive(omitLobbyCode(first), {
        maxActiveLobbies: Number.MAX_SAFE_INTEGER,
        nextCode: scriptedCodes([sharedCode, firstFallback]),
      });
      secondCreation = secondConnection.lobbyStates.createActive(omitLobbyCode(second), {
        maxActiveLobbies: Number.MAX_SAFE_INTEGER,
        nextCode: scriptedCodes([sharedCode, secondFallback]),
      });
      await waitForBlockedLobbyAdmissions(2);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    const results = await Promise.all([firstCreation!, secondCreation!]);
    expect(results).toEqual([
      { ok: true, lobbyId: first.lobby.id, code: expect.any(String) },
      { ok: true, lobbyId: second.lobby.id, code: expect.any(String) },
    ]);
    const committedCodes = results.map((result) => (result.ok ? result.code : null));
    expect(committedCodes).toContain(sharedCode);
    expect(committedCodes).toSatisfy(
      (codes: unknown[]) => codes.includes(firstFallback) || codes.includes(secondFallback),
    );
    expect(new Set(committedCodes).size).toBe(2);
  });

  test("retries an active-code unique race that commits after its transaction snapshot", async () => {
    const connection = await connect();
    const state = createLobbyState();
    const racedCode = randomLobbyCode();
    const fallbackCode = randomLobbyCode();
    const blocker = await pool.connect();
    let creation: Promise<CreateActiveLobbyResult> | undefined;

    try {
      await blocker.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await blocker.query("SELECT pg_advisory_xact_lock(17742, 23001)");
      creation = connection.lobbyStates.createActive(omitLobbyCode(state), {
        maxActiveLobbies: Number.MAX_SAFE_INTEGER,
        nextCode: scriptedCodes([racedCode, fallbackCode]),
      });
      await waitForBlockedLobbyAdmissions(1);
      await pool.query(
        `INSERT INTO lobbies (
           id, code, status, theme_id, created_at, last_activity_at, last_event_sequence
         ) VALUES ($1, $2, 'ACTIVE', 'theme-race', $3, $3, 0)`,
        [`lobby-code-race-${randomUUID()}`, racedCode, new Date("2026-07-17T08:00:00.000Z")],
      );
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    await expect(creation).resolves.toEqual({
      ok: true,
      lobbyId: state.lobby.id,
      code: fallbackCode,
    });
  });

  test("allows completed lobby codes to be reused without consuming active capacity", async () => {
    const connection = await connect();
    const completed = createLobbyState();
    await createPersistedLobby(connection, completed);
    await pool.query(`UPDATE lobbies SET status = 'COMPLETED' WHERE id = $1`, [completed.lobby.id]);
    const replacement = createLobbyState();

    await expect(
      connection.lobbyStates.createActive(omitLobbyCode(replacement), {
        maxActiveLobbies: Number.MAX_SAFE_INTEGER,
        nextCode: () => completed.lobby.code,
      }),
    ).resolves.toEqual({
      ok: true,
      lobbyId: replacement.lobby.id,
      code: completed.lobby.code,
    });
  });

  test("rejects cards owned by a participant from another lobby", async () => {
    const connection = await connect();
    const firstLobby = createLobbyState();
    const secondLobby = createLobbyState();
    await createPersistedLobby(connection, firstLobby);
    await createPersistedLobby(connection, secondLobby);

    await expect(
      pool.query(
        `INSERT INTO cards (id, lobby_id, round_id, participant_id, cells, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `foreign-card-${randomUUID()}`,
          secondLobby.lobby.id,
          secondLobby.round!.id,
          firstLobby.participants[0]!.id,
          createCardCells(10),
          new Date("2026-07-17T08:03:00.000Z"),
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  test("rejects null card data rather than accepting an unknown check result", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const participantId = `participant-null-card-${randomUUID()}`;
    await pool.query(
      `INSERT INTO participants (
         id, lobby_id, username, normalized_username, role,
         round_eligibility, joined_at
       ) VALUES ($1, $2, $3, $4, 'PLAYER', 'PLAYING', $5)`,
      [
        participantId,
        state.lobby.id,
        "Null Card Player",
        `null-card-player-${randomUUID()}`,
        new Date("2026-07-17T08:03:00.000Z"),
      ],
    );

    await expect(
      pool.query(
        `INSERT INTO cards (id, lobby_id, round_id, participant_id, cells, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5)`,
        [
          `null-card-${randomUUID()}`,
          state.lobby.id,
          state.round!.id,
          participantId,
          new Date("2026-07-17T08:03:00.000Z"),
        ],
      ),
    ).rejects.toMatchObject({ code: "23502" });
  });

  test("stores only token hashes and constrains private state to lobby cascades", async () => {
    const columnResult = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'participant_sessions'
        ORDER BY column_name`,
    );
    const columns = columnResult.rows.map((row) => row.column_name);

    expect(columns).toContain("token_hash");
    expect(columns).not.toContain("token");
    expect(columns).not.toContain("session_token");

    const cascadeResult = await pool.query<{
      table_name: string;
      referenced_table_name: string;
      delete_rule: string;
    }>(
      `SELECT tc.table_name,
              ccu.table_name AS referenced_table_name,
              rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_schema = tc.constraint_schema
          AND rc.constraint_name = tc.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND rc.delete_rule = 'CASCADE'`,
    );

    const cascadeEdges = new Set(
      cascadeResult.rows.map((row) => `${row.table_name}->${row.referenced_table_name}`),
    );
    for (const edge of [
      "participants->lobbies",
      "participant_sessions->lobbies",
      "presence_generations->lobbies",
      "rounds->lobbies",
      "cards->lobbies",
      "marks->rounds",
      "draw_positions->rounds",
      "calls->rounds",
      "co_winners->lobbies",
      "active_lobby_events->lobbies",
      "command_results->lobbies",
    ]) {
      expect(cascadeEdges.has(edge), `${edge} must be an owned-state cascade`).toBe(true);
    }
  });

  test("keeps exactly one current round and no prior-round result history model", async () => {
    const connection = await connect();
    const state = createLobbyState();
    await createPersistedLobby(connection, state);

    const modelResult = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'`,
    );
    const tables = modelResult.rows.map((row) => row.table_name);

    expect(tables).not.toEqual(
      expect.arrayContaining(["round_history", "round_results", "event_history"]),
    );

    await expect(
      pool.query(
        `INSERT INTO rounds (
           id, lobby_id, initial_pattern_id, current_pattern_id, stage,
           call_mode, created_at
         ) VALUES ($1, $2, $3, $4, 'WAITING', 'MANUAL', $5)`,
        [
          `second-${randomUUID()}`,
          state.lobby.id,
          "standard-one-line",
          "standard-one-line",
          new Date("2026-07-17T09:00:00.000Z"),
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  test("commits state, an active-lobby event, and its idempotent result atomically", async () => {
    const connection = await connect();
    const state = createLobbyState();
    const request = commandRequest(state, `command-public-${randomUUID()}`);
    const activityAt = new Date("2026-07-17T09:00:00.000Z");
    let mutationInvocations = 0;
    await createPersistedLobby(connection, state);

    const execute = () =>
      connection.commandTransactions.execute(request, async ({ lobbies }) => {
        mutationInvocations += 1;
        await lobbies.recordActivity(activityAt);
        return {
          deliveryScope: "active-lobby" as const,
          result: { status: "committed" },
          event: {
            roundId: state.round!.id,
            eventType: "test-public-command",
            schemaVersion: 1,
            payload: { status: "committed" },
            createdAt: activityAt,
          },
        };
      });

    const committed = await execute();
    const replayed = await execute();
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(committed).toMatchObject({
      idempotentReplay: false,
      committedEvent: {
        sequence: 2n,
        eventType: "test-public-command",
      },
      commandResult: {
        commandId: request.commandId,
        eventSequence: 2n,
        result: { status: "committed" },
      },
    });
    expect(replayed).toEqual({
      commandResult: committed.commandResult,
      committedEvent: null,
      idempotentReplay: true,
    });
    expect(mutationInvocations).toBe(1);
    expect(restored?.lobby).toMatchObject({
      lastActivityAt: activityAt,
      lastEventSequence: 2n,
    });
    expect(restored?.events).toHaveLength(2);
    expect(restored?.events.at(-1)).toEqual(committed.committedEvent);
    expect(restored?.commandResults).toHaveLength(2);
  });

  test("commits participant-private results without allocating a lobby sequence", async () => {
    const connection = await connect();
    const state = createLobbyState();
    const request = commandRequest(state, `command-private-${randomUUID()}`);
    const activityAt = new Date("2026-07-17T09:01:00.000Z");
    await createPersistedLobby(connection, state);

    const committed = await connection.commandTransactions.execute(request, async ({ lobbies }) => {
      await lobbies.recordActivity(activityAt);
      return {
        deliveryScope: "participant-private" as const,
        result: { accepted: true },
      };
    });
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(committed).toMatchObject({
      idempotentReplay: false,
      committedEvent: null,
      commandResult: {
        deliveryScope: "participant-private",
        eventSequence: null,
        result: { accepted: true },
      },
    });
    expect(restored?.lobby.lastEventSequence).toBe(1n);
    expect(restored?.events).toHaveLength(1);
    expect(restored?.commandResults).toHaveLength(2);
  });

  test("concurrent duplicate commands commit one effect and replay the winner", async () => {
    const state = createLobbyState();
    const setupConnection = await connect();
    const firstConnection = await connect();
    const secondConnection = await connect();
    const request = commandRequest(state, `command-race-${randomUUID()}`);
    const activityAt = new Date("2026-07-17T09:02:00.000Z");
    let mutationInvocations = 0;
    await createPersistedLobby(setupConnection, state);

    const mutate = async ({ lobbies }: CommandTransactionRepositories) => {
      mutationInvocations += 1;
      await lobbies.recordActivity(activityAt);
      return {
        deliveryScope: "active-lobby" as const,
        result: { operationId: request.commandId },
        event: {
          roundId: state.round!.id,
          eventType: "test-raced-command",
          schemaVersion: 1,
          payload: { operationId: request.commandId },
          createdAt: activityAt,
        },
      };
    };

    const results = await Promise.all([
      firstConnection.commandTransactions.execute(request, mutate),
      secondConnection.commandTransactions.execute(request, mutate),
    ]);
    const restored = await setupConnection.lobbyStates.findById(state.lobby.id);

    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
    expect(results[0]!.commandResult).toEqual(results[1]!.commandResult);
    expect(results.filter((result) => result.committedEvent !== null)).toHaveLength(1);
    expect(mutationInvocations).toBeGreaterThanOrEqual(1);
    expect(restored?.lobby.lastEventSequence).toBe(2n);
    expect(restored?.events).toHaveLength(2);
    expect(restored?.commandResults).toHaveLength(2);
  }, 15_000);

  test("concurrent participant-private no-op commands replay without repeating mutation", async () => {
    const state = createLobbyState();
    const setupConnection = await connect();
    const retryEvents: TransactionRetryEvent[] = [];
    const firstConnection = await connectWithRetryObserver(retryEvents);
    const secondConnection = await connectWithRetryObserver(retryEvents);
    const request = commandRequest(state, `command-private-race-${randomUUID()}`);
    let mutationInvocations = 0;
    let signalFirstMutation!: () => void;
    let releaseFirstMutation!: () => void;
    const firstMutationStarted = new Promise<void>((resolve) => {
      signalFirstMutation = resolve;
    });
    const firstMutationRelease = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve;
    });
    await createPersistedLobby(setupConnection, state);

    const firstResult = firstConnection.commandTransactions.execute(request, async () => {
      mutationInvocations += 1;
      signalFirstMutation();
      await firstMutationRelease;
      return {
        deliveryScope: "participant-private" as const,
        result: { accepted: false, reason: "no-change" },
      };
    });
    await firstMutationStarted;

    const secondResult = secondConnection.commandTransactions.execute(request, async () => {
      mutationInvocations += 1;
      return {
        deliveryScope: "participant-private" as const,
        result: { accepted: false, reason: "no-change" },
      };
    });
    try {
      await waitForBlockedCommandFence();
    } finally {
      releaseFirstMutation();
    }

    const results = await Promise.all([firstResult, secondResult]);
    const restored = await setupConnection.lobbyStates.findById(state.lobby.id);

    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
    expect(results[0]!.commandResult).toEqual(results[1]!.commandResult);
    expect(mutationInvocations).toBe(1);
    expect(retryEvents.some((event) => event.kind === "retry")).toBe(true);
    expect(restored?.lobby.lastEventSequence).toBe(1n);
    expect(restored?.events).toHaveLength(1);
    expect(restored?.commandResults).toHaveLength(2);
  }, 15_000);

  test("rejects replaying a command ID under a different command type", async () => {
    const connection = await connect();
    const state = createLobbyState();
    const commandId = `command-mismatch-${randomUUID()}`;
    const firstRequest = commandRequest(state, commandId, "first-command");
    await createPersistedLobby(connection, state);
    await connection.commandTransactions.execute(firstRequest, async () => ({
      deliveryScope: "participant-private",
      result: { accepted: true },
    }));

    const mismatchedRequest = commandRequest(state, commandId, "different-command");
    await expect(
      connection.commandTransactions.execute(mismatchedRequest, async () => ({
        deliveryScope: "participant-private",
        result: { accepted: false },
      })),
    ).rejects.toBeInstanceOf(CommandReplayMismatchError);
  });

  test("orders concurrent commands with contiguous committed lobby sequences", async () => {
    const state = createLobbyState();
    const setupConnection = await connect();
    const commandConnections = await Promise.all(Array.from({ length: 4 }, async () => connect()));
    await createPersistedLobby(setupConnection, state);

    const results = await Promise.all(
      commandConnections.map(async (connection, index) => {
        const request = commandRequest(state, `ordered-${index}-${randomUUID()}`);
        const activityAt = new Date(`2026-07-17T09:03:0${index}.000Z`);
        return connection.commandTransactions.execute(request, async ({ lobbies }) => {
          await lobbies.recordActivity(activityAt);
          return {
            deliveryScope: "active-lobby" as const,
            result: { index },
            event: {
              roundId: state.round!.id,
              eventType: "test-ordered-command",
              schemaVersion: 1,
              payload: { index },
              createdAt: activityAt,
            },
          };
        });
      }),
    );
    const restored = await setupConnection.lobbyStates.findById(state.lobby.id);

    expect(
      results
        .map((result) => result.commandResult.eventSequence)
        .sort((left, right) => (left! < right! ? -1 : 1)),
    ).toEqual([2n, 3n, 4n, 5n]);
    expect(restored?.lobby.lastEventSequence).toBe(5n);
    expect(restored?.events.map((event) => event.sequence)).toEqual([1n, 2n, 3n, 4n, 5n]);
  }, 15_000);

  test("rolls back state when a command mutation fails before its event is committed", async () => {
    const connection = await connect();
    const state = createLobbyState();
    const request = commandRequest(state, `command-failure-${randomUUID()}`);
    await createPersistedLobby(connection, state);

    await expect(
      connection.commandTransactions.execute(request, async ({ lobbies }) => {
        await lobbies.recordActivity(new Date("2026-07-17T09:04:00.000Z"));
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(restored?.lobby.lastActivityAt).toEqual(state.lobby.lastActivityAt);
    expect(restored?.lobby.lastEventSequence).toBe(1n);
    expect(restored?.events).toHaveLength(1);
    expect(restored?.commandResults).toHaveLength(1);
  });

  test("rolls back state, sequence, and event when command-result persistence fails", async () => {
    const connection = await connect();
    const state = createLobbyState();
    const request = {
      ...commandRequest(state, `command-late-failure-${randomUUID()}`),
      participantId: `missing-participant-${randomUUID()}`,
    };
    const activityAt = new Date("2026-07-17T09:05:00.000Z");
    await createPersistedLobby(connection, state);

    await expect(
      connection.commandTransactions.execute(request, async ({ lobbies }) => {
        await lobbies.recordActivity(activityAt);
        return {
          deliveryScope: "active-lobby",
          result: { accepted: true },
          event: {
            roundId: state.round!.id,
            eventType: "test-late-failure",
            schemaVersion: 1,
            payload: { accepted: true },
            createdAt: activityAt,
          },
        };
      }),
    ).rejects.toBeDefined();
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(restored?.lobby.lastActivityAt).toEqual(state.lobby.lastActivityAt);
    expect(restored?.lobby.lastEventSequence).toBe(1n);
    expect(restored?.events).toHaveLength(1);
    expect(restored?.commandResults).toHaveLength(1);
  });

  test("atomically commits and replays an authorized host round command", async () => {
    const occurredAt = new Date("2026-07-17T09:06:00.000Z");
    const connection = await connectWithRoundCommands(() => occurredAt);
    const state = createLobbyState();
    const command = EndRoundCommandSchema.parse({
      schemaVersion: 1,
      type: "end-round",
      commandId: `end-${randomUUID()}`,
    });
    await createPersistedLobby(connection, state);

    const execute = () =>
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[0]!.id,
        participantSessionId: state.sessions[0]!.id,
        command,
      });
    const committed = await execute();
    const replayed = await execute();
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(committed).toMatchObject({
      ok: true,
      acknowledgement: {
        commandId: command.commandId,
        scope: "active-lobby",
        eventSequence: 2,
        occurredAt,
        idempotentReplay: false,
      },
      participantPrivateEvents: [],
    });
    if (!committed.ok) throw new Error("Expected the realtime command to commit.");
    expect(ActiveLobbyEventSchema.safeParse(committed.activeLobbyEvent).success).toBe(true);
    expect(committed.activeLobbyEvent).toMatchObject({
      type: "round-end",
      eventSequence: 2,
      occurredAt: occurredAt.toISOString(),
    });
    expect(replayed).toEqual({
      ok: true,
      acknowledgement: {
        commandId: command.commandId,
        scope: "active-lobby",
        eventSequence: 2,
        occurredAt,
        idempotentReplay: true,
      },
      activeLobbyEvent: null,
      participantPrivateEvents: [],
    });
    expect(restored?.round?.stage).toBe("ended");
    expect(restored?.lobby.status).toBe("waiting");
    expect(restored?.events).toHaveLength(2);
    expect(JSON.stringify(restored?.events.at(-1)?.payload)).not.toMatch(
      /drawOrder|drawPositions|cards|cells/,
    );
  });

  test("notifies realtime subscribers after an HTTP fallback command commits", async () => {
    const occurredAt = new Date("2026-07-17T09:06:30.000Z");
    const publisher = await connectWithRoundCommands(() => occurredAt);
    const subscriber = await connectWithRoundCommands(() => occurredAt);
    const state = createLobbyState();
    const command = EndRoundCommandSchema.parse({
      schemaVersion: 1,
      type: "end-round",
      commandId: `http-fallback-end-${randomUUID()}`,
    });
    await createPersistedLobby(publisher, state);
    let resolveNotification!: (notification: ActiveLobbyEventNotification) => void;
    const notification = new Promise<ActiveLobbyEventNotification>((resolve) => {
      resolveNotification = resolve;
    });
    const subscription = await subscriber.activeLobbyEvents.subscribe(resolveNotification);

    try {
      await expect(
        publisher.roundCommands.execute({
          lobbyId: state.lobby.id,
          sessionTokenHash: state.sessions[0]!.tokenHash,
          command,
        }),
      ).resolves.toMatchObject({ ok: true });
      const observed = await Promise.race([
        notification,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for the committed event.")), 2_000);
        }),
      ]);

      expect({ ...observed, event: await observed.loadEvent() }).toMatchObject({
        lobbyId: state.lobby.id,
        sequence: 2n,
        event: {
          sequence: 2n,
          eventType: "round-end",
          schemaVersion: 1,
          createdAt: occurredAt,
        },
      });
    } finally {
      await subscription.close();
    }
  });

  test("reports active-lobby event listener failures to the subscriber", async () => {
    const occurredAt = new Date("2026-07-17T09:06:45.000Z");
    const publisher = await connectWithRoundCommands(() => occurredAt);
    const subscriber = await connectWithRoundCommands(() => occurredAt);
    const state = createLobbyState();
    const command = EndRoundCommandSchema.parse({
      schemaVersion: 1,
      type: "end-round",
      commandId: `listener-failure-end-${randomUUID()}`,
    });
    await createPersistedLobby(publisher, state);
    const subscription = await subscriber.activeLobbyEvents.subscribe(async () => {
      throw new Error("private listener detail");
    });
    const observedFailure = subscription.completion.then(
      () => null,
      (error: unknown) => error,
    );

    try {
      await expect(
        publisher.roundCommands.execute({
          lobbyId: state.lobby.id,
          sessionTokenHash: state.sessions[0]!.tokenHash,
          command,
        }),
      ).resolves.toMatchObject({ ok: true });
      const failure = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for subscription failure.")),
          2_000,
        );
        observedFailure.then(
          (error) => {
            clearTimeout(timeout);
            resolve(error);
          },
          (error: unknown) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
      });

      expect(failure).toEqual(new Error("Active-lobby event subscription failed."));
    } finally {
      await subscription.close();
    }
  });

  test("fails the subscription when a notified durable event is missing", async () => {
    const subscriber = await connectWithRoundCommands(() => new Date());
    const subscription = await subscriber.activeLobbyEvents.subscribe(async ({ loadEvent }) => {
      await loadEvent();
    });
    const observedFailure = subscription.completion.then(
      () => null,
      (error: unknown) => error,
    );

    try {
      await pool.query("SELECT pg_notify($1, $2)", [
        ACTIVE_LOBBY_EVENT_CHANNEL,
        encodeActiveLobbyEventReference(`missing-lobby-${randomUUID()}`, 1n),
      ]);
      const failure = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for missing-event failure.")),
          2_000,
        );
        observedFailure.then(
          (error) => {
            clearTimeout(timeout);
            resolve(error);
          },
          (error: unknown) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
      });

      expect(failure).toEqual(new Error("Active-lobby event subscription failed."));
    } finally {
      await subscription.close();
    }
  });

  test.each(["", "not-json"])(
    "fails the subscription when the active-event notification payload is malformed: %j",
    async (payload) => {
      const subscriber = await connectWithRoundCommands(() => new Date());
      const subscription = await subscriber.activeLobbyEvents.subscribe(async () => {});
      const observedFailure = subscription.completion.then(
        () => null,
        (error: unknown) => error,
      );

      try {
        await pool.query("SELECT pg_notify($1, $2)", [ACTIVE_LOBBY_EVENT_CHANNEL, payload]);
        const failure = await new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for malformed notification failure.")),
            2_000,
          );
          observedFailure.then(
            (error) => {
              clearTimeout(timeout);
              resolve(error);
            },
            (error: unknown) => {
              clearTimeout(timeout);
              reject(error);
            },
          );
        });

        expect(failure).toEqual(new Error("Active-lobby event subscription failed."));
      } finally {
        await subscription.close();
      }
    },
  );

  test("does not block one lobby's notifications behind another lobby", async () => {
    const subscriber = await connectWithRoundCommands(() => new Date());
    const first = createLobbyState();
    const second = createLobbyState();
    await createPersistedLobby(subscriber, first);
    await createPersistedLobby(subscriber, second);
    const firstStarted = deferredSignal();
    const releaseFirst = deferredSignal();
    const secondObserved = deferredSignal();
    const subscription = await subscriber.activeLobbyEvents.subscribe(async ({ lobbyId }) => {
      if (lobbyId === first.lobby.id) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      if (lobbyId === second.lobby.id) secondObserved.resolve();
    });

    try {
      await pool.query("SELECT pg_notify($1, $2)", [
        ACTIVE_LOBBY_EVENT_CHANNEL,
        encodeActiveLobbyEventReference(first.lobby.id, 1n),
      ]);
      await firstStarted.wait("first lobby notification");
      await pool.query("SELECT pg_notify($1, $2)", [
        ACTIVE_LOBBY_EVENT_CHANNEL,
        encodeActiveLobbyEventReference(second.lobby.id, 1n),
      ]);
      await secondObserved.wait("independent second lobby notification");
    } finally {
      releaseFirst.resolve();
      await subscription.close();
    }
  });

  test("commits create, configure, start, pause, resume, and call-next transitions", async () => {
    let now = new Date("2026-07-17T09:10:00.000Z");
    const connection = await connectWithRoundCommands(() => now);
    const initial = createLobbyState();
    const state: DurableLobbyState = {
      ...initial,
      lobby: {
        ...initial.lobby,
        status: "waiting",
        lastEventSequence: 0n,
        endedAt: null,
      },
      round: null,
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);
    const hostHash = state.sessions[0]!.tokenHash;
    const execute = (command: Parameters<typeof connection.roundCommands.execute>[0]["command"]) =>
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: hostHash,
        command,
      });

    const created = await execute(
      CreateRoundCommandSchema.parse({
        schemaVersion: 1,
        type: "create-round",
        commandId: `create-round-${randomUUID()}`,
      }),
    );
    let restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(created).toMatchObject({
      ok: true,
      acknowledgement: { scope: "active-lobby", eventSequence: 1 },
    });
    expect(restored?.round).toMatchObject({
      stage: "waiting",
      initialPatternId: "standard-one-line",
      callMode: "manual",
    });
    expect(restored?.round?.cards).toHaveLength(2);
    expect(restored?.round?.drawOrder).toHaveLength(75);
    expect(restored?.round?.drawOrder.map(({ position }) => position)).toEqual(
      Array.from({ length: 75 }, (_, index) => index + 1),
    );
    expect(
      [...new Set(restored?.round?.drawOrder.map(({ ball }) => ball))].sort(
        (left, right) => left - right,
      ),
    ).toEqual(Array.from({ length: 75 }, (_, index) => index + 1));
    expect(restored?.round?.cards.map(({ participantId }) => participantId).sort()).toEqual(
      state.participants.map(({ id }) => id).sort(),
    );
    expect(new Set(restored?.round?.cards.map(({ cells }) => cells.join(","))).size).toBe(2);
    for (const card of restored?.round?.cards ?? []) {
      expect(card.cells[12]).toBe(0);
      for (let column = 0; column < 5; column += 1) {
        const values = card.cells.filter((_, index) => index % 5 === column && index !== 12);
        expect(new Set(values).size).toBe(values.length);
        expect(values.every((value) => value >= column * 15 + 1 && value <= column * 15 + 15)).toBe(
          true,
        );
      }
    }

    now = new Date("2026-07-17T09:11:00.000Z");
    await expect(
      execute(
        ConfigureCommandSchema.parse({
          schemaVersion: 1,
          type: "configure",
          commandId: `configure-${randomUUID()}`,
          patternId: "standard-one-line",
          callConfiguration: { mode: "automatic", intervalSeconds: 30 },
        }),
      ),
    ).resolves.toMatchObject({ ok: true, acknowledgement: { eventSequence: 2 } });
    restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.round).toMatchObject({ callMode: "automatic", callIntervalSeconds: 30 });

    now = new Date("2026-07-17T09:12:00.000Z");
    await expect(
      execute(
        StartRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "start-round",
          commandId: `start-${randomUUID()}`,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, acknowledgement: { eventSequence: 3 } });
    restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.round).toMatchObject({
      stage: "active",
      nextCallAt: new Date("2026-07-17T09:12:30.000Z"),
    });

    now = new Date("2026-07-17T09:13:00.000Z");
    await expect(
      execute(
        PauseRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "pause-round",
          commandId: `pause-${randomUUID()}`,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, acknowledgement: { eventSequence: 4 } });
    restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.round).toMatchObject({
      stage: "paused",
      pauseReason: "host-command",
      nextCallAt: null,
    });

    now = new Date("2026-07-17T09:14:00.000Z");
    await expect(
      execute(
        ResumeRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "resume-round",
          commandId: `resume-${randomUUID()}`,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, acknowledgement: { eventSequence: 5 } });
    restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.round).toMatchObject({
      stage: "active",
      nextCallAt: new Date("2026-07-17T09:14:30.000Z"),
    });

    now = new Date("2026-07-17T09:15:00.000Z");
    await expect(
      execute(
        CallNextCommandSchema.parse({
          schemaVersion: 1,
          type: "call-next",
          commandId: `call-${randomUUID()}`,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, acknowledgement: { eventSequence: 6 } });
    restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.round?.calls).toEqual([
      expect.objectContaining({ position: 1, calledAt: now }),
    ]);
    expect(restored?.events).toHaveLength(6);
    expect(restored?.commandResults).toHaveLength(6);
  });

  test("recovers and commits automatic call leases exactly once", async () => {
    let now = new Date("2026-07-17T09:15:00.000Z");
    const connection = await connectWithRoundCommands(() => now);
    const initial = createLobbyState();
    const deadline = new Date(now);
    const state: DurableLobbyState = {
      ...initial,
      lobby: { ...initial.lobby, lastEventSequence: 0n },
      round: {
        ...initial.round!,
        stage: "active",
        pausedAt: null,
        pauseReason: null,
        nextCallAt: deadline,
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        coWinners: [],
      },
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);
    const automatic = connection.roundCommands;

    const leases = await automatic.findAutomaticCallLeases();
    const lease = leases.find(({ lobbyId }) => lobbyId === state.lobby.id);
    expect(lease).toEqual({ lobbyId: state.lobby.id, roundId: state.round!.id, deadline });
    let resolveNotification!: (notification: ActiveLobbyEventNotification) => void;
    const notification = new Promise<ActiveLobbyEventNotification>((resolve) => {
      resolveNotification = resolve;
    });
    const subscription = await connection.activeLobbyEvents.subscribe(resolveNotification);
    let observed: ActiveLobbyEventNotification;
    try {
      await expect(automatic.executeAutomaticCall(lease!)).resolves.toBe("called");
      observed = await Promise.race([
        notification,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Timed out waiting for the automatic call event.")),
            2_000,
          );
        }),
      ]);
    } finally {
      await subscription.close();
    }
    await expect(automatic.executeAutomaticCall(lease!)).resolves.toBe("stale");

    let restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.round?.calls).toEqual([
      state.round!.calls[0],
      expect.objectContaining({ position: 2, ball: 2, calledAt: now }),
    ]);
    expect(restored?.round?.nextCallAt).toEqual(new Date("2026-07-17T09:15:30.000Z"));
    expect(restored?.events).toEqual([
      expect.objectContaining({ sequence: 1n, eventType: "call", createdAt: now }),
    ]);
    await expect(observed!.loadEvent()).resolves.toMatchObject({
      sequence: 1n,
      eventType: "call",
      createdAt: now,
    });
    expect(restored?.commandResults).toEqual([]);

    const nextLease = await automatic.findAutomaticCallLease(state.lobby.id);
    expect(nextLease).toEqual({
      lobbyId: state.lobby.id,
      roundId: state.round!.id,
      deadline: new Date("2026-07-17T09:15:30.000Z"),
    });
    await expect(automatic.executeAutomaticCall(nextLease!)).resolves.toBe("too-early");
    now = nextLease!.deadline;
    await expect(automatic.executeAutomaticCall(nextLease!)).resolves.toBe("called");

    restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.round?.calls.map(({ position, ball }) => ({ position, ball }))).toEqual([
      { position: 1, ball: 1 },
      { position: 2, ball: 2 },
      { position: 3, ball: 3 },
    ]);
    expect(restored?.events.map(({ sequence }) => sequence)).toEqual([1n, 2n]);
  });

  test.each(["manual-first", "automatic-first"] as const)(
    "serializes host and automatic calls with %s lock ordering",
    async (order) => {
      const now = new Date("2026-07-17T09:15:45.000Z");
      const setupConnection = await connectWithRoundCommands(() => now);
      const manualConnection = await connectWithRoundCommands(() => now);
      const automaticConnection = await connectWithRoundCommands(() => now);
      const initial = createLobbyState();
      const state: DurableLobbyState = {
        ...initial,
        lobby: { ...initial.lobby, lastEventSequence: 0n },
        round: {
          ...initial.round!,
          stage: "active",
          pausedAt: null,
          pauseReason: null,
          nextCallAt: now,
          coWinnerTriggeringCallId: null,
          coWinnerOpenedAt: null,
          coWinnerClosesAt: null,
          resultSettledAt: null,
          coWinners: [],
        },
        events: [],
        commandResults: [],
      };
      await createPersistedLobby(setupConnection, state);
      const lease = { lobbyId: state.lobby.id, roundId: state.round!.id, deadline: now };
      const manual = () =>
        manualConnection.roundCommands.execute({
          lobbyId: state.lobby.id,
          sessionTokenHash: state.sessions[0]!.tokenHash,
          command: CallNextCommandSchema.parse({
            schemaVersion: 1,
            type: "call-next",
            commandId: `raced-manual-call-${order}-${randomUUID()}`,
          }),
        });
      const automatic = () => automaticConnection.roundCommands.executeAutomaticCall(lease);
      const blocker = await pool.connect();
      let transactionOpen = false;
      const operations: Promise<unknown>[] = [];
      try {
        await blocker.query("BEGIN");
        transactionOpen = true;
        await blocker.query(`SELECT id FROM lobbies WHERE id = $1 FOR UPDATE`, [state.lobby.id]);
        operations.push(order === "manual-first" ? manual() : automatic());
        await waitForBlockedCommandFences(1);
        operations.push(order === "manual-first" ? automatic() : manual());
        await waitForBlockedCommandFences(2);
        await blocker.query("ROLLBACK");
        transactionOpen = false;

        const results = await Promise.all(operations);
        expect(results).toEqual(
          order === "manual-first"
            ? [expect.objectContaining({ ok: true }), "stale"]
            : ["called", expect.objectContaining({ ok: true })],
        );
      } finally {
        if (transactionOpen) await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        await Promise.allSettled(operations);
      }

      const restored = await setupConnection.lobbyStates.findById(state.lobby.id);
      const expectedCallCount = order === "manual-first" ? 2 : 3;
      expect(restored?.round?.calls).toHaveLength(expectedCallCount);
      expect(restored?.round?.calls.map(({ position }) => position)).toEqual(
        Array.from({ length: expectedCallCount }, (_, index) => index + 1),
      );
      expect(new Set(restored?.round?.calls.map(({ ball }) => ball)).size).toBe(expectedCallCount);
      expect(restored?.events.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: expectedCallCount - 1 }, (_, index) => BigInt(index + 1)),
      );
    },
    15_000,
  );

  test.each(["PAUSED", "CO_WINNER_WINDOW", "RESULT", "ENDED"] as const)(
    "blocks manual and automatic calls while the round stage is %s",
    async (stage) => {
      const now = new Date("2026-07-17T09:15:50.000Z");
      const connection = await connectWithRoundCommands(() => now);
      const initial = createLobbyState();
      const state: DurableLobbyState = {
        ...initial,
        lobby: { ...initial.lobby, lastEventSequence: 0n },
        round: {
          ...initial.round!,
          stage: "active",
          pausedAt: null,
          pauseReason: null,
          nextCallAt: now,
          coWinnerTriggeringCallId: null,
          coWinnerOpenedAt: null,
          coWinnerClosesAt: null,
          resultSettledAt: null,
          coWinners: [],
        },
        events: [],
        commandResults: [],
      };
      await createPersistedLobby(connection, state);
      await pool.query(`UPDATE rounds SET stage = $2::round_stage WHERE id = $1`, [
        state.round!.id,
        stage,
      ]);
      const lease = { lobbyId: state.lobby.id, roundId: state.round!.id, deadline: now };

      await expect(connection.roundCommands.executeAutomaticCall(lease)).resolves.toBe("stale");
      await expect(
        connection.roundCommands.execute({
          lobbyId: state.lobby.id,
          sessionTokenHash: state.sessions[0]!.tokenHash,
          command: CallNextCommandSchema.parse({
            schemaVersion: 1,
            type: "call-next",
            commandId: `blocked-call-${stage}-${randomUUID()}`,
          }),
        }),
      ).resolves.toEqual({ ok: false, error: { code: "INVALID_COMMAND" } });

      const restored = await connection.lobbyStates.findById(state.lobby.id);
      expect(restored?.round?.calls).toEqual(state.round!.calls);
      expect(restored?.events).toEqual([]);
      expect(restored?.commandResults).toEqual([]);
    },
  );

  test("clears automatic scheduling after the final draw position", async () => {
    const now = new Date("2026-07-17T09:16:00.000Z");
    const connection = await connectWithRoundCommands(() => now);
    const initial = createLobbyState();
    const calls = initial.round!.drawOrder.slice(0, 74).map(({ position, ball }) => ({
      id: `call-final-${position}-${randomUUID()}`,
      position,
      ball,
      calledAt: new Date(now.getTime() - (75 - position) * 1_000),
    }));
    const state: DurableLobbyState = {
      ...initial,
      lobby: { ...initial.lobby, lastEventSequence: 0n },
      round: {
        ...initial.round!,
        stage: "active",
        pausedAt: null,
        pauseReason: null,
        nextCallAt: now,
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        calls,
        coWinners: [],
      },
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);

    const lease = await connection.roundCommands.findAutomaticCallLease(state.lobby.id);
    expect(lease).toEqual({ lobbyId: state.lobby.id, roundId: state.round!.id, deadline: now });
    await expect(connection.roundCommands.executeAutomaticCall(lease!)).resolves.toBe("called");
    await expect(connection.roundCommands.executeAutomaticCall(lease!)).resolves.toBe("stale");
    await expect(
      connection.roundCommands.findAutomaticCallLease(state.lobby.id),
    ).resolves.toBeNull();

    const restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.round?.calls).toHaveLength(75);
    expect(new Set(restored?.round?.calls.map(({ ball }) => ball)).size).toBe(75);
    expect(restored?.round?.nextCallAt).toBeNull();
    expect(restored?.events).toEqual([
      expect.objectContaining({ sequence: 1n, eventType: "call", createdAt: now }),
    ]);

    const exhaustedCommand = CallNextCommandSchema.parse({
      schemaVersion: 1,
      type: "call-next",
      commandId: `exhausted-host-call-${randomUUID()}`,
    });
    await expect(
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        command: exhaustedCommand,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "INVALID_COMMAND" } });
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      round: { calls: restored!.round!.calls, nextCallAt: null },
      events: restored!.events,
      commandResults: restored!.commandResults,
    });
  });

  test.each([
    {
      callConfiguration: { mode: "manual" } as const,
      expectedMode: "manual",
      expectedInterval: null,
    },
    ...([5, 10, 30, 60, 120] as const).map((intervalSeconds) => ({
      callConfiguration: { mode: "automatic" as const, intervalSeconds },
      expectedMode: "automatic" as const,
      expectedInterval: intervalSeconds,
    })),
  ])(
    "persists the supported $callConfiguration.mode/$expectedInterval call configuration",
    async ({ callConfiguration, expectedInterval, expectedMode }) => {
      const occurredAt = new Date("2026-07-17T09:15:30.000Z");
      const connection = await connectWithRoundCommands(() => occurredAt);
      const initial = createLobbyState();
      const state: DurableLobbyState = {
        ...initial,
        lobby: { ...initial.lobby, status: "waiting", lastEventSequence: 0n },
        round: null,
        events: [],
        commandResults: [],
      };
      await createPersistedLobby(connection, state);
      const execute = (
        command: Parameters<typeof connection.roundCommands.execute>[0]["command"],
      ) =>
        connection.roundCommands.execute({
          lobbyId: state.lobby.id,
          sessionTokenHash: state.sessions[0]!.tokenHash,
          command,
        });

      await expect(
        execute(
          CreateRoundCommandSchema.parse({
            schemaVersion: 1,
            type: "create-round",
            commandId: `create-configured-${randomUUID()}`,
          }),
        ),
      ).resolves.toMatchObject({ ok: true });
      if (callConfiguration.mode === "manual") {
        await expect(
          execute(
            ConfigureCommandSchema.parse({
              schemaVersion: 1,
              type: "configure",
              commandId: `configure-before-manual-${randomUUID()}`,
              patternId: "standard-one-line",
              callConfiguration: { mode: "automatic", intervalSeconds: 30 },
            }),
          ),
        ).resolves.toMatchObject({ ok: true });
      }
      await expect(
        execute(
          ConfigureCommandSchema.parse({
            schemaVersion: 1,
            type: "configure",
            commandId: `configure-supported-${randomUUID()}`,
            patternId: "standard-one-line",
            callConfiguration,
          }),
        ),
      ).resolves.toMatchObject({ ok: true });

      await expect(
        execute(
          StartRoundCommandSchema.parse({
            schemaVersion: 1,
            type: "start-round",
            commandId: `start-configured-${randomUUID()}`,
          }),
        ),
      ).resolves.toMatchObject({ ok: true });

      const expectedDeadline =
        callConfiguration.mode === "automatic"
          ? new Date(occurredAt.getTime() + callConfiguration.intervalSeconds * 1_000)
          : null;

      const restored = await connection.lobbyStates.findById(state.lobby.id);
      expect(restored).toMatchObject({
        round: {
          initialPatternId: "standard-one-line",
          currentPatternId: "standard-one-line",
          callMode: expectedMode,
          callIntervalSeconds: expectedInterval,
          nextCallAt: expectedDeadline,
        },
      });
      await expect(
        connection.roundCommands.findAutomaticCallLease(state.lobby.id),
      ).resolves.toEqual(
        expectedDeadline === null
          ? null
          : { lobbyId: state.lobby.id, roundId: restored!.round!.id, deadline: expectedDeadline },
      );
      if (callConfiguration.mode === "manual") {
        const playerCall = CallNextCommandSchema.parse({
          schemaVersion: 1,
          type: "call-next",
          commandId: `manual-player-call-${randomUUID()}`,
        });
        await expect(
          connection.roundCommands.execute({
            lobbyId: state.lobby.id,
            sessionTokenHash: state.sessions[1]!.tokenHash,
            command: playerCall,
          }),
        ).resolves.toEqual({ ok: false, error: { code: "FORBIDDEN" } });

        const hostCall = CallNextCommandSchema.parse({
          schemaVersion: 1,
          type: "call-next",
          commandId: `manual-host-call-${randomUUID()}`,
        });
        await expect(execute(hostCall)).resolves.toMatchObject({
          ok: true,
          acknowledgement: { commandId: hostCall.commandId, scope: "active-lobby" },
        });

        const manuallyAdvanced = await connection.lobbyStates.findById(state.lobby.id);
        expect(manuallyAdvanced?.round).toMatchObject({
          callMode: "manual",
          nextCallAt: null,
          calls: [expect.objectContaining({ position: 1, calledAt: occurredAt })],
        });
        expect(manuallyAdvanced?.events).toHaveLength(restored!.events.length + 1);
        expect(manuallyAdvanced?.commandResults).toHaveLength(restored!.commandResults.length + 1);
      }
    },
  );

  test("rolls back round state when unique card persistence fails", async () => {
    const occurredAt = new Date("2026-07-17T09:15:45.000Z");
    const connection = await connectWithRoundCommands(() => occurredAt, {
      nextId: (prefix) => (prefix === "card" ? "duplicate-card-id" : `${prefix}-${randomUUID()}`),
    });
    const initial = createLobbyState();
    const state: DurableLobbyState = {
      ...initial,
      lobby: { ...initial.lobby, status: "waiting", lastEventSequence: 0n },
      round: null,
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);

    await expect(
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        command: CreateRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "create-round",
          commandId: `create-rollback-${randomUUID()}`,
        }),
      }),
    ).rejects.toThrow();

    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      lobby: { status: "waiting", lastEventSequence: 0n },
      round: null,
      events: [],
      commandResults: [],
    });
  });

  test("queues an active-round join without letting their absence block current play", async () => {
    let now = new Date("2026-07-17T09:16:00.000Z");
    const connection = await connectWithRoundCommands(() => now);
    const initial = createLobbyState();
    const state: DurableLobbyState = {
      ...initial,
      lobby: { ...initial.lobby, lastEventSequence: 0n },
      round: {
        ...initial.round!,
        stage: "active",
        pausedAt: null,
        pauseReason: null,
        nextCallAt: new Date("2026-07-17T09:16:30.000Z"),
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
    await createPersistedLobby(connection, state);
    const suffix = randomUUID();
    const tokenHash = new Uint8Array(randomBytes(32));
    const admitted = await connection.lobbyStates.joinLobbyWithSession({
      lobbyId: state.lobby.id,
      lobbyCode: state.lobby.code,
      participantId: `participant-late-${suffix}`,
      sessionId: `session-late-${suffix}`,
      commandId: `join-late-${suffix}`,
      username: "Late Round Player",
      tokenHash,
      issuedAt: now,
      maxPlayersPerLobby: 3,
    });
    if (!admitted.ok) throw new Error(admitted.error.message);

    await expect(
      connection.lobbyStates.findAuthorizedSnapshot({ lobbyId: state.lobby.id, tokenHash }),
    ).resolves.toMatchObject({
      self: { id: admitted.entry.participantId, roundEligibility: "waiting" },
      ownCard: null,
      ownMarks: [],
      calls: state.round!.calls.map(({ id, position, ball, calledAt }) => ({
        id,
        roundId: state.round!.id,
        position,
        ball,
        calledAt: calledAt.toISOString(),
      })),
    });
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: admitted.entry.participantId,
        participantSessionId: admitted.entry.sessionId,
        command: MarkCardCommandSchema.parse({
          schemaVersion: 1,
          type: "mark-card",
          commandId: `mark-late-${suffix}`,
          ball: state.round!.calls[0]!.ball,
        }),
      }),
    ).resolves.toEqual({ ok: false, error: { code: "INVALID_COMMAND" } });

    const identity = {
      lobbyId: state.lobby.id,
      participantId: admitted.entry.participantId,
      participantSessionId: admitted.entry.sessionId,
    };
    const generation = await connection.lobbyStates.registerRealtimeConnection(identity);
    if (generation === null) throw new Error("Expected the waiting participant to connect.");
    expect(generation).toBe(2);
    const grace = await connection.lobbyStates.unregisterRealtimeConnection({
      ...identity,
      presenceGeneration: generation,
      reconnectWindowSeconds: 120,
      disconnectPauseGraceSeconds: 10,
    });
    if (grace === null)
      throw new Error("Expected the final waiting-player connection to enter grace.");
    now = grace.graceEndsAt;

    await expect(connection.lobbyStates.expireRealtimePresenceGrace(grace)).resolves.toBe(
      "expired",
    );
    await expect(connection.lobbyStates.findById(state.lobby.id)).resolves.toMatchObject({
      round: { id: state.round!.id, stage: "active", pauseReason: null },
    });
    await expect(
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        command: CallNextCommandSchema.parse({
          schemaVersion: 1,
          type: "call-next",
          commandId: `call-after-late-absence-${suffix}`,
        }),
      }),
    ).resolves.toMatchObject({ ok: true });

    now = new Date("2026-07-17T09:18:00.000Z");
    const replacementTokenHash = new Uint8Array(randomBytes(32));
    const replacement = await connection.lobbyStates.joinLobbyWithSession({
      lobbyId: state.lobby.id,
      lobbyCode: state.lobby.code,
      participantId: `participant-replacement-${suffix}`,
      sessionId: `session-replacement-${suffix}`,
      commandId: `join-replacement-${suffix}`,
      username: "Replacement Round Player",
      tokenHash: replacementTokenHash,
      issuedAt: now,
      maxPlayersPerLobby: 3,
    });
    if (!replacement.ok) throw new Error(replacement.error.message);
    await expect(
      connection.lobbyStates.resolveParticipantSessionByTokenHash({
        lobbyId: state.lobby.id,
        tokenHash,
      }),
    ).resolves.toBeNull();
    await expect(
      connection.lobbyStates.findAuthorizedSnapshot({
        lobbyId: state.lobby.id,
        tokenHash: replacementTokenHash,
      }),
    ).resolves.toMatchObject({
      self: { id: replacement.entry.participantId, roundEligibility: "waiting" },
      ownCard: null,
      ownMarks: [],
    });
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: replacement.entry.participantId,
        participantSessionId: replacement.entry.sessionId,
        command: MarkCardCommandSchema.parse({
          schemaVersion: 1,
          type: "mark-card",
          commandId: `mark-replacement-${suffix}`,
          ball: state.round!.calls[0]!.ball,
        }),
      }),
    ).resolves.toEqual({ ok: false, error: { code: "INVALID_COMMAND" } });

    now = new Date("2026-07-17T09:18:01.000Z");
    await expect(
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        command: EndRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "end-round",
          commandId: `end-for-late-player-${suffix}`,
        }),
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        command: CreateRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "create-round",
          commandId: `next-round-for-late-player-${suffix}`,
        }),
      }),
    ).resolves.toMatchObject({ ok: true });

    const restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(
      restored?.participants.find(({ id }) => id === admitted.entry.participantId),
    ).toMatchObject({
      roundEligibility: "waiting",
      departedAt: new Date("2026-07-17T09:18:00.000Z"),
    });
    expect(
      restored?.participants.find(({ id }) => id === replacement.entry.participantId),
    ).toMatchObject({ roundEligibility: "playing", departedAt: null });
    expect(restored?.round?.cards.map(({ participantId }) => participantId)).toContain(
      replacement.entry.participantId,
    );
    expect(restored?.round?.cards.map(({ participantId }) => participantId)).not.toContain(
      admitted.entry.participantId,
    );
  });

  test("continues a settled One Line result without replacing round play state", async () => {
    const occurredAt = new Date("2026-07-17T09:16:00.000Z");
    const connection = await connectWithRoundCommands(() => occurredAt);
    const state = createLobbyState();
    await createPersistedLobby(connection, state);
    const command = ContinueRoundCommandSchema.parse({
      schemaVersion: 1,
      type: "continue-round",
      commandId: `continue-${randomUUID()}`,
      patternId: "standard-two-lines",
    });

    await expect(
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        command,
      }),
    ).resolves.toMatchObject({ ok: true, acknowledgement: { eventSequence: 2 } });
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(restored?.round).toMatchObject({
      id: state.round!.id,
      stage: "active",
      currentPatternId: "standard-two-lines",
      cards: state.round!.cards,
      calls: state.round!.calls,
      coWinners: [],
    });
  });

  test("preserves command replay intent when an ended round is replaced", async () => {
    const occurredAt = new Date("2026-07-17T09:17:00.000Z");
    const connection = await connectWithRoundCommands(() => occurredAt);
    const initial = createLobbyState();
    const priorCommand = StartRoundCommandSchema.parse({
      schemaVersion: 1,
      type: "start-round",
      commandId: `prior-start-${randomUUID()}`,
    });
    const priorPrivateCommand = MarkCardCommandSchema.parse({
      schemaVersion: 1,
      type: "mark-card",
      commandId: `prior-mark-${randomUUID()}`,
      ball: 1,
    });
    const state: DurableLobbyState = {
      ...initial,
      lobby: { ...initial.lobby, status: "waiting" },
      round: { ...initial.round!, stage: "ended", endedAt: initial.round!.resultSettledAt },
      commandResults: [
        ...initial.commandResults,
        {
          participantId: initial.participants[0]!.id,
          commandId: priorCommand.commandId,
          roundId: initial.round!.id,
          commandType: priorCommand.type,
          deliveryScope: "active-lobby",
          eventSequence: 1n,
          result: { intent: priorCommand },
          createdAt: initial.round!.startedAt!,
        },
        {
          participantId: initial.participants[0]!.id,
          commandId: priorPrivateCommand.commandId,
          roundId: initial.round!.id,
          commandType: priorPrivateCommand.type,
          deliveryScope: "participant-private",
          eventSequence: null,
          result: {
            intent: priorPrivateCommand,
            participantPrivateProgress: {
              patternId: initial.round!.currentPatternId,
              calledCells: initial.round!.cards[0]!.cells.map((ball) => ball === 0 || ball === 1),
              markedCells: initial.round!.cards[0]!.cells.map((ball) => ball === 0 || ball === 1),
              nearWinFeedbackEnabled: true,
            },
            participantPrivateEvents: [
              {
                schemaVersion: 1,
                type: "mark-result",
                commandId: priorPrivateCommand.commandId,
                occurredAt: initial.round!.startedAt!.toISOString(),
                mark: {
                  id: initial.round!.cards[0]!.marks[0]!.id,
                  cardId: initial.round!.cards[0]!.id,
                  ball: 1,
                  markedAt: initial.round!.cards[0]!.marks[0]!.markedAt.toISOString(),
                },
              },
              {
                schemaVersion: 1,
                type: "near-win",
                occurredAt: initial.round!.startedAt!.toISOString(),
                requiredBall: 2,
              },
            ],
          },
          createdAt: initial.round!.startedAt!,
        },
      ],
    };
    await createPersistedLobby(connection, state);
    await connection.roundCommands.execute({
      lobbyId: state.lobby.id,
      sessionTokenHash: state.sessions[0]!.tokenHash,
      command: CreateRoundCommandSchema.parse({
        schemaVersion: 1,
        type: "create-round",
        commandId: `replacement-${randomUUID()}`,
      }),
    });

    const replayed = await connection.roundCommands.execute({
      lobbyId: state.lobby.id,
      sessionTokenHash: state.sessions[0]!.tokenHash,
      command: priorCommand,
    });
    const privateReplay = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[0]!.id,
      participantSessionId: state.sessions[0]!.id,
      command: priorPrivateCommand,
    });
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(replayed).toMatchObject({
      ok: true,
      acknowledgement: {
        commandId: priorCommand.commandId,
        scope: "active-lobby",
        eventSequence: 1,
        occurredAt: initial.round!.startedAt,
        idempotentReplay: true,
      },
    });
    expect(restored?.round?.stage).toBe("waiting");
    expect(restored?.events).toEqual([
      { ...initial.events[0]!, roundId: null },
      expect.objectContaining({ sequence: 2n, roundId: restored?.round?.id }),
    ]);
    expect(
      restored?.commandResults.find(
        ({ commandId }) => commandId === initial.commandResults[0]!.commandId,
      ),
    ).toEqual({ ...initial.commandResults[0]!, roundId: null });
    expect(
      restored?.commandResults.find(({ commandId }) => commandId === priorCommand.commandId),
    ).toEqual({
      participantId: initial.participants[0]!.id,
      commandId: priorCommand.commandId,
      roundId: null,
      commandType: priorCommand.type,
      deliveryScope: "active-lobby",
      eventSequence: 1n,
      result: { intent: priorCommand },
      createdAt: initial.round!.startedAt,
    });
    expect(privateReplay).toMatchObject({
      ok: true,
      acknowledgement: {
        commandId: priorPrivateCommand.commandId,
        scope: "participant-private",
        eventSequence: null,
        idempotentReplay: true,
      },
      activeLobbyEvent: null,
      participantPrivateEvents: [],
    });
    expect(
      restored?.commandResults.find(({ commandId }) => commandId === priorPrivateCommand.commandId),
    ).toEqual({
      participantId: initial.participants[0]!.id,
      commandId: priorPrivateCommand.commandId,
      roundId: null,
      commandType: priorPrivateCommand.type,
      deliveryScope: "participant-private",
      eventSequence: null,
      result: { intent: priorPrivateCommand },
      createdAt: initial.round!.startedAt,
    });
  });

  test("expires due participant sessions before selecting a replacement-round roster", async () => {
    const occurredAt = new Date("2026-07-17T09:17:00.000Z");
    const rejoinUntil = new Date("2026-07-17T09:16:00.000Z");
    const connection = await connectWithRoundCommands(() => occurredAt);
    const initial = createLobbyState();
    const player = initial.participants[1]!;
    const playerSession = initial.sessions[1]!;
    const state: DurableLobbyState = {
      ...initial,
      lobby: { ...initial.lobby, status: "waiting" },
      round: { ...initial.round!, stage: "ended", endedAt: initial.round!.resultSettledAt },
      sessions: initial.sessions.map((session) =>
        session.id === playerSession.id
          ? {
              ...session,
              status: "disconnected",
              disconnectedAt: new Date("2026-07-17T09:14:00.000Z"),
              rejoinUntil,
            }
          : session,
      ),
    };
    await createPersistedLobby(connection, state);

    await expect(
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        command: CreateRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "create-round",
          commandId: `replacement-after-expiry-${randomUUID()}`,
        }),
      }),
    ).resolves.toMatchObject({ ok: true });
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(restored?.participants.find(({ id }) => id === player.id)).toMatchObject({
      departedAt: rejoinUntil,
    });
    expect(restored?.sessions.find(({ id }) => id === playerSession.id)).toMatchObject({
      status: "departed",
      departedAt: rejoinUntil,
    });
    expect(restored?.round?.cards.map(({ participantId }) => participantId)).toEqual([
      initial.participants[0]!.id,
    ]);
  });

  test("rejects changed replay intent without mutating the configured round", async () => {
    const connection = await connectWithRoundCommands(() => new Date("2026-07-17T09:18:00.000Z"));
    const initial = createLobbyState();
    const state: DurableLobbyState = {
      ...initial,
      lobby: { ...initial.lobby, status: "waiting", lastEventSequence: 0n },
      round: {
        ...initial.round!,
        stage: "waiting",
        startedAt: null,
        activeAt: null,
        resultSettledAt: null,
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        calls: [],
        cards: initial.round!.cards.map((card) => ({ ...card, marks: [] })),
        coWinners: [],
      },
      events: [],
      commandResults: [],
    };
    const commandId = `configure-replay-${randomUUID()}`;
    await createPersistedLobby(connection, state);
    const execute = (intervalSeconds: 30 | 60) =>
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        command: ConfigureCommandSchema.parse({
          schemaVersion: 1,
          type: "configure",
          commandId,
          patternId: "standard-one-line",
          callConfiguration: { mode: "automatic", intervalSeconds },
        }),
      });

    await expect(execute(30)).resolves.toMatchObject({ ok: true });
    await expect(execute(60)).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_COMMAND" },
    });
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(restored?.round?.callIntervalSeconds).toBe(30);
    expect(restored?.events).toHaveLength(1);
    expect(restored?.commandResults).toHaveLength(1);
  });

  test("rejects cross-lobby and inactive session credentials before command mutation", async () => {
    const occurredAt = new Date("2026-07-17T09:19:00.000Z");
    const connection = await connectWithRoundCommands(() => occurredAt);
    const first = createLobbyState();
    const second = createLobbyState();
    const command = EndRoundCommandSchema.parse({
      schemaVersion: 1,
      type: "end-round",
      commandId: `unauthorized-end-${randomUUID()}`,
    });
    await createPersistedLobby(connection, first);
    await createPersistedLobby(connection, second);

    await expect(
      connection.roundCommands.execute({
        lobbyId: second.lobby.id,
        sessionTokenHash: first.sessions[0]!.tokenHash,
        command,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "UNAUTHORIZED" } });
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: first.lobby.id,
        participantId: first.participants[1]!.id,
        participantSessionId: first.sessions[0]!.id,
        command,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "UNAUTHORIZED" } });
    await connection.lobbyStates.markParticipantSessionDisconnected({
      lobbyId: first.lobby.id,
      sessionId: first.sessions[0]!.id,
      reconnectWindowSeconds: 120,
    });
    await expect(
      connection.roundCommands.execute({
        lobbyId: first.lobby.id,
        sessionTokenHash: first.sessions[0]!.tokenHash,
        command,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "UNAUTHORIZED" } });

    await expect(connection.lobbyStates.findById(first.lobby.id)).resolves.toMatchObject({
      round: { stage: "result" },
      events: first.events,
      commandResults: first.commandResults,
    });
    await expect(connection.lobbyStates.findById(second.lobby.id)).resolves.toMatchObject({
      round: { stage: "result" },
      events: second.events,
      commandResults: second.commandResults,
    });
  });

  test("serializes concurrent duplicate round commands into one committed effect", async () => {
    const occurredAt = new Date("2026-07-17T09:20:00.000Z");
    const setupConnection = await connectWithRoundCommands(() => occurredAt);
    const firstConnection = await connectWithRoundCommands(() => occurredAt);
    const secondConnection = await connectWithRoundCommands(() => occurredAt);
    const state = createLobbyState();
    const command = EndRoundCommandSchema.parse({
      schemaVersion: 1,
      type: "end-round",
      commandId: `concurrent-end-${randomUUID()}`,
    });
    await createPersistedLobby(setupConnection, state);
    const execute = (connection: Awaited<ReturnType<typeof connectDatabase>>) =>
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[0]!.tokenHash,
        command,
      });

    const results = await Promise.all([execute(firstConnection), execute(secondConnection)]);
    const restored = await setupConnection.lobbyStates.findById(state.lobby.id);

    expect(
      results.map((result) => (result.ok ? result.acknowledgement.idempotentReplay : null)).sort(),
    ).toEqual([false, true]);
    expect(restored?.round?.stage).toBe("ended");
    expect(restored?.events).toHaveLength(2);
    expect(restored?.commandResults).toHaveLength(2);
  });

  test("authorizes a private mark against only the authenticated participant card", async () => {
    const occurredAt = new Date("2026-07-17T09:07:00.000Z");
    const connection = await connectWithRoundCommands(() => occurredAt);
    const base = createLobbyState();
    const playerCard = base.round!.cards[1]!;
    const state: DurableLobbyState = {
      ...base,
      lobby: {
        ...base.lobby,
        lastEventSequence: 0n,
        lastActivityAt: new Date("2026-07-17T10:00:00.000Z"),
      },
      round: {
        ...base.round!,
        stage: "active",
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        coWinners: [],
        cards: [
          base.round!.cards[0]!,
          { ...playerCard, cells: [1, ...playerCard.cells.slice(1)], marks: [] },
        ],
      },
      events: [],
      commandResults: [],
    };
    const command = MarkCardCommandSchema.parse({
      schemaVersion: 1,
      type: "mark-card",
      commandId: `mark-${randomUUID()}`,
      ball: 1,
    });
    await createPersistedLobby(connection, state);

    const committed = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    const replayed = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    if (!committed.ok) throw new Error("Expected the private mark to commit.");
    await pool.query(
      `UPDATE command_results
          SET result = result - 'participantPrivateEvents'
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId],
    );
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: state.sessions[1]!.id,
        command,
      }),
    ).rejects.toThrow();
    await pool.query(
      `UPDATE command_results
          SET result = jsonb_set(result, '{participantPrivateEvent}', $3::jsonb)
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId, JSON.stringify(committed.participantPrivateEvents[0])],
    );
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: state.sessions[1]!.id,
        command,
      }),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `UPDATE command_results
            SET result_format = 1,
                result = jsonb_build_object(
                  'intent', result->'intent',
                  'participantPrivateEvent', result->'participantPrivateEvent'
                )
          WHERE lobby_id = $1 AND command_id = $2`,
        [state.lobby.id, command.commandId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `UPDATE command_results
            SET delivery_scope = 'ACTIVE_LOBBY', event_sequence = 1
          WHERE lobby_id = $1 AND command_id = $2`,
        [state.lobby.id, command.commandId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `UPDATE command_results
          SET result = jsonb_build_object(
            'intent', result->'intent',
            'participantPrivateProgress', result->'participantPrivateProgress',
            'participantPrivateEvents', $3::jsonb
          )
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId, JSON.stringify(committed.participantPrivateEvents)],
    );
    const restoredReplay = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(committed).toMatchObject({
      ok: true,
      acknowledgement: {
        scope: "participant-private",
        eventSequence: null,
        idempotentReplay: false,
      },
      activeLobbyEvent: null,
      participantPrivateEvents: [
        {
          type: "mark-result",
          commandId: command.commandId,
          occurredAt: occurredAt.toISOString(),
          mark: {
            cardId: playerCard.id,
            ball: 1,
            markedAt: occurredAt.toISOString(),
          },
        },
      ],
    });
    expect(replayed).toMatchObject({
      ok: true,
      acknowledgement: { eventSequence: null, idempotentReplay: true },
      activeLobbyEvent: null,
      participantPrivateEvents: committed.ok ? committed.participantPrivateEvents : [],
    });
    expect(restoredReplay).toMatchObject({
      ok: true,
      acknowledgement: {
        scope: "participant-private",
        eventSequence: null,
        idempotentReplay: true,
      },
      activeLobbyEvent: null,
      participantPrivateEvents: [committed.participantPrivateEvents[0]],
    });
    expect(
      committed.participantPrivateEvents.every(
        (event) => ParticipantPrivateEventSchema.safeParse(event).success,
      ),
    ).toBe(true);
    expect(restored?.lobby.lastEventSequence).toBe(0n);
    expect(restored?.lobby.lastActivityAt).toEqual(new Date("2026-07-17T10:00:00.000Z"));
    expect(restored?.round?.cards[0]?.marks).toHaveLength(1);
    expect(restored?.round?.cards[1]?.marks).toEqual([
      expect.objectContaining({ ball: 1, markedAt: occurredAt }),
    ]);
  });

  test("replays legacy private marks and rejects unverified private batches", async () => {
    const connection = await connectWithRoundCommands(() => new Date("2026-07-17T09:07:15.000Z"));
    const initial = createLobbyState();
    const hostCard = initial.round!.cards[0]!;
    const persistedMark = hostCard.marks[0]!;
    const command = MarkCardCommandSchema.parse({
      schemaVersion: 1,
      type: "mark-card",
      commandId: `legacy-mark-${randomUUID()}`,
      ball: persistedMark.ball,
    });
    const legacyEvent = ParticipantPrivateEventSchema.parse({
      schemaVersion: 1,
      type: "mark-result",
      commandId: command.commandId,
      occurredAt: persistedMark.markedAt.toISOString(),
      mark: {
        id: persistedMark.id,
        cardId: hostCard.id,
        ball: persistedMark.ball,
        markedAt: persistedMark.markedAt.toISOString(),
      },
    });
    const state: DurableLobbyState = {
      ...initial,
      commandResults: [
        ...initial.commandResults,
        {
          participantId: initial.participants[0]!.id,
          commandId: command.commandId,
          roundId: initial.round!.id,
          commandType: command.type,
          deliveryScope: "participant-private",
          eventSequence: null,
          result: { intent: command, participantPrivateEvent: legacyEvent },
          createdAt: persistedMark.markedAt,
        },
      ],
    };
    await createPersistedLobby(connection, state);

    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[0]!.id,
        participantSessionId: state.sessions[0]!.id,
        command,
      }),
    ).resolves.toMatchObject({
      ok: true,
      acknowledgement: { idempotentReplay: true, scope: "participant-private" },
      participantPrivateEvents: [legacyEvent],
    });
    await pool.query(
      `UPDATE command_results
          SET result_format = 2
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId],
    );
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[0]!.id,
        participantSessionId: state.sessions[0]!.id,
        command,
      }),
    ).rejects.toThrow("Unverified participant-private result format is not replayable.");
  });

  test("rejects uncalled and foreign-card marks without changing durable state", async () => {
    const occurredAt = new Date("2026-07-17T09:07:30.000Z");
    const connection = await connectWithRoundCommands(() => occurredAt);
    const base = createLobbyState();
    const state: DurableLobbyState = {
      ...base,
      lobby: {
        ...base.lobby,
        lastEventSequence: 0n,
        lastActivityAt: new Date("2026-07-17T08:03:00.000Z"),
      },
      round: {
        ...base.round!,
        stage: "active",
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        coWinners: [],
      },
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);
    const executeMark = (commandId: string, ball: number) =>
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: state.sessions[1]!.id,
        command: MarkCardCommandSchema.parse({
          schemaVersion: 1,
          type: "mark-card",
          commandId,
          ball,
        }),
      });

    await expect(executeMark(`mark-uncalled-${randomUUID()}`, 6)).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_COMMAND" },
    });
    await expect(executeMark(`mark-foreign-card-${randomUUID()}`, 1)).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_COMMAND" },
    });

    const restored = await connection.lobbyStates.findById(state.lobby.id);
    expect(restored?.lobby).toMatchObject({
      lastEventSequence: 0n,
      lastActivityAt: state.lobby.lastActivityAt,
    });
    expect(
      restored?.round?.cards.find(
        ({ participantId }) => participantId === state.participants[1]!.id,
      )?.marks,
    ).toEqual([]);
    expect(restored?.events).toEqual([]);
    expect(restored?.commandResults).toEqual([]);
  });

  test("deduplicates repeated marks across command IDs and repository instances", async () => {
    let now = new Date("2026-07-17T09:07:45.000Z");
    const markId = `mark-idempotent-${randomUUID()}`;
    const connection = await connectWithRoundCommands(() => now, {
      nextId: (prefix) => (prefix === "mark" ? markId : `${prefix}-${randomUUID()}`),
    });
    const base = createLobbyState();
    const playerCard = base.round!.cards[1]!;
    const state: DurableLobbyState = {
      ...base,
      lobby: { ...base.lobby, lastEventSequence: 0n },
      round: {
        ...base.round!,
        stage: "active",
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        coWinners: [],
        cards: [
          base.round!.cards[0]!,
          { ...playerCard, cells: [1, ...playerCard.cells.slice(1)], marks: [] },
        ],
      },
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);
    const executeMark = (commandId: string) =>
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: state.sessions[1]!.id,
        command: MarkCardCommandSchema.parse({
          schemaVersion: 1,
          type: "mark-card",
          commandId,
          ball: 1,
        }),
      });

    const first = await executeMark(`mark-first-${randomUUID()}`);
    now = new Date("2026-07-17T09:07:46.000Z");
    const repeated = await executeMark(`mark-repeated-${randomUUID()}`);
    const restoredConnection = await connect();
    const restored = await restoredConnection.lobbyStates.findById(state.lobby.id);
    const restoredSnapshot = await restoredConnection.lobbyStates.findAuthorizedSnapshot({
      lobbyId: state.lobby.id,
      tokenHash: state.sessions[1]!.tokenHash,
    });

    expect(first).toMatchObject({
      ok: true,
      acknowledgement: {
        scope: "participant-private",
        eventSequence: null,
        idempotentReplay: false,
      },
      activeLobbyEvent: null,
      participantPrivateEvents: [
        {
          type: "mark-result",
          mark: {
            id: markId,
            cardId: playerCard.id,
            ball: 1,
            markedAt: "2026-07-17T09:07:45.000Z",
          },
        },
      ],
    });
    expect(repeated).toMatchObject({
      ok: true,
      acknowledgement: {
        scope: "participant-private",
        eventSequence: null,
        idempotentReplay: false,
      },
      activeLobbyEvent: null,
      participantPrivateEvents: [
        {
          type: "mark-result",
          occurredAt: "2026-07-17T09:07:46.000Z",
          mark: {
            id: markId,
            cardId: playerCard.id,
            ball: 1,
            markedAt: "2026-07-17T09:07:45.000Z",
          },
        },
      ],
    });
    expect(restored?.lobby.lastEventSequence).toBe(0n);
    expect(
      restored?.round?.cards.find(
        ({ participantId }) => participantId === state.participants[1]!.id,
      )?.marks,
    ).toEqual([
      {
        id: markId,
        ball: 1,
        markedAt: new Date("2026-07-17T09:07:45.000Z"),
      },
    ]);
    expect(restored?.events).toEqual([]);
    expect(restored?.commandResults).toHaveLength(2);
    expect(restoredSnapshot).toMatchObject({
      ownCard: { id: playerCard.id },
      ownMarks: [
        {
          id: markId,
          cardId: playerCard.id,
          ball: 1,
          markedAt: "2026-07-17T09:07:45.000Z",
        },
      ],
    });
  });

  test("emits authoritative near-win feedback privately for one required called number", async () => {
    const occurredAt = new Date("2026-07-17T09:07:50.000Z");
    let now = occurredAt;
    const connection = await connectWithRoundCommands(() => now);
    const base = createLobbyState();
    const playerCard = base.round!.cards[1]!;
    const firstRow = playerCard.cells.slice(0, 5);
    const calledBalls = firstRow.slice(0, 5);
    const persistedCalls = [1, ...calledBalls];
    const drawBalls = [
      ...persistedCalls,
      ...Array.from({ length: 75 }, (_, index) => index + 1),
    ].filter((ball, index, balls) => balls.indexOf(ball) === index);
    const state: DurableLobbyState = {
      ...base,
      lobby: { ...base.lobby, lastEventSequence: 0n },
      round: {
        ...base.round!,
        stage: "active",
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        coWinners: [],
        drawOrder: drawBalls.map((ball, index) => ({ position: index + 1, ball })),
        calls: persistedCalls.map((ball, index) => ({
          id: `call-near-win-${index}-${randomUUID()}`,
          position: index + 1,
          ball,
          calledAt: new Date(occurredAt.getTime() - (calledBalls.length - index) * 1_000),
        })),
        cards: base.round!.cards.map((card) =>
          card.id === playerCard.id
            ? {
                ...card,
                marks: calledBalls.slice(0, 3).map((ball, index) => ({
                  id: `mark-near-win-${index}-${randomUUID()}`,
                  ball,
                  markedAt: new Date(occurredAt.getTime() - (3 - index) * 1_000),
                })),
              }
            : card,
        ),
      },
      events: [],
      commandResults: [],
    };
    const command = MarkCardCommandSchema.parse({
      schemaVersion: 1,
      type: "mark-card",
      commandId: `mark-near-win-${randomUUID()}`,
      ball: calledBalls[3],
    });
    await createPersistedLobby(connection, state);

    const committed = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    if (!committed.ok) throw new Error("Expected near-win feedback to commit.");
    const replayed = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    const persistedPrivateResult = await pool.query<{
      result_format: number;
      integrity_length: number;
      pattern_id: string;
      pattern_version: number;
    }>(
      `SELECT result_format,
              octet_length(result_integrity)::int AS integrity_length,
              result->'participantPrivateProgress'->'pattern'->>'id' AS pattern_id,
              (result->'participantPrivateProgress'->'pattern'->>'version')::int AS pattern_version
         FROM command_results
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId],
    );
    expect(persistedPrivateResult.rows).toEqual([
      {
        result_format: 3,
        integrity_length: 32,
        pattern_id: state.round!.currentPatternId,
        pattern_version: 1,
      },
    ]);
    await expect(
      pool.query(
        `UPDATE command_results
            SET result_integrity = NULL
          WHERE lobby_id = $1 AND command_id = $2`,
        [state.lobby.id, command.commandId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const mutedConnection = await connectWithRoundCommands(() => occurredAt, {
      nearWinFeedbackEnabled: false,
    });
    const replayedWithFeedbackDisabled = await mutedConnection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    const completionCommand = MarkCardCommandSchema.parse({
      schemaVersion: 1,
      type: "mark-card",
      commandId: `complete-after-near-win-${randomUUID()}`,
      ball: firstRow[4],
    });
    now = occurredAt;
    const completed = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command: completionCommand,
    });
    expect(completed).toMatchObject({ ok: true });
    const replayedAfterProgressChanged = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    now = new Date(occurredAt.getTime() + 2_000);
    await pool.query(
      `UPDATE rounds
          SET stage = 'RESULT', result_settled_at = $2
        WHERE id = $1`,
      [state.round!.id, now],
    );
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[0]!.id,
        participantSessionId: state.sessions[0]!.id,
        command: ContinueRoundCommandSchema.parse({
          schemaVersion: 1,
          type: "continue-round",
          commandId: `continue-after-near-win-${randomUUID()}`,
          patternId: "standard-two-lines",
        }),
      }),
    ).resolves.toMatchObject({ ok: true });
    const replayedAfterContinuation = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    expect(committed).toMatchObject({
      ok: true,
      acknowledgement: { scope: "participant-private", idempotentReplay: false },
      activeLobbyEvent: null,
      participantPrivateEvents: [
        { type: "mark-result", commandId: command.commandId, mark: { ball: calledBalls[3] } },
        { type: "near-win", requiredBall: firstRow[4] },
      ],
    });
    expect(replayed).toMatchObject({
      ok: true,
      acknowledgement: { scope: "participant-private", idempotentReplay: true },
      participantPrivateEvents:
        committed.ok && "participantPrivateEvents" in committed
          ? committed.participantPrivateEvents
          : [],
    });
    expect(replayedWithFeedbackDisabled).toMatchObject({
      ok: true,
      acknowledgement: { scope: "participant-private", idempotentReplay: true },
      participantPrivateEvents:
        committed.ok && "participantPrivateEvents" in committed
          ? committed.participantPrivateEvents
          : [],
    });
    expect(replayedAfterProgressChanged).toMatchObject({
      ok: true,
      acknowledgement: { scope: "participant-private", idempotentReplay: true },
      participantPrivateEvents:
        committed.ok && "participantPrivateEvents" in committed
          ? committed.participantPrivateEvents
          : [],
    });
    expect(replayedAfterContinuation).toMatchObject({
      ok: true,
      acknowledgement: { scope: "participant-private", idempotentReplay: true },
      participantPrivateEvents:
        committed.ok && "participantPrivateEvents" in committed
          ? committed.participantPrivateEvents
          : [],
    });
    await pool.query(
      `UPDATE command_results
          SET result = jsonb_set(
            jsonb_set(
              result,
              '{participantPrivateEvents}',
              (result->'participantPrivateEvents') - 1
            ),
            '{participantPrivateProgress,nearWinFeedbackEnabled}',
            'false'::jsonb
          )
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId],
    );
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: state.sessions[1]!.id,
        command,
      }),
    ).rejects.toThrow();
    await pool.query(
      `UPDATE command_results
          SET result = jsonb_set(
            jsonb_set(
              result,
              '{participantPrivateEvents}',
              $3::jsonb
            ),
            '{participantPrivateProgress,nearWinFeedbackEnabled}',
            'true'::jsonb
          )
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId, JSON.stringify(committed.participantPrivateEvents)],
    );
    const revisedCatalogConnection = await connectWithRoundCommands(() => now, {
      patterns: patternCatalog.filter(({ id }) => id !== state.round!.currentPatternId),
    });
    const replayedAfterCatalogRevision =
      await revisedCatalogConnection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: state.sessions[1]!.id,
        command,
      });
    expect(replayedAfterCatalogRevision).toMatchObject({
      ok: true,
      acknowledgement: { scope: "participant-private", idempotentReplay: true },
      participantPrivateEvents: committed.participantPrivateEvents,
    });
    await pool.query(
      `UPDATE command_results
          SET result = jsonb_set(
            result,
            '{participantPrivateEvents,0,mark,cardId}',
            to_jsonb($3::text)
          )
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId, state.round!.cards[0]!.id],
    );
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: state.sessions[1]!.id,
        command,
      }),
    ).rejects.toThrow();
    await pool.query(
      `UPDATE command_results
          SET result = jsonb_set(
            jsonb_set(
              result,
              '{participantPrivateEvents,0,mark,cardId}',
              to_jsonb($3::text)
            ),
            '{participantPrivateEvents,1,requiredBall}',
            to_jsonb($4::integer)
          )
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId, playerCard.id, command.ball],
    );
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: state.sessions[1]!.id,
        command,
      }),
    ).rejects.toThrow();
    await pool.query(
      `UPDATE command_results
          SET result = jsonb_set(
            result,
            '{participantPrivateEvents,1,requiredBall}',
            to_jsonb($3::integer)
          ) || jsonb_build_object(
            'participantPrivateEvent',
            result->'participantPrivateEvents'->0
          )
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, command.commandId, firstRow[4]],
    );
    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[1]!.id,
        participantSessionId: state.sessions[1]!.id,
        command,
      }),
    ).rejects.toThrow();
  });

  test("suppresses optional near-win feedback without changing authoritative progress", async () => {
    const occurredAt = new Date("2026-07-17T09:07:55.000Z");
    const connection = await connectWithRoundCommands(() => occurredAt, {
      nearWinFeedbackEnabled: false,
    });
    const base = createLobbyState();
    const playerCard = base.round!.cards[1]!;
    const firstRow = playerCard.cells.slice(0, 5);
    const calledBalls = firstRow.slice(0, 5);
    const persistedCalls = [1, ...calledBalls];
    const drawBalls = [
      ...persistedCalls,
      ...Array.from({ length: 75 }, (_, index) => index + 1),
    ].filter((ball, index, balls) => balls.indexOf(ball) === index);
    const state: DurableLobbyState = {
      ...base,
      lobby: { ...base.lobby, lastEventSequence: 0n },
      round: {
        ...base.round!,
        stage: "active",
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        coWinners: [],
        drawOrder: drawBalls.map((ball, index) => ({ position: index + 1, ball })),
        calls: persistedCalls.map((ball, index) => ({
          id: `call-muted-near-win-${index}-${randomUUID()}`,
          position: index + 1,
          ball,
          calledAt: new Date(occurredAt.getTime() - (calledBalls.length - index) * 1_000),
        })),
        cards: base.round!.cards.map((card) =>
          card.id === playerCard.id
            ? {
                ...card,
                marks: calledBalls.slice(0, 3).map((ball, index) => ({
                  id: `mark-muted-near-win-${index}-${randomUUID()}`,
                  ball,
                  markedAt: new Date(occurredAt.getTime() - (3 - index) * 1_000),
                })),
              }
            : card,
        ),
      },
      events: [],
      commandResults: [],
    };
    const command = MarkCardCommandSchema.parse({
      schemaVersion: 1,
      type: "mark-card",
      commandId: `mark-muted-near-win-${randomUUID()}`,
      ball: calledBalls[3],
    });
    await createPersistedLobby(connection, state);

    const committed = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    const enabledConnection = await connectWithRoundCommands(() => occurredAt);
    const replayedWithFeedbackEnabled = await enabledConnection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command,
    });
    const restored = await connection.lobbyStates.findById(state.lobby.id);
    const restoredCard = restored?.round?.cards.find(({ id }) => id === playerCard.id);
    const markedBalls = new Set(restoredCard?.marks.map(({ ball }) => ball));
    const authoritativeProgress = calculatePatternProgress(
      patternCatalog.find(({ id }) => id === state.round!.currentPatternId)!,
      {
        calledCells: playerCard.cells.map((ball) => ball === 0 || persistedCalls.includes(ball)),
        markedCells: playerCard.cells.map((ball) => ball === 0 || markedBalls.has(ball)),
      },
    );

    expect(committed).toMatchObject({
      ok: true,
      participantPrivateEvents: [
        { type: "mark-result", commandId: command.commandId, mark: { ball: calledBalls[3] } },
      ],
    });
    expect(restoredCard?.marks.map(({ ball }) => ball).sort((left, right) => left - right)).toEqual(
      calledBalls.slice(0, 4).sort((left, right) => left - right),
    );
    expect(authoritativeProgress).toMatchObject({
      complete: false,
      remainingRequiredCellCount: 1,
      nearWinCellIndex: 4,
    });
    expect(replayedWithFeedbackEnabled).toMatchObject({
      ok: true,
      acknowledgement: { scope: "participant-private", idempotentReplay: true },
      participantPrivateEvents:
        committed.ok && "participantPrivateEvents" in committed
          ? committed.participantPrivateEvents
          : [],
    });

    const completion = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command: MarkCardCommandSchema.parse({
        schemaVersion: 1,
        type: "mark-card",
        commandId: `complete-muted-near-win-${randomUUID()}`,
        ball: calledBalls[4],
      }),
    });
    const completedState = await connection.lobbyStates.findById(state.lobby.id);
    const completedCard = completedState?.round?.cards.find(({ id }) => id === playerCard.id);
    const completedMarkedBalls = new Set(completedCard?.marks.map(({ ball }) => ball));
    const completedProgress = calculatePatternProgress(
      patternCatalog.find(({ id }) => id === state.round!.currentPatternId)!,
      {
        calledCells: playerCard.cells.map((ball) => ball === 0 || persistedCalls.includes(ball)),
        markedCells: playerCard.cells.map((ball) => ball === 0 || completedMarkedBalls.has(ball)),
      },
    );
    expect(completion).toMatchObject({
      ok: true,
      participantPrivateEvents: [{ type: "mark-result", mark: { ball: calledBalls[4] } }],
    });
    expect(completedProgress).toMatchObject({
      complete: true,
      remainingRequiredCellCount: 0,
      nearWinCellIndex: null,
    });
  });

  test("persists and settles every completion from the latest call during the co-winner window", async () => {
    let now = new Date("2026-07-17T09:08:00.000Z");
    const connection = await connectWithRoundCommands(() => now, { coWinnerWindowMs: 2_000 });
    const base = createLobbyState();
    const hostCard = base.round!.cards[0]!;
    const playerCard = base.round!.cards[1]!;
    const thirdParticipantId = `participant-third-${randomUUID()}`;
    const thirdSessionId = `session-third-${randomUUID()}`;
    const thirdCardId = `card-third-${randomUUID()}`;
    const winningRow = playerCard.cells.slice(0, 5);
    const drawBalls = [
      ...winningRow,
      ...Array.from({ length: 75 }, (_, index) => index + 1),
    ].filter((ball, index, balls) => balls.indexOf(ball) === index);
    const calls = winningRow.map((ball, index) => ({
      id: `call-co-winner-${index}-${randomUUID()}`,
      position: index + 1,
      ball,
      calledAt: new Date(now.getTime() - (winningRow.length - index) * 1_000),
    }));
    const priorMarks = (prefix: string) =>
      winningRow.slice(0, 4).map((ball, index) => ({
        id: `${prefix}-${index}-${randomUUID()}`,
        ball,
        markedAt: new Date(now.getTime() - (4 - index) * 1_000),
      }));
    const state: DurableLobbyState = {
      ...base,
      lobby: { ...base.lobby, lastEventSequence: 0n },
      participants: [
        ...base.participants,
        {
          id: thirdParticipantId,
          username: "Third Player",
          normalizedUsername: "third player",
          role: "player",
          roundEligibility: "playing",
          joinedAt: base.lobby.createdAt,
          departedAt: null,
        },
      ],
      sessions: [
        ...base.sessions,
        {
          id: thirdSessionId,
          participantId: thirdParticipantId,
          tokenHash: new Uint8Array(randomBytes(32)),
          status: "active",
          issuedAt: base.lobby.createdAt,
          disconnectedAt: null,
          rejoinUntil: null,
          departedAt: null,
        },
      ],
      presenceGenerations: [
        ...base.presenceGenerations,
        {
          participantId: thirdParticipantId,
          generation: 1n,
          status: "connected",
          connectionCount: 1,
          changedAt: base.round!.startedAt!,
          graceEndsAt: null,
          absentSince: null,
          departedAt: null,
          overridden: false,
          endedAt: null,
        },
      ],
      round: {
        ...base.round!,
        stage: "active",
        nextCallAt: new Date(now.getTime() + 30_000),
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        coWinners: [],
        drawOrder: drawBalls.map((ball, index) => ({ position: index + 1, ball })),
        calls,
        cards: [
          {
            ...hostCard,
            cells: [...winningRow, ...hostCard.cells.slice(5)],
            marks: priorMarks("mark-host-co-winner"),
          },
          { ...playerCard, marks: priorMarks("mark-player-co-winner") },
          {
            ...playerCard,
            id: thirdCardId,
            participantId: thirdParticipantId,
            cells: [...winningRow, ...playerCard.cells.slice(5, 24), 75],
            marks: priorMarks("mark-third-co-winner"),
          },
        ],
      },
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);
    const complete = (participantIndex: 0 | 1 | 2, commandId: string) =>
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[participantIndex]!.id,
        participantSessionId: state.sessions[participantIndex]!.id,
        command: MarkCardCommandSchema.parse({
          schemaVersion: 1,
          type: "mark-card",
          commandId,
          ball: winningRow[4],
        }),
      });

    const completionCommands = [
      { participantIndex: 1 as const, commandId: `complete-player-${randomUUID()}` },
      { participantIndex: 0 as const, commandId: `complete-host-${randomUUID()}` },
    ];
    const completions = await Promise.all(
      completionCommands.map(({ participantIndex, commandId }) =>
        complete(participantIndex, commandId),
      ),
    );
    const openingIndex = completions.findIndex(
      (result) => result.ok && result.acknowledgement.scope === "active-lobby",
    );
    if (openingIndex < 0) throw new Error("Expected one completion to open the window.");
    const first = completions[openingIndex]!;
    const firstCommand = completionCommands[openingIndex]!;
    const second = completions[openingIndex === 0 ? 1 : 0]!;
    const lease = await connection.roundCommands.findCoWinnerSettlementLease(state.lobby.id);
    expect(first).toMatchObject({
      ok: true,
      acknowledgement: { scope: "active-lobby", eventSequence: 1, idempotentReplay: false },
      activeLobbyEvent: {
        type: "co-winner-window",
        eventSequence: 1,
        window: {
          triggeringCallId: calls[4]!.id,
          openedAt: now.toISOString(),
          closesAt: new Date(now.getTime() + 2_000).toISOString(),
        },
      },
      participantPrivateEvents: [
        {
          type: "mark-result",
          commandId: firstCommand.commandId,
          mark: { ball: winningRow[4] },
        },
      ],
    });
    expect(second).toMatchObject({
      ok: true,
      acknowledgement: { scope: "participant-private", eventSequence: null },
      activeLobbyEvent: null,
      participantPrivateEvents: [{ type: "mark-result", mark: { ball: winningRow[4] } }],
    });
    expect(lease).toEqual({
      lobbyId: state.lobby.id,
      roundId: state.round!.id,
      triggeringCallId: calls[4]!.id,
      deadline: new Date(now.getTime() + 2_000),
    });

    const persistedMixedResult = await pool.query<{
      result_format: number;
      integrity_length: number;
      delivery_scope: string;
      event_sequence: string;
    }>(
      `SELECT result_format,
              octet_length(result_integrity)::int AS integrity_length,
              delivery_scope::text,
              event_sequence::text
         FROM command_results
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, firstCommand.commandId],
    );
    expect(persistedMixedResult.rows).toEqual([
      {
        result_format: 4,
        integrity_length: 32,
        delivery_scope: "ACTIVE_LOBBY",
        event_sequence: "1",
      },
    ]);
    await expect(
      pool.query(
        `UPDATE command_results SET result_integrity = NULL
          WHERE lobby_id = $1 AND command_id = $2`,
        [state.lobby.id, firstCommand.commandId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `UPDATE command_results
            SET delivery_scope = 'PARTICIPANT_PRIVATE', event_sequence = NULL
          WHERE lobby_id = $1 AND command_id = $2`,
        [state.lobby.id, firstCommand.commandId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    now = new Date(now.getTime() + 1_999);
    expect(await connection.roundCommands.executeCoWinnerSettlement(lease!)).toBe("too-early");
    await expect(
      connection.roundCommands.executeCoWinnerSettlement({
        ...lease!,
        triggeringCallId: `stale-${lease!.triggeringCallId}`,
      }),
    ).resolves.toBe("stale");
    await expect(
      connection.roundCommands.executeCoWinnerSettlement({
        ...lease!,
        deadline: new Date(lease!.deadline.getTime() + 1),
      }),
    ).resolves.toBe("stale");
    await expect(
      connection.roundCommands.executeCoWinnerSettlement({
        ...lease!,
        roundId: `stale-${lease!.roundId}`,
      }),
    ).resolves.toBe("stale");

    await expect(
      connection.roundCommands.executeAuthenticated({
        lobbyId: state.lobby.id,
        participantId: state.participants[0]!.id,
        participantSessionId: state.sessions[0]!.id,
        command: CallNextCommandSchema.parse({
          schemaVersion: 1,
          type: "call-next",
          commandId: `blocked-call-${randomUUID()}`,
        }),
      }),
    ).resolves.toEqual({ ok: false, error: { code: "INVALID_COMMAND" } });

    now = new Date(now.getTime() + 1);
    const [lateCompletion, settlement] = await Promise.all([
      complete(2, `complete-at-deadline-${randomUUID()}`),
      connection.roundCommands.executeCoWinnerSettlement(lease!),
    ]);
    expect(lateCompletion).toEqual({ ok: false, error: { code: "INVALID_COMMAND" } });
    expect(settlement).toBe("settled");
    const restored = await connection.lobbyStates.findById(state.lobby.id);
    const winnerParticipantIds = state.participants
      .slice(0, 2)
      .map(({ id }) => id)
      .sort((left, right) => left.localeCompare(right));
    expect(restored?.round).toMatchObject({
      stage: "result",
      nextCallAt: null,
      coWinnerTriggeringCallId: calls[4]!.id,
      resultSettledAt: now,
      coWinners: winnerParticipantIds.map((participantId) => ({ participantId })),
    });
    expect(restored?.events).toMatchObject([
      { sequence: 1n, eventType: "co-winner-window" },
      {
        sequence: 2n,
        eventType: "co-winner-result",
        payload: {
          result: {
            triggeringCallId: calls[4]!.id,
            settledAt: now.toISOString(),
            winnerParticipantIds,
          },
        },
      },
    ]);
    expect(restored?.round?.calls).toHaveLength(winningRow.length);

    const replayed = await complete(firstCommand.participantIndex, firstCommand.commandId);
    expect(replayed).toMatchObject({
      ok: true,
      acknowledgement: { scope: "active-lobby", eventSequence: 1, idempotentReplay: true },
      activeLobbyEvent: null,
      participantPrivateEvents: first.ok ? first.participantPrivateEvents : [],
    });
    await pool.query(
      `UPDATE command_results
          SET result = result - 'participantPrivateEvents'
        WHERE lobby_id = $1 AND command_id = $2`,
      [state.lobby.id, firstCommand.commandId],
    );
    await expect(complete(firstCommand.participantIndex, firstCommand.commandId)).rejects.toThrow();
  });

  test("does not attribute an already-complete card to an unrelated latest-ball mark", async () => {
    const now = new Date("2026-07-17T09:08:10.000Z");
    const connection = await connectWithRoundCommands(() => now, { coWinnerWindowMs: 2_000 });
    const base = createLobbyState();
    const playerCard = base.round!.cards[1]!;
    const completedRow = playerCard.cells.slice(0, 5);
    const latestBall = playerCard.cells[5]!;
    const calledBalls = [1, ...completedRow, latestBall].filter(
      (ball, index, balls) => balls.indexOf(ball) === index,
    );
    const drawBalls = [
      ...calledBalls,
      ...Array.from({ length: 75 }, (_, index) => index + 1),
    ].filter((ball, index, balls) => balls.indexOf(ball) === index);
    const state: DurableLobbyState = {
      ...base,
      lobby: { ...base.lobby, lastEventSequence: 0n },
      round: {
        ...base.round!,
        stage: "active",
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
        coWinners: [],
        drawOrder: drawBalls.map((ball, index) => ({ position: index + 1, ball })),
        calls: calledBalls.map((ball, index) => ({
          id: `call-already-complete-${index}-${randomUUID()}`,
          position: index + 1,
          ball,
          calledAt: new Date(now.getTime() - (calledBalls.length - index) * 1_000),
        })),
        cards: base.round!.cards.map((card) =>
          card.id === playerCard.id
            ? {
                ...card,
                marks: completedRow.map((ball, index) => ({
                  id: `mark-already-complete-${index}-${randomUUID()}`,
                  ball,
                  markedAt: new Date(now.getTime() - (completedRow.length - index) * 1_000),
                })),
              }
            : card,
        ),
      },
      events: [],
      commandResults: [],
    };
    await createPersistedLobby(connection, state);

    const committed = await connection.roundCommands.executeAuthenticated({
      lobbyId: state.lobby.id,
      participantId: state.participants[1]!.id,
      participantSessionId: state.sessions[1]!.id,
      command: MarkCardCommandSchema.parse({
        schemaVersion: 1,
        type: "mark-card",
        commandId: `mark-after-complete-${randomUUID()}`,
        ball: latestBall,
      }),
    });
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(committed).toMatchObject({
      ok: true,
      acknowledgement: { scope: "participant-private", eventSequence: null },
      activeLobbyEvent: null,
    });
    expect(restored?.round).toMatchObject({ stage: "active", coWinners: [] });
    expect(restored?.events).toEqual([]);
  });

  test("rejects a player host-control command before any mutation is persisted", async () => {
    const connection = await connectWithRoundCommands(() => new Date("2026-07-17T09:08:00.000Z"));
    const state = createLobbyState();
    const command = EndRoundCommandSchema.parse({
      schemaVersion: 1,
      type: "end-round",
      commandId: `forbidden-${randomUUID()}`,
    });
    await createPersistedLobby(connection, state);

    await expect(
      connection.roundCommands.execute({
        lobbyId: state.lobby.id,
        sessionTokenHash: state.sessions[1]!.tokenHash,
        command,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    const restored = await connection.lobbyStates.findById(state.lobby.id);

    expect(restored?.round?.stage).toBe("result");
    expect(restored?.events).toHaveLength(1);
    expect(restored?.commandResults).toHaveLength(1);
  });
});
