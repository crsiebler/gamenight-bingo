import { describe, expect, test } from "vitest";

import type {
  ActiveLobbyEventNotification,
  ActiveLobbyEventSubscriber,
} from "@gamenight-bingo/database";

import {
  GameServerConfigurationError,
  parseGameServerConfiguration,
  subscribeGameServerToActiveLobbyEvents,
  superviseGameServerResources,
} from "./runtime.js";

describe("game-server runtime configuration", () => {
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
