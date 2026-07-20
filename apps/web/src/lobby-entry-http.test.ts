import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { CONTRACT_SCHEMA_VERSION, SnapshotSchema } from "@gamenight-bingo/contracts";

import { PARTICIPANT_SESSION_COOKIE_NAME } from "./participant-session.js";
import {
  createInMemoryRateLimiter,
  createLobbyEntryHttpHandler,
  requesterKeyFromTrustedProxy,
  type LobbyEntryHttpDependencies,
  type LobbyEntryStore,
} from "./lobby-entry-http.js";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const SESSION_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const REALTIME_TICKET = Buffer.alloc(32, 1).toString("base64url");

test("routes a bare private lobby path through the shared dispatcher", async () => {
  const route = await readFile(
    new URL("./app/api/v1/lobbies/[code]/route.ts", import.meta.url),
    "utf8",
  );

  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    expect(route).toContain(`export const ${method} = handleLobbyEntryRequest;`);
  }
});

test("rejects unsupported private methods before looking up a lobby", async () => {
  let lobbyLookups = 0;
  const handle = createLobbyEntryHttpHandler(
    createDependencies(
      createStore({
        findActiveLobbyIdByCode: async () => {
          lobbyLookups += 1;
          return "lobby-1";
        },
      }),
    ),
  );

  for (const [method, path] of [
    ["PUT", "/api/v1/lobbies/ABC234/participants"],
    ["OPTIONS", "/api/v1/lobbies/ABC234/snapshot"],
  ] as const) {
    const response = await handle(request(path, { method }));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await responseJson(response)).toMatchObject({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "error",
      code: "NOT_FOUND",
    });
  }
  expect(lobbyLookups).toBe(0);
});

const entry = {
  commandId: "command-entry",
  idempotentReplay: false,
  lobbyId: "lobby-1",
  lobbyCode: "ABC234",
  themeId: "classic",
  participantId: "participant-1",
  username: "Host Player",
  role: "host",
  roundEligibility: "playing",
  sessionId: "session-1",
  issuedAt: NOW,
} as const;

const snapshot = SnapshotSchema.parse({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  generatedAt: NOW.toISOString(),
  lastEventSequence: null,
  lobby: {
    id: "lobby-1",
    code: "ABC234",
    hostParticipantId: "participant-1",
    themeId: "classic",
    status: "waiting",
    createdAt: NOW.toISOString(),
  },
  session: {
    id: "session-1",
    lobbyId: "lobby-1",
    participantId: "participant-1",
    status: "active",
    issuedAt: NOW.toISOString(),
  },
  self: {
    id: "participant-1",
    username: "Host Player",
    role: "host",
    roundEligibility: "playing",
    presence: {
      participantId: "participant-1",
      generation: 1,
      status: "absent",
      absentSince: NOW.toISOString(),
      changedAt: NOW.toISOString(),
      overridden: false,
    },
  },
  participants: [
    {
      id: "participant-1",
      username: "Host Player",
      role: "host",
      roundEligibility: "playing",
      presence: {
        participantId: "participant-1",
        generation: 1,
        status: "absent",
        absentSince: NOW.toISOString(),
        changedAt: NOW.toISOString(),
        overridden: false,
      },
    },
  ],
  round: null,
  ownCard: null,
  ownMarks: [],
  calls: [],
  timer: null,
});

function createStore(overrides: Partial<LobbyEntryStore> = {}): LobbyEntryStore {
  return {
    createParticipantSession: async () => "created",
    createLobbyWithHost: async () => ({ ok: true, entry }),
    joinLobbyWithSession: async () => ({
      ok: true,
      entry: { ...entry, participantId: "participant-2", username: "Guest", role: "player" },
    }),
    rejoinLobbyWithSession: async (input) => ({
      ok: true,
      entry: { ...entry, commandId: input.commandId },
    }),
    issueRealtimeTicket: async () => ({
      ok: true,
      expiresAt: new Date(NOW.getTime() + 60_000),
    }),
    findActiveLobbyIdByCode: async (code) => (code === "ABC234" ? "lobby-1" : null),
    expireParticipantRejoinWindows: async () => 0,
    markParticipantSessionDisconnected: async () => null,
    resolveParticipantSessionByTokenHash: async () => ({
      sessionId: "session-1",
      lobbyId: "lobby-1",
      participantId: "participant-1",
      username: "Host Player",
      role: "host",
      status: "active",
    }),
    rejoinParticipantSessionByTokenHash: async () => ({
      sessionId: "session-1",
      lobbyId: "lobby-1",
      participantId: "participant-1",
      username: "Host Player",
      role: "host",
      status: "active",
    }),
    findAuthorizedSnapshot: async () => snapshot,
    ...overrides,
  };
}

