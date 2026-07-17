import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { SnapshotSchema } from "@gamenight-bingo/contracts";

import {
  CommandReplayMismatchError,
  connectDatabase,
  type CommandTransactionRepositories,
  type CommandTransactionRequest,
  type CreateActiveLobbyResult,
  type DurableLobbyState,
  type JsonObject,
  type NewActiveLobbyState,
  type NewLobbyParticipant,
  type NewParticipantSession,
  type ReserveParticipantResult,
  type TransactionRetryEvent,
} from "./index.js";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const describeDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomLobbyCode(): string {
  return Array.from(randomBytes(6), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
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

  async function waitForBlockedCommandFence(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query LIKE '%UPDATE "lobbies"%'
              AND query LIKE '%last_event_sequence%'
         ) AS blocked`,
      );
      if (result.rows[0]?.blocked === true) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("Timed out waiting for a concurrent command to block on the lobby fence.");
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
    const activeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM lobbies WHERE status IN ('WAITING', 'ACTIVE')`,
    );

    await expect(
      connection.lobbyStates.createActive(omitLobbyCode(created), {
        maxActiveLobbies: Number(activeCount.rows[0]!.count) + 1,
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
    const activeCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM lobbies WHERE status IN ('WAITING', 'ACTIVE')`,
    );

    const result = await connection.lobbyStates.createLobbyWithHost({
      lobbyId: `lobby-${suffix}`,
      participantId: `participant-${suffix}`,
      sessionId: `session-${suffix}`,
      commandId: `command-${suffix}`,
      username: "  Host   Player  ",
      themeId: "classic",
      tokenHash,
      issuedAt,
      maxActiveLobbies: activeCount.rows[0]!.count + 1,
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

  test("replays lobby creation without creating another lobby or participant", async () => {
    const connection = await connect();
    const suffix = randomUUID();
    const activeCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM lobbies WHERE status IN ('WAITING', 'ACTIVE')`,
    );
    const base = {
      lobbyId: `lobby-${suffix}`,
      participantId: `participant-${suffix}`,
      sessionId: `session-${suffix}`,
      commandId: `command-${suffix}`,
      username: "Replay Host",
      themeId: "classic",
      tokenHash: new Uint8Array(randomBytes(32)),
      issuedAt: new Date("2026-07-17T12:00:00.000Z"),
      maxActiveLobbies: activeCount.rows[0]!.count + 1,
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

    await expect(
      connection.lobbyStates.findAuthorizedSnapshot({
        lobbyId: state.lobby.id,
        tokenHash: new Uint8Array(randomBytes(32)),
      }),
    ).resolves.toBeNull();
  });

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
    const activeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM lobbies WHERE status IN ('WAITING', 'ACTIVE')`,
    );
    const blocker = await pool.connect();
    let firstCreation: Promise<CreateActiveLobbyResult> | undefined;
    let secondCreation: Promise<CreateActiveLobbyResult> | undefined;

    try {
      await blocker.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await blocker.query("SELECT pg_advisory_xact_lock(17742, 23001)");
      firstCreation = firstConnection.lobbyStates.createActive(omitLobbyCode(first), {
        maxActiveLobbies: Number(activeCount.rows[0]!.count) + 2,
        nextCode: scriptedCodes([sharedCode, firstFallback]),
      });
      secondCreation = secondConnection.lobbyStates.createActive(omitLobbyCode(second), {
        maxActiveLobbies: Number(activeCount.rows[0]!.count) + 2,
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
    const activeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM lobbies WHERE status IN ('WAITING', 'ACTIVE')`,
    );
    const blocker = await pool.connect();
    let creation: Promise<CreateActiveLobbyResult> | undefined;

    try {
      await blocker.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await blocker.query("SELECT pg_advisory_xact_lock(17742, 23001)");
      creation = connection.lobbyStates.createActive(omitLobbyCode(state), {
        maxActiveLobbies: Number(activeCount.rows[0]!.count) + 2,
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
    const activeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM lobbies WHERE status IN ('WAITING', 'ACTIVE')`,
    );
    const replacement = createLobbyState();

    await expect(
      connection.lobbyStates.createActive(omitLobbyCode(replacement), {
        maxActiveLobbies: Number(activeCount.rows[0]!.count) + 1,
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
});
