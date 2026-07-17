import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  CommandReplayMismatchError,
  connectDatabase,
  type CommandTransactionRepositories,
  type CommandTransactionRequest,
  type DurableLobbyState,
  type JsonObject,
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

describeDatabase("PostgreSQL durable game state", () => {
  const connections: Awaited<ReturnType<typeof connectDatabase>>[] = [];
  let pool: Pool;

  beforeAll(() => {
    if (testDatabaseUrl === undefined) {
      return;
    }
    pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  });

  afterAll(async () => {
    await Promise.all(connections.map(async (connection) => connection.disconnect()));
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

  test("restores the complete authoritative state after reconnecting the client", async () => {
    const expected = createLobbyState();
    const firstConnection = await connect();

    await firstConnection.lobbyStates.create(expected);
    await firstConnection.disconnect();
    connections.splice(connections.indexOf(firstConnection), 1);

    const restartedConnection = await connect();
    const restored = await restartedConnection.lobbyStates.findById(expected.lobby.id);

    expect(restored).toEqual(expected);
  });

  test("enforces active-code and aggregate scoped uniqueness", async () => {
    const connection = await connect();
    const activeCode = randomLobbyCode();
    await connection.lobbyStates.create(createLobbyState({ code: activeCode }));

    await expect(
      connection.lobbyStates.create(createLobbyState({ code: activeCode })),
    ).rejects.toBeDefined();

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
      await expect(connection.lobbyStates.create(invalidState)).rejects.toBeDefined();
    }

    await expect(connection.lobbyStates.create(createLobbyState())).resolves.toBeUndefined();
  });

  test("rejects cards owned by a participant from another lobby", async () => {
    const connection = await connect();
    const firstLobby = createLobbyState();
    const secondLobby = createLobbyState();
    await connection.lobbyStates.create(firstLobby);
    await connection.lobbyStates.create(secondLobby);

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
    await connection.lobbyStates.create(state);
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
    await connection.lobbyStates.create(state);

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
    await connection.lobbyStates.create(state);

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
    await connection.lobbyStates.create(state);

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
    await setupConnection.lobbyStates.create(state);

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
    await setupConnection.lobbyStates.create(state);

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
    await connection.lobbyStates.create(state);
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
    await setupConnection.lobbyStates.create(state);

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
    await connection.lobbyStates.create(state);

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
    await connection.lobbyStates.create(state);

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
