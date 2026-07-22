import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  ActiveLobbyEventNotification,
  ActiveLobbyEventSubscriber,
  OperationalLogger,
} from "@gamenight-bingo/database";

import {
  GameServerConfigurationError,
  parseGameServerConfiguration,
  startInactiveLobbyCleanupWorker,
  startGameServerRuntime,
  subscribeGameServerToActiveLobbyEvents,
  superviseGameServerResources,
} from "./runtime.js";
import type { GameServer, GameServerOptions } from "./socket-server.js";

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

describe("game-server runtime configuration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("loads grace leases and preserves the disconnect persistence promise", async () => {
    const grace = {
      lobbyId: "lobby_alpha",
      participantId: "participant_player",
      presenceGeneration: 3,
      graceEndsAt: new Date("2026-07-17T20:00:10.000Z"),
    };
    let serverOptions: GameServerOptions | undefined;
    let databaseDisconnected = false;
    const disconnectPersistence = Promise.resolve(null);
    const startupOrder: string[] = [];
    const eventSubscription = {
      completion: new Promise<void>(() => {}),
      close: async () => {},
    };
    let cleanupCalls = 0;
    const database = {
      lobbyStates: {
        expireInactiveLobbies: async (input: unknown) => {
          cleanupCalls += 1;
          startupOrder.push("cleanup");
          expect(input).toEqual({ inactivityTtlSeconds: 1_800, maximum: 100 });
          return {
            examinedCount: 0,
            deletedCount: 0,
            skippedCount: 0,
            deletedByStatus: { waiting: 0, active: 0, completed: 0, abandoned: 0 },
            limitReached: cleanupCalls === 1,
          };
        },
        findRealtimePresenceGracePeriods: async () => {
          startupOrder.push("grace");
          return [grace];
        },
        unregisterRealtimeConnection: () => disconnectPersistence,
      },
      roundCommands: {
        executeAuthenticated: async () => ({
          ok: true as const,
          acknowledgement: {
            commandId: "command_committed",
            scope: "active-lobby" as const,
            eventSequence: 1,
            occurredAt: new Date(Number.NaN),
            idempotentReplay: false,
          },
          activeLobbyEvent: null,
          participantPrivateEvents: [],
        }),
      },
      activeLobbyEvents: {
        subscribe: async () => {
          startupOrder.push("subscribe");
          return eventSubscription;
        },
      },
      disconnect: async () => {
        databaseDisconnected = true;
      },
    };
    const server: GameServer = {
      failure: new Promise<never>(() => {}),
      listen: async ({ host, port }) => {
        startupOrder.push("listen");
        return { host, port };
      },
      close: async () => {},
      publishLobbyEvent: async () => {},
      publishLobbyEventFromSource: async () => {},
      publishParticipantEvent: async () => {},
    };
    const startWithDependencies = startGameServerRuntime as unknown as (
      environment: Readonly<Record<string, string | undefined>>,
      dependencies: {
        connectDatabase: () => Promise<typeof database>;
        createGameServer: (options: GameServerOptions) => GameServer;
      },
    ) => ReturnType<typeof startGameServerRuntime>;

    const running = await startWithDependencies(
      {
        DATABASE_URL: "postgresql://127.0.0.1:1/bingo",
        GAME_SERVER_PORT: "4101",
      },
      {
        connectDatabase: async () => database,
        createGameServer: (options) => {
          serverOptions = options;
          return server;
        },
      },
    );

    expect(serverOptions?.initialPresenceGracePeriods).toEqual([grace]);
    expect(
      serverOptions?.presenceLifecycle.unregisterConnection(
        {
          lobbyId: "lobby_alpha",
          participantId: "participant_alpha",
          participantSessionId: "session_alpha",
        },
        3,
      ),
    ).toBe(disconnectPersistence);
    expect(startupOrder).toEqual(["cleanup", "cleanup", "grace", "subscribe", "listen"]);
    await expect(
      serverOptions?.commandExecutor.execute({
        identity: {
          lobbyId: "lobby_alpha",
          participantId: "participant_alpha",
          participantSessionId: "session_alpha",
        },
        command: {} as never,
      }),
    ).resolves.toMatchObject({
      ok: true,
      acknowledgement: { occurredAt: expect.any(Date) },
    });
    await running.close();
    expect(databaseDisconnected).toBe(true);
  });

  test("disconnects the database when persisted grace recovery fails during startup", async () => {
    let databaseDisconnected = false;
    const database = {
      lobbyStates: {
        expireInactiveLobbies: async () => ({
          examinedCount: 0,
          deletedCount: 0,
          skippedCount: 0,
          deletedByStatus: { waiting: 0, active: 0, completed: 0, abandoned: 0 },
          limitReached: false,
        }),
        findRealtimePresenceGracePeriods: async () => {
          throw new Error("private recovery detail");
        },
      },
      disconnect: async () => {
        databaseDisconnected = true;
      },
    };
    const startWithDependencies = startGameServerRuntime as unknown as (
      environment: Readonly<Record<string, string | undefined>>,
      dependencies: {
        connectDatabase: () => Promise<typeof database>;
        createGameServer: (options: GameServerOptions) => GameServer;
      },
      operationalLogger: OperationalLogger,
    ) => ReturnType<typeof startGameServerRuntime>;
    const restorationRecords: Parameters<OperationalLogger["restartRestoration"]>[0][] = [];
    const operationalLogger: OperationalLogger = {
      withCommandCorrelation: (_commandId, operation) => operation(),
      command: () => {},
      lobbyEvent: () => {},
      transactionRetry: () => {},
      disconnectPause: () => {},
      restartRestoration: (record) => restorationRecords.push(record),
    };

    await expect(
      startWithDependencies(
        {
          DATABASE_URL: "postgresql://127.0.0.1:1/bingo",
          GAME_SERVER_PORT: "4102",
        },
        {
          connectDatabase: async () => database,
          createGameServer: () => {
            throw new Error("authority must not be created");
          },
        },
        operationalLogger,
      ),
    ).rejects.toThrow();
    expect(databaseDisconnected).toBe(true);
    expect(restorationRecords).toEqual([{ kind: "presence-grace", count: 0, outcome: "failed" }]);
  });

  test("drains cleanup and database resources when authority construction fails", async () => {
    vi.useFakeTimers();
    let cleanupCalls = 0;
    let databaseDisconnected = false;
    const database = {
      lobbyStates: {
        expireInactiveLobbies: async () => {
          cleanupCalls += 1;
          return {
            examinedCount: 0,
            deletedCount: 0,
            skippedCount: 0,
            deletedByStatus: { waiting: 0, active: 0, completed: 0, abandoned: 0 },
            limitReached: false,
          };
        },
        findRealtimePresenceGracePeriods: async () => [],
      },
      disconnect: async () => {
        databaseDisconnected = true;
      },
    };
    const startWithDependencies = startGameServerRuntime as unknown as (
      environment: Readonly<Record<string, string | undefined>>,
      dependencies: {
        connectDatabase: () => Promise<typeof database>;
        createGameServer: () => never;
      },
    ) => ReturnType<typeof startGameServerRuntime>;

    await expect(
      startWithDependencies(
        {
          DATABASE_URL: "postgresql://127.0.0.1:1/bingo",
          GAME_SERVER_PORT: "4103",
        },
        {
          connectDatabase: async () => database,
          createGameServer: () => {
            throw new Error("authority construction failed");
          },
        },
      ),
    ).rejects.toThrow("authority construction failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cleanupCalls).toBe(1);
    expect(databaseDisconnected).toBe(true);
  });

  test("starts periodic cleanup only after listener startup can supervise failures", async () => {
    vi.useFakeTimers();
    const listenStarted = deferred();
    const releaseListen = deferred<{ host: string; port: number }>();
    const listeningAddress = { host: "127.0.0.1", port: 4104 };
    let cleanupCalls = 0;
    const eventSubscription = {
      completion: new Promise<void>(() => {}),
      close: async () => {},
    };
    const database = {
      lobbyStates: {
        expireInactiveLobbies: async () => {
          cleanupCalls += 1;
          return {
            examinedCount: 0,
            deletedCount: 0,
            skippedCount: 0,
            deletedByStatus: { waiting: 0, active: 0, completed: 0, abandoned: 0 },
            limitReached: false,
          };
        },
        findRealtimePresenceGracePeriods: async () => [],
      },
      roundCommands: {},
      activeLobbyEvents: { subscribe: async () => eventSubscription },
      disconnect: async () => {},
    };
    const server: GameServer = {
      failure: new Promise<never>(() => {}),
      listen: async () => {
        listenStarted.resolve();
        return releaseListen.promise;
      },
      close: async () => {},
      publishLobbyEvent: async () => {},
      publishLobbyEventFromSource: async () => {},
      publishParticipantEvent: async () => {},
    };
    const startWithDependencies = startGameServerRuntime as unknown as (
      environment: Readonly<Record<string, string | undefined>>,
      dependencies: {
        connectDatabase: () => Promise<typeof database>;
        createGameServer: () => GameServer;
      },
    ) => ReturnType<typeof startGameServerRuntime>;
    const starting = startWithDependencies(
      {
        DATABASE_URL: "postgresql://127.0.0.1:1/bingo",
        GAME_SERVER_PORT: "4104",
      },
      {
        connectDatabase: async () => database,
        createGameServer: () => server,
      },
    );
    let running: Awaited<ReturnType<typeof startGameServerRuntime>> | undefined;

    try {
      await waitForSignal(listenStarted.promise, "game-server listener startup");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cleanupCalls).toBe(1);

      releaseListen.resolve(listeningAddress);
      running = await waitForSignal(starting, "game-server startup");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cleanupCalls).toBe(2);
    } finally {
      releaseListen.resolve(listeningAddress);
      running ??= await waitForSignal(starting, "game-server startup cleanup");
      await running.close();
    }
  });

  test("runs periodic cleanup without overlap and drains in-flight work on close", async () => {
    vi.useFakeTimers();
    const firstCleanup = deferred();
    let cleanupCalls = 0;
    const worker = startInactiveLobbyCleanupWorker({
      intervalMs: 1_000,
      cleanup: async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) await firstCleanup.promise;
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cleanupCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cleanupCalls).toBe(1);
      firstCleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cleanupCalls).toBe(2);
    } finally {
      firstCleanup.resolve();
      await waitForSignal(worker.close(), "inactive lobby cleanup worker close");
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanupCalls).toBe(2);
  });

  test("reports periodic cleanup failure without exposing persistence details", async () => {
    vi.useFakeTimers();
    const worker = startInactiveLobbyCleanupWorker({
      intervalMs: 1_000,
      cleanup: async () => {
        throw new Error("private database detail");
      },
    });
    const failure = worker.failure.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(failure).resolves.toMatchObject({ message: "Inactive lobby cleanup failed." });
    expect(String(await failure)).not.toContain("private database detail");
    await worker.close();
  });

  test("fails and drains the runtime when periodic lobby cleanup cannot continue", async () => {
    vi.useFakeTimers();
    let cleanupCalls = 0;
    const closed: string[] = [];
    const eventSubscription = {
      completion: new Promise<void>(() => {}),
      close: async () => {
        closed.push("subscription");
      },
    };
    const database = {
      lobbyStates: {
        expireInactiveLobbies: async () => {
          cleanupCalls += 1;
          if (cleanupCalls > 1) throw new Error("private cleanup detail");
          return {
            examinedCount: 0,
            deletedCount: 0,
            skippedCount: 0,
            deletedByStatus: { waiting: 0, active: 0, completed: 0, abandoned: 0 },
            limitReached: false,
          };
        },
        findRealtimePresenceGracePeriods: async () => [],
      },
      roundCommands: {},
      activeLobbyEvents: { subscribe: async () => eventSubscription },
      disconnect: async () => {
        closed.push("database");
      },
    };
    const server: GameServer = {
      failure: new Promise<never>(() => {}),
      listen: async ({ host, port }) => ({ host, port }),
      close: async () => {
        closed.push("server");
      },
      publishLobbyEvent: async () => {},
      publishLobbyEventFromSource: async () => {},
      publishParticipantEvent: async () => {},
    };
    const startWithDependencies = startGameServerRuntime as unknown as (
      environment: Readonly<Record<string, string | undefined>>,
      dependencies: {
        connectDatabase: () => Promise<typeof database>;
        createGameServer: () => GameServer;
      },
    ) => ReturnType<typeof startGameServerRuntime>;
    const running = await startWithDependencies(
      {
        DATABASE_URL: "postgresql://127.0.0.1:1/bingo",
        GAME_SERVER_PORT: "4105",
      },
      {
        connectDatabase: async () => database,
        createGameServer: () => server,
      },
    );
    const completion = running.completion.then(
      () => null,
      (error: unknown) => error,
    );

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(
        waitForSignal(completion, "cleanup-failed runtime completion"),
      ).resolves.toMatchObject({ message: "Game server authority failed." });
      expect(cleanupCalls).toBe(2);
      expect(closed).toEqual(["server", "subscription", "database"]);
      expect(String(await completion)).not.toContain("private cleanup detail");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cleanupCalls).toBe(2);
    } finally {
      await running.close();
    }
  });

  test("fails the runtime and closes every resource when event continuity is lost", async () => {
    let rejectSubscription!: (reason?: unknown) => void;
    const subscriptionCompletion = new Promise<void>((_resolve, reject) => {
      rejectSubscription = reject;
    });
    const closed: string[] = [];
    const running = superviseGameServerResources({
      address: { host: "127.0.0.1", port: 3001 },
      eventSubscription: {
        completion: subscriptionCompletion,
        close: async () => {
          closed.push("subscription");
        },
      },
      server: {
        failure: new Promise<never>(() => {}),
        close: async () => {
          closed.push("server");
        },
      },
      disconnectDatabase: async () => {
        closed.push("database");
      },
    });

    rejectSubscription(new Error("private listener detail"));

    await expect(running.completion).rejects.toThrow("Active-lobby event subscription failed.");
    expect(closed).toEqual(["server", "subscription", "database"]);
    await running.close();
    expect(closed).toEqual(["server", "subscription", "database"]);
  });

  test("stops accepting Socket.IO work before waiting for a stalled subscription drain", async () => {
    let rejectSubscription!: (reason?: unknown) => void;
    const subscriptionCompletion = new Promise<void>((_resolve, reject) => {
      rejectSubscription = reject;
    });
    const releaseSubscriptionClose = deferred();
    const serverClosed = deferred();
    const running = superviseGameServerResources({
      address: { host: "127.0.0.1", port: 3001 },
      eventSubscription: {
        completion: subscriptionCompletion,
        close: async () => releaseSubscriptionClose.promise,
      },
      server: {
        failure: new Promise<never>(() => {}),
        close: async () => {
          serverClosed.resolve();
        },
      },
      disconnectDatabase: async () => {},
    });
    const completion = running.completion.then(
      () => null,
      (error: unknown) => error,
    );

    rejectSubscription(new Error("private listener detail"));

    try {
      await expect(
        Promise.race([
          serverClosed.promise.then(() => "server-closed" as const),
          new Promise<"tick">((resolve) => setImmediate(() => resolve("tick"))),
        ]),
      ).resolves.toBe("server-closed");
    } finally {
      releaseSubscriptionClose.resolve();
    }
    await expect(completion).resolves.toMatchObject({
      message: "Active-lobby event subscription failed.",
    });
  });

  test("settles completion safely when graceful resource shutdown fails", async () => {
    const closed: string[] = [];
    const running = superviseGameServerResources({
      address: { host: "127.0.0.1", port: 3001 },
      eventSubscription: {
        completion: new Promise<void>(() => {}),
        close: async () => {
          closed.push("subscription");
        },
      },
      server: {
        failure: new Promise<never>(() => {}),
        close: async () => {
          closed.push("server");
          throw new Error("private server close detail");
        },
      },
      disconnectDatabase: async () => {
        closed.push("database");
      },
    });
    const completion = running.completion.then(
      () => null,
      (error: unknown) => error,
    );
    const closeFailure = running.close().then(
      () => null,
      (error: unknown) => error,
    );

    await expect(closeFailure).resolves.toMatchObject({
      message: "The game server failed to shut down safely.",
    });
    await expect(completion).resolves.toMatchObject({
      message: "The game server failed to shut down safely.",
    });
    expect(closed).toEqual(["server", "subscription", "database"]);
  });

  test("drains every resource and rejects completion when the Socket.IO authority fails", async () => {
    let rejectAuthority!: (reason?: unknown) => void;
    const authorityFailure = new Promise<never>((_resolve, reject) => {
      rejectAuthority = reject;
    });
    const closed: string[] = [];
    const running = superviseGameServerResources({
      address: { host: "127.0.0.1", port: 3001 },
      eventSubscription: {
        completion: new Promise<void>(() => {}),
        close: async () => {
          closed.push("subscription");
        },
      },
      server: {
        failure: authorityFailure,
        close: async () => {
          closed.push("server");
        },
      },
      disconnectDatabase: async () => {
        closed.push("database");
      },
    });
    const completion = running.completion.then(
      () => null,
      (error: unknown) => error,
    );

    rejectAuthority(new Error("private presence cleanup detail"));

    await expect(
      Promise.race([
        completion,
        new Promise<"not-settled">((resolve) => setImmediate(() => resolve("not-settled"))),
      ]),
    ).resolves.toMatchObject({ message: "Game server authority failed." });
    expect(closed).toEqual(["server", "subscription", "database"]);
    await running.close();
    expect(closed).toEqual(["server", "subscription", "database"]);
  });

  test("relays externally committed active-lobby events to the Socket.IO authority", async () => {
    let listener:
      ((notification: ActiveLobbyEventNotification) => void | Promise<void>) | undefined;
    const subscriber: ActiveLobbyEventSubscriber = {
      subscribe: async (nextListener) => {
        listener = nextListener;
        return { completion: new Promise<void>(() => {}), close: async () => {} };
      },
    };
    const published: unknown[] = [];
    await subscribeGameServerToActiveLobbyEvents(subscriber, {
      publishLobbyEventFromSource: async (lobbyId, sequence, loadEvent) => {
        published.push({ lobbyId, sequence, event: await loadEvent() });
      },
    });

    await listener?.({
      lobbyId: "lobby_alpha",
      sequence: 7n,
      loadEvent: async () => ({
        sequence: 7n,
        roundId: "round_alpha",
        eventType: "round-end",
        schemaVersion: 1,
        payload: {
          round: {
            id: "round_alpha",
            lobbyId: "lobby_alpha",
            patternId: "standard-one-line",
            callConfiguration: { mode: "manual" },
            stage: "ended",
            startedAt: "2026-07-17T19:59:00.000Z",
            endedAt: "2026-07-17T20:00:00.000Z",
            result: null,
          },
        },
        createdAt: new Date("2026-07-17T20:00:00.000Z"),
      }),
    });

    expect(published).toEqual([
      {
        lobbyId: "lobby_alpha",
        sequence: 7,
        event: {
          schemaVersion: 1,
          type: "round-end",
          eventSequence: 7,
          occurredAt: "2026-07-17T20:00:00.000Z",
          round: {
            id: "round_alpha",
            lobbyId: "lobby_alpha",
            patternId: "standard-one-line",
            callConfiguration: { mode: "manual" },
            stage: "ended",
            startedAt: "2026-07-17T19:59:00.000Z",
            endedAt: "2026-07-17T20:00:00.000Z",
            result: null,
          },
        },
      },
    ]);
  });

  test("uses local listener and exact web-origin defaults", () => {
    expect(
      parseGameServerConfiguration({ DATABASE_URL: "postgresql://local.example/bingo" }),
    ).toEqual({
      databaseUrl: "postgresql://local.example/bingo",
      host: "127.0.0.1",
      port: 3001,
      allowedOrigin: "http://localhost:3000",
    });
  });

  test("accepts explicit host, port, and HTTPS origin overrides", () => {
    expect(
      parseGameServerConfiguration({
        DATABASE_URL: "postgresql://local.example/bingo",
        GAME_SERVER_HOST: "0.0.0.0",
        GAME_SERVER_PORT: "4100",
        WEB_ORIGIN: "https://bingo.example.com",
      }),
    ).toEqual({
      databaseUrl: "postgresql://local.example/bingo",
      host: "0.0.0.0",
      port: 4100,
      allowedOrigin: "https://bingo.example.com",
    });
  });

  test.each([
    [{}, "DATABASE_URL is required."],
    [{ DATABASE_URL: " " }, "DATABASE_URL is required."],
    [
      { DATABASE_URL: "private-database-value", GAME_SERVER_PORT: "0" },
      "GAME_SERVER_PORT must be a decimal integer between 1 and 65535.",
    ],
    [
      { DATABASE_URL: "private-database-value", GAME_SERVER_PORT: "1.5" },
      "GAME_SERVER_PORT must be a decimal integer between 1 and 65535.",
    ],
    [
      { DATABASE_URL: "private-database-value", GAME_SERVER_HOST: " " },
      "GAME_SERVER_HOST must be nonempty and contain no whitespace.",
    ],
    [
      { DATABASE_URL: "private-database-value", WEB_ORIGIN: "https://example.com/path" },
      "WEB_ORIGIN must be an HTTP or HTTPS origin without credentials, path, query, or fragment.",
    ],
    [
      { DATABASE_URL: "private-database-value", WEB_ORIGIN: "javascript:alert(1)" },
      "WEB_ORIGIN must be an HTTP or HTTPS origin without credentials, path, query, or fragment.",
    ],
  ] as const)(
    "rejects invalid configuration without reflecting supplied values",
    (input, issue) => {
      let thrown: unknown;

      try {
        parseGameServerConfiguration(input);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(GameServerConfigurationError);
      expect((thrown as GameServerConfigurationError).issues).toContain(issue);
      expect(String(thrown)).not.toContain("private-database-value");
    },
  );
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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