function createDependencies(
  store: LobbyEntryStore,
  overrides: Partial<LobbyEntryHttpDependencies> = {},
): LobbyEntryHttpDependencies {
  let id = 0;
  const commandStore = store as LobbyEntryStore & {
    executeRoundCommand?: LobbyEntryHttpDependencies["roundCommandExecutor"]["execute"];
  };
  return {
    store,
    roundCommandExecutor: {
      execute:
        commandStore.executeRoundCommand ??
        (async (input) => ({
          ok: true,
          acknowledgement: {
            commandId: input.command.commandId,
            scope: input.command.type === "mark-card" ? "participant-private" : "active-lobby",
            eventSequence: input.command.type === "mark-card" ? null : 1,
            occurredAt: NOW,
            idempotentReplay: false,
          },
        })),
    },
    patterns: [
      {
        id: "standard-one-line",
        name: "One Line",
        category: "standard",
        version: 1,
        mode: "one-line",
        source: { file: null, references: [], alias: null },
        masks: ["#####/...../...../...../....."],
      },
    ],
    rateLimiter: createInMemoryRateLimiter(
      { create: 10, join: 10, rejoin: 10, ticket: 10, status: 10, snapshot: 10, command: 10 },
      60_000,
    ),
    requesterKey: (request) => request.headers.get("x-forwarded-for") ?? "unidentified",
    clock: () => new Date(NOW),
    randomBytes: (length) => new Uint8Array(length),
    nextId: (prefix) => `${prefix}-${++id}`,
    nextLobbyCode: () => "ABC234",
    maxPlayersPerLobby: 25,
    maxActiveLobbies: 100,
    realtimeTicketTtlSeconds: 60,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if ((init.method ?? "GET") === "POST" && !headers.has("origin")) {
    headers.set("origin", "https://bingo.test");
  }
  return new Request(`https://bingo.test${path}`, { ...init, headers });
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("lobby entry HTTP API", () => {
  test("returns the versioned public pattern catalog", async () => {
    const handle = createLobbyEntryHttpHandler(createDependencies(createStore()));

    const response = await handle(request("/api/v1/patterns"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await responseJson(response)).toMatchObject({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "pattern-catalog",
      patterns: [{ id: "standard-one-line", name: "One Line" }],
    });
  });

  test("creates a lobby atomically and returns the credential only as a secure cookie", async () => {
    const writes: Parameters<LobbyEntryStore["createLobbyWithHost"]>[0][] = [];
    const store = createStore({
      createLobbyWithHost: async (input) => {
        writes.push(input);
        return { ok: true, entry };
      },
    });
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request("/api/v1/lobbies", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          commandId: "command-create",
          username: "Host Player",
          themeId: "classic",
        }),
      }),
    );
    const body = await responseJson(response);

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBe(
      `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}; Path=/api/v1/lobbies/ABC234; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(JSON.stringify(body)).not.toContain(SESSION_TOKEN);
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      commandId: "command-create",
      username: "Host Player",
      themeId: "classic",
      maxActiveLobbies: 100,
    });
    expect(writes[0]?.tokenHash).toHaveLength(32);
  });

  test("does not mint a credential when a create command is replayed", async () => {
    const store = createStore({
      createLobbyWithHost: async () => ({
        ok: true,
        entry: { ...entry, commandId: "command-create", idempotentReplay: true },
      }),
    });
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request("/api/v1/lobbies", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          commandId: "command-create",
          username: "Host Player",
          themeId: "classic",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await responseJson(response)).toMatchObject({
      commandId: "command-create",
      idempotentReplay: true,
      session: { id: entry.sessionId },
    });
  });

  test("normalizes a lobby code before an atomic join", async () => {
    const writes: Parameters<LobbyEntryStore["joinLobbyWithSession"]>[0][] = [];
    const store = createStore({
      joinLobbyWithSession: async (input) => {
        writes.push(input);
        return {
          ok: true,
          entry: { ...entry, participantId: "participant-2", username: "Guest", role: "player" },
        };
      },
    });
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request("/api/v1/lobbies/abc234/participants", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          commandId: "command-join",
          username: "Guest",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      lobbyId: "lobby-1",
      lobbyCode: "ABC234",
      commandId: "command-join",
      username: "Guest",
      maxPlayersPerLobby: 25,
    });
  });

  test("does not mint a credential when a join command is replayed", async () => {
    const store = createStore({
      joinLobbyWithSession: async () => ({
        ok: true,
        entry: {
          ...entry,
          commandId: "command-join",
          idempotentReplay: true,
          role: "player",
        },
      }),
    });
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request("/api/v1/lobbies/ABC234/participants", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          commandId: "command-join",
          username: "Guest",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await responseJson(response)).toMatchObject({
      commandId: "command-join",
      idempotentReplay: true,
      session: { id: entry.sessionId },
    });
  });

  test("issues a scoped realtime ticket while persisting only its hash", async () => {
    const writes: Parameters<LobbyEntryStore["issueRealtimeTicket"]>[0][] = [];
    const store = createStore({
      issueRealtimeTicket: async (input) => {
        writes.push(input);
        return { ok: true, expiresAt: new Date(NOW.getTime() + 60_000) };
      },
    });
    const bytes = Buffer.from(REALTIME_TICKET, "base64url");
    const handle = createLobbyEntryHttpHandler(
      createDependencies(store, { randomBytes: () => new Uint8Array(bytes) }),
    );

    const response = await handle(
      request("/api/v1/lobbies/ABC234/realtime-ticket", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: CONTRACT_SCHEMA_VERSION }),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );
    const body = await responseJson(response);

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "realtime-ticket",
      ticket: REALTIME_TICKET,
      expiresAt: "2026-07-17T12:01:00.000Z",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ lobbyId: "lobby-1", ttlSeconds: 60 });
    expect(writes[0]?.sessionTokenHash).toHaveLength(32);
    expect(writes[0]?.ticketHash).toHaveLength(32);
    expect(JSON.stringify(writes[0])).not.toContain(REALTIME_TICKET);
    expect(JSON.stringify(writes[0])).not.toContain(SESSION_TOKEN);
  });

  test("requires a valid scoped cookie and redacts credentials from ticket errors", async () => {
    let writes = 0;
    const store = createStore({
      issueRealtimeTicket: async () => {
        writes += 1;
        return { ok: false, error: { code: "UNAUTHORIZED" } };
      },
    });
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    for (const cookie of [undefined, "malformed", SESSION_TOKEN]) {
      const response = await handle(
        request("/api/v1/lobbies/ABC234/realtime-ticket", {
          method: "POST",
          body: JSON.stringify({ schemaVersion: CONTRACT_SCHEMA_VERSION }),
          ...(cookie === undefined
            ? {}
            : { headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${cookie}` } }),
        }),
      );
      const serialized = JSON.stringify(await responseJson(response));
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(serialized).not.toContain(cookie ?? "missing");
      expect(serialized).not.toContain(REALTIME_TICKET);
      expect(serialized).not.toContain("tokenHash");
    }
    expect(writes).toBe(1);
  });

  test("retries a realtime ticket hash collision with fresh entropy", async () => {
    const first = new Uint8Array(32).fill(1);
    const second = new Uint8Array(32).fill(2);
    let randomCalls = 0;
    let writes = 0;
    const store = createStore({
      issueRealtimeTicket: async () => {
        writes += 1;
        return writes === 1
          ? { ok: false, error: { code: "TICKET_HASH_COLLISION" } }
          : { ok: true, expiresAt: new Date(NOW.getTime() + 60_000) };
      },
    });
    const handle = createLobbyEntryHttpHandler(
      createDependencies(store, {
        randomBytes: () => (randomCalls++ === 0 ? first : second),
      }),
    );

    const response = await handle(
      request("/api/v1/lobbies/ABC234/realtime-ticket", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: CONTRACT_SCHEMA_VERSION }),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );

    expect(response.status).toBe(201);
    expect(((await responseJson(response)) as { ticket: string }).ticket).toBe(
      Buffer.from(second).toString("base64url"),
    );
    expect(randomCalls).toBe(2);
    expect(writes).toBe(2);
  });

  test("mints a distinct ticket for each authenticated reconnect request", async () => {
    let entropy = 0;
    const persistedHashes: Uint8Array[] = [];
    const store = createStore({
      issueRealtimeTicket: async ({ ticketHash }) => {
        persistedHashes.push(ticketHash);
        return { ok: true, expiresAt: new Date(NOW.getTime() + 60_000) };
      },
    });
    const handle = createLobbyEntryHttpHandler(
      createDependencies(store, {
        randomBytes: (length) => new Uint8Array(length).fill(++entropy),
      }),
    );
    const issue = () =>
      handle(
        request("/api/v1/lobbies/ABC234/realtime-ticket", {
          method: "POST",
          body: JSON.stringify({ schemaVersion: CONTRACT_SCHEMA_VERSION }),
          headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
        }),
      );

    const first = (await responseJson(await issue())) as { ticket: string };
    const second = (await responseJson(await issue())) as { ticket: string };

    expect(first.ticket).not.toBe(second.ticket);
    expect(persistedHashes).toHaveLength(2);
    expect(persistedHashes[0]).not.toEqual(persistedHashes[1]);
  });

  test("uses independent create, join, and rejoin rate-limit buckets", async () => {
    const limiter = createInMemoryRateLimiter(
      { create: 1, join: 1, rejoin: 1, ticket: 1, status: 1, snapshot: 1, command: 1 },
      60_000,
    );
    const handle = createLobbyEntryHttpHandler(
      createDependencies(createStore(), { rateLimiter: limiter }),
    );
    const createBody = JSON.stringify({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      commandId: "command-create",
      username: "Host",
      themeId: "classic",
    });

    expect(
      (await handle(request("/api/v1/lobbies", { method: "POST", body: createBody }))).status,
    ).toBe(201);
    const limited = await handle(request("/api/v1/lobbies", { method: "POST", body: createBody }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toBe("no-store");

    expect(
      (
        await handle(
          request("/api/v1/lobbies/ABC234/participants", {
            method: "POST",
            body: JSON.stringify({
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              commandId: "command-join",
              username: "Guest",
            }),
          }),
        )
      ).status,
    ).toBe(201);

    const joinBody = JSON.stringify({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      commandId: "command-join",
      username: "Guest",
    });
    const limitedJoin = await handle(
      request("/api/v1/lobbies/ABC234/participants", { method: "POST", body: joinBody }),
    );
    expect(limitedJoin.status).toBe(429);

    const rejoinBody = JSON.stringify({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      commandId: "command-rejoin",
    });
    const rejoinRequest = () =>
      request("/api/v1/lobbies/ABC234/session/rejoin", {
        method: "POST",
        body: rejoinBody,
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      });
    expect((await handle(rejoinRequest())).status).toBe(200);
    expect((await handle(rejoinRequest())).status).toBe(429);

    const ticketRequest = () =>
      request("/api/v1/lobbies/ABC234/realtime-ticket", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: CONTRACT_SCHEMA_VERSION }),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      });
    expect((await handle(ticketRequest())).status).toBe(201);
    expect((await handle(ticketRequest())).status).toBe(429);
  });

  test("isolates limiter buckets by the trusted requester identity", async () => {
    const limiter = createInMemoryRateLimiter(
      { create: 1, join: 1, rejoin: 1, ticket: 1, status: 1, snapshot: 1, command: 1 },
      60_000,
    );
    const handle = createLobbyEntryHttpHandler(
      createDependencies(createStore(), { rateLimiter: limiter }),
    );
    const join = (requester: string, command: number) =>
      request("/api/v1/lobbies/ABC234/participants", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          commandId: `command-requester-${command}`,
          username: `Guest ${command}`,
        }),
        headers: { "x-forwarded-for": requester },
      });

    expect((await handle(join("192.0.2.1", 1))).status).toBe(201);
    expect((await handle(join("192.0.2.2", 2))).status).toBe(201);
    expect((await handle(join("192.0.2.1", 3))).status).toBe(429);
  });

  test("resets a fixed-window bucket at the exact deadline", () => {
    const limiter = createInMemoryRateLimiter(
      { create: 1, join: 1, rejoin: 1, ticket: 1, status: 1, snapshot: 1, command: 1 },
      1_000,
    );
    const startedAt = new Date(NOW);

    expect(limiter.consume({ scope: "create", key: "client", now: startedAt })).toEqual({
      allowed: true,
    });
    expect(
      limiter.consume({
        scope: "create",
        key: "client",
        now: new Date(startedAt.getTime() + 999),
      }),
    ).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(
      limiter.consume({
        scope: "create",
        key: "client",
        now: new Date(startedAt.getTime() + 1_000),
      }),
    ).toEqual({ allowed: true });
  });

  test("bounds active requester buckets and reclaims expired capacity", () => {
    const limiter = createInMemoryRateLimiter(
      { create: 1, join: 1, rejoin: 1, ticket: 1, status: 1, snapshot: 1, command: 1 },
      1_000,
      2,
    );
    const startedAt = new Date(NOW);

    expect(limiter.consume({ scope: "join", key: "client-a", now: startedAt })).toEqual({
      allowed: true,
    });
    expect(limiter.consume({ scope: "join", key: "client-b", now: startedAt })).toEqual({
      allowed: true,
    });
    expect(limiter.consume({ scope: "join", key: "client-c", now: startedAt })).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(
      limiter.consume({
        scope: "join",
        key: "client-c",
        now: new Date(startedAt.getTime() + 1_000),
      }),
    ).toEqual({ allowed: true });
  });

  test("derives a private stable requester key from a trusted proxy boundary", () => {
    const secret = "a".repeat(32);
    const forwarded = request("/api/v1/patterns", {
      headers: {
        "x-forwarded-for": "198.51.100.99, 192.0.2.10",
        "x-gamenight-trusted-proxy": secret,
      },
    });
    const direct = request("/api/v1/patterns", {
      headers: {
        "x-forwarded-for": "192.0.2.10",
        "x-gamenight-trusted-proxy": secret,
      },
    });
    const absent = request("/api/v1/patterns");
    const invalid = request("/api/v1/patterns", {
      headers: { "x-forwarded-for": "attacker-controlled" },
    });

    expect(requesterKeyFromTrustedProxy(forwarded, secret)).toBe(
      requesterKeyFromTrustedProxy(direct, secret),
    );
    expect(requesterKeyFromTrustedProxy(absent, secret)).toBe(
      requesterKeyFromTrustedProxy(invalid, secret),
    );
    expect(requesterKeyFromTrustedProxy(direct, secret)).not.toContain("192.0.2.10");
    expect(requesterKeyFromTrustedProxy(direct, secret)).not.toBe(
      requesterKeyFromTrustedProxy(direct, undefined),
    );
    expect(
      requesterKeyFromTrustedProxy(
        request("/api/v1/patterns", {
          headers: {
            "x-forwarded-for": "192.0.2.10",
            "x-gamenight-trusted-proxy": "wrong-secret",
          },
        }),
        secret,
      ),
    ).toBe(requesterKeyFromTrustedProxy(absent, secret));
  });

  test("rate-limits session status before unauthenticated lobby maintenance", async () => {
    let expirySweeps = 0;
    let snapshots = 0;
    const store = createStore({
      expireParticipantRejoinWindows: async () => {
        expirySweeps += 1;
        return 0;
      },
      findAuthorizedSnapshot: async () => {
        snapshots += 1;
        return snapshot;
      },
    });
    const limits = {
      create: 10,
      join: 10,
      rejoin: 10,
      ticket: 10,
      status: 1,
      snapshot: 1,
      command: 1,
    } as const;
    const handle = createLobbyEntryHttpHandler(
      createDependencies(store, { rateLimiter: createInMemoryRateLimiter(limits, 60_000) }),
    );

    expect((await handle(request("/api/v1/lobbies/ABC234/session"))).status).toBe(200);
    expect((await handle(request("/api/v1/lobbies/ABC234/session"))).status).toBe(429);
    expect(expirySweeps).toBe(1);

    const snapshotRequest = () =>
      request("/api/v1/lobbies/ABC234/snapshot", {
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      });
    expect((await handle(snapshotRequest())).status).toBe(200);
    expect((await handle(snapshotRequest())).status).toBe(429);
    expect(snapshots).toBe(1);
  });

  test("stops reading a streamed body as soon as the byte limit is exceeded", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(4_097));
          return;
        }
        throw new Error("The handler read beyond the configured byte budget.");
      },
    });
    const handle = createLobbyEntryHttpHandler(createDependencies(createStore()));
    const streamed = new Request("https://bingo.test/api/v1/lobbies", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://bingo.test" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await handle(streamed);

    expect(response.status).toBe(413);
    expect(pulls).toBe(1);
  });

  test("rejects cross-origin, oversized, and non-JSON mutations before persistence", async () => {
    let writes = 0;
    const store = createStore({
      createLobbyWithHost: async () => {
        writes += 1;
        return { ok: true, entry };
      },
    });
    const handle = createLobbyEntryHttpHandler(createDependencies(store));
    const payload = JSON.stringify({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      commandId: "command-create",
      username: "Host",
      themeId: "classic",
    });

    const crossOrigin = request("/api/v1/lobbies", {
      method: "POST",
      body: payload,
      headers: { origin: "https://evil.test" },
    });
    const oversized = request("/api/v1/lobbies", {
      method: "POST",
      body: JSON.stringify({ padding: "x".repeat(4_096) }),
    });
    const wrongMediaType = request("/api/v1/lobbies", {
      method: "POST",
      body: payload,
      headers: { "content-type": "text/plain" },
    });

    await expect(handle(crossOrigin)).resolves.toMatchObject({ status: 403 });
    await expect(handle(oversized)).resolves.toMatchObject({ status: 413 });
    await expect(handle(wrongMediaType)).resolves.toMatchObject({ status: 415 });
    expect(writes).toBe(0);
  });

  test("returns same-device status without treating the lobby code as identity", async () => {
    let lookups = 0;
    const store = createStore({
      resolveParticipantSessionByTokenHash: async () => {
        lookups += 1;
        return null;
      },
    });
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(request("/api/v1/lobbies/ABC234/session"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await responseJson(response)).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "same-device-session-status",
      status: "new-participant-required",
    });
    expect(lookups).toBe(0);
  });

  test.each([
    ["USERNAME_TAKEN", 409, "USERNAME_TAKEN"],
    ["LOBBY_FULL", 409, "LOBBY_FULL"],
    ["ACTIVE_LOBBY_LIMIT_REACHED", 503, "ACTIVE_LOBBY_LIMIT_REACHED"],
    ["LOBBY_NOT_FOUND", 404, "NOT_FOUND"],
  ] as const)("maps %s to a stable no-store error", async (storeCode, status, publicCode) => {
    const handle = createLobbyEntryHttpHandler(
      createDependencies(
        createStore({
          createLobbyWithHost: async () => ({ ok: false, error: { code: storeCode } }),
        }),
      ),
    );
    const response = await handle(
      request("/api/v1/lobbies", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          commandId: "command-error",
          username: "Host",
          themeId: "classic",
        }),
      }),
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await responseJson(response)).toMatchObject({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "error",
      code: publicCode,
      commandId: "command-error",
      issues: [],
    });
  });

  test("rejoins only through the scoped cookie and applies the rejoin rate limit", async () => {
    const handle = createLobbyEntryHttpHandler(
      createDependencies(
        createStore({
          rejoinLobbyWithSession: async (input) => ({
            ok: true,
            entry: { ...entry, commandId: input.commandId, idempotentReplay: true },
          }),
        }),
      ),
    );
    const response = await handle(
      request("/api/v1/lobbies/ABC234/session/rejoin", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          commandId: "command-rejoin",
        }),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await responseJson(response)).toMatchObject({
      type: "lobby-entry",
      commandId: "command-rejoin",
      idempotentReplay: true,
      participant: { id: "participant-1", username: "Host Player" },
    });
  });

  test("uses one store operation to commit and activate a rejoin", async () => {
    let atomicCalls = 0;
    let splitCalls = 0;
    const store = {
      ...createStore({
        resolveParticipantSessionByTokenHash: async () => {
          splitCalls += 1;
          return null;
        },
        rejoinParticipantSessionByTokenHash: async () => {
          splitCalls += 1;
          return {
            sessionId: "session-1",
            lobbyId: "lobby-1",
            participantId: "participant-1",
            username: "Host Player",
            role: "host",
            status: "active",
          };
        },
      }),
      rejoinLobbyWithSession: async (input: { commandId: string }) => {
        atomicCalls += 1;
        return {
          ok: true as const,
          entry: { ...entry, commandId: input.commandId },
        };
      },
    };
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request("/api/v1/lobbies/ABC234/session/rejoin", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          commandId: "command-rejoin",
        }),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(atomicCalls).toBe(1);
    expect(splitCalls).toBe(0);
  });

  test("requires the scoped cookie for an actor-authorized snapshot", async () => {
    let snapshots = 0;
    let preliminarySessionResolutions = 0;
    const store = createStore({
      resolveParticipantSessionByTokenHash: async () => {
        preliminarySessionResolutions += 1;
        return {
          sessionId: "session-1",
          lobbyId: "lobby-1",
          participantId: "participant-1",
          username: "Host Player",
          role: "host",
          status: "active",
        };
      },
      findAuthorizedSnapshot: async () => {
        snapshots += 1;
        return snapshot;
      },
    });
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const denied = await handle(request("/api/v1/lobbies/ABC234/snapshot"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(snapshots).toBe(0);

    const allowed = await handle(
      request("/api/v1/lobbies/ABC234/snapshot", {
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );
    const body = await responseJson(allowed);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(preliminarySessionResolutions).toBe(0);
    expect(body).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "snapshot",
      snapshot,
    });
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(body)).not.toContain("drawOrder");
    expect(JSON.stringify(body)).not.toContain("commandResults");
    expect(JSON.stringify(body)).not.toContain("events");
  });

  test.each(["events", "history", "restore"])(
    "does not define a private %s retrieval endpoint",
    async (resource) => {
      const handle = createLobbyEntryHttpHandler(createDependencies(createStore()));
      const response = await handle(request(`/api/v1/lobbies/ABC234/${resource}`));

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
});

describe("round-control HTTP API", () => {
  const hostCommands = [
    [
      "/api/v1/lobbies/ABC234/configuration",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "configure",
        commandId: "command-configure",
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      },
    ],
    [
      "/api/v1/lobbies/ABC234/rounds",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "create-round",
        commandId: "command-create-round",
      },
    ],
    [
      "/api/v1/lobbies/ABC234/rounds/current/start",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "start-round",
        commandId: "command-start",
      },
    ],
    [
      "/api/v1/lobbies/ABC234/rounds/current/pause",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "pause-round",
        commandId: "command-pause",
      },
    ],
    [
      "/api/v1/lobbies/ABC234/rounds/current/resume",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "resume-round",
        commandId: "command-resume",
      },
    ],
    [
      "/api/v1/lobbies/ABC234/rounds/current/call-next",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "call-next",
        commandId: "command-call-next",
      },
    ],
    [
      "/api/v1/lobbies/ABC234/rounds/current/continue",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "continue-round",
        commandId: "command-continue",
        patternId: "standard-two-lines",
      },
    ],
    [
      "/api/v1/lobbies/ABC234/rounds/current/end",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "end-round",
        commandId: "command-end",
      },
    ],
    [
      "/api/v1/lobbies/ABC234/participants/absence/override",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "override-absence",
        commandId: "command-override",
        participantId: "participant-player",
        presenceGeneration: 3,
      },
    ],
  ] as const;

  test.each(hostCommands)("dispatches %s as a committed host command", async (path, command) => {
    const executions: unknown[] = [];
    const store = {
      ...createStore(),
      executeRoundCommand: async (input: unknown) => {
        executions.push(input);
        return {
          ok: true as const,
          acknowledgement: {
            commandId: command.commandId,
            scope: "active-lobby" as const,
            eventSequence: 7,
            occurredAt: NOW,
            idempotentReplay: false,
          },
        };
      },
    };
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request(path, {
        method: "POST",
        body: JSON.stringify(command),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await responseJson(response)).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "ack",
      commandId: command.commandId,
      scope: "active-lobby",
      eventSequence: 7,
      occurredAt: NOW.toISOString(),
      idempotentReplay: false,
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ lobbyId: "lobby-1", command });
    expect((executions[0] as { sessionTokenHash: Uint8Array }).sessionTokenHash).toHaveLength(32);
    expect(JSON.stringify(executions[0])).not.toContain(SESSION_TOKEN);
  });

  test("returns a participant-private acknowledgement for an own-card mark", async () => {
    const command = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: "command-mark",
      ball: 42,
    } as const;
    const store = {
      ...createStore(),
      executeRoundCommand: async () => ({
        ok: true as const,
        acknowledgement: {
          commandId: command.commandId,
          scope: "participant-private" as const,
          eventSequence: null,
          occurredAt: NOW,
          idempotentReplay: true,
        },
      }),
    };
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request("/api/v1/lobbies/ABC234/cards/own/marks", {
        method: "POST",
        body: JSON.stringify(command),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "ack",
      commandId: command.commandId,
      scope: "participant-private",
      eventSequence: null,
      occurredAt: NOW.toISOString(),
      idempotentReplay: true,
    });
  });

  test.each([
    { mode: "manual", intervalSeconds: 30 },
    { mode: "automatic" },
    { mode: "automatic", intervalSeconds: 15 },
    { mode: "automatic", intervalSeconds: "30" },
  ])("rejects invalid call configuration $mode/$intervalSeconds", async (callConfiguration) => {
    let executions = 0;
    const store = {
      ...createStore(),
      executeRoundCommand: async () => {
        executions += 1;
        throw new Error("invalid configuration reached persistence");
      },
    };
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request("/api/v1/lobbies/ABC234/configuration", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "configure",
          commandId: "command-invalid-configuration",
          patternId: "standard-one-line",
          callConfiguration,
        }),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await responseJson(response)).toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(executions).toBe(0);
  });

  test.each([5, 10, 30, 60, 120])(
    "accepts the supported %i-second automatic interval",
    async (intervalSeconds) => {
      let executions = 0;
      const store = {
        ...createStore(),
        executeRoundCommand: async () => {
          executions += 1;
          return {
            ok: true as const,
            acknowledgement: {
              commandId: `command-automatic-${intervalSeconds}`,
              scope: "active-lobby" as const,
              eventSequence: 2,
              occurredAt: NOW,
              idempotentReplay: false,
            },
          };
        },
      };
      const handle = createLobbyEntryHttpHandler(createDependencies(store));

      const response = await handle(
        request("/api/v1/lobbies/ABC234/configuration", {
          method: "POST",
          body: JSON.stringify({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "configure",
            commandId: `command-automatic-${intervalSeconds}`,
            patternId: "standard-one-line",
            callConfiguration: { mode: "automatic", intervalSeconds },
          }),
          headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
        }),
      );

      expect(response.status).toBe(200);
      expect(executions).toBe(1);
    },
  );

  test("requires the scoped cookie before command execution", async () => {
    let executions = 0;
    const store = {
      ...createStore(),
      executeRoundCommand: async () => {
        executions += 1;
        throw new Error("unauthenticated command reached persistence");
      },
    };
    const handle = createLobbyEntryHttpHandler(createDependencies(store));
    const body = JSON.stringify({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "pause-round",
      commandId: "command-unauthenticated",
    });

    for (const cookie of [undefined, "malformed"]) {
      const response = await handle(
        request("/api/v1/lobbies/ABC234/rounds/current/pause", {
          method: "POST",
          body,
          ...(cookie === undefined
            ? {}
            : { headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${cookie}` } }),
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(executions).toBe(0);
  });

  test.each([
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["INVALID_COMMAND", 409],
  ] as const)("maps command result %s to a stable error", async (code, status) => {
    const store = {
      ...createStore(),
      executeRoundCommand: async () => ({ ok: false as const, error: { code } }),
    };
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request("/api/v1/lobbies/ABC234/rounds/current/start", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "start-round",
          commandId: "command-rejected",
        }),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await responseJson(response)).toMatchObject({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "error",
      code,
      commandId: "command-rejected",
    });
  });

  test("rejects a body command that does not match the endpoint", async () => {
    let executions = 0;
    const store = {
      ...createStore(),
      executeRoundCommand: async () => {
        executions += 1;
        throw new Error("mismatched command reached persistence");
      },
    };
    const handle = createLobbyEntryHttpHandler(createDependencies(store));

    const response = await handle(
      request("/api/v1/lobbies/ABC234/rounds/current/start", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "end-round",
          commandId: "command-wrong-endpoint",
        }),
        headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
      }),
    );

    expect(response.status).toBe(400);
    expect(executions).toBe(0);
  });

  test("rate-limits commands before they acquire the lobby transaction fence", async () => {
    let executions = 0;
    const store = {
      ...createStore(),
      executeRoundCommand: async (input: { command: { commandId: string } }) => {
        executions += 1;
        return {
          ok: true as const,
          acknowledgement: {
            commandId: input.command.commandId,
            scope: "active-lobby" as const,
            eventSequence: executions,
            occurredAt: NOW,
            idempotentReplay: false,
          },
        };
      },
    };
    const rateLimiter = createInMemoryRateLimiter(
      {
        create: 10,
        join: 10,
        rejoin: 10,
        ticket: 10,
        status: 10,
        snapshot: 10,
        command: 1,
      },
      60_000,
    );
    const handle = createLobbyEntryHttpHandler(createDependencies(store, { rateLimiter }));
    const execute = (commandId: string) =>
      handle(
        request("/api/v1/lobbies/ABC234/rounds/current/start", {
          method: "POST",
          body: JSON.stringify({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "start-round",
            commandId,
          }),
          headers: { cookie: `${PARTICIPANT_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
        }),
      );

    expect((await execute("command-rate-1")).status).toBe(200);
    const limited = await execute("command-rate-2");

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(executions).toBe(1);
  });
});
