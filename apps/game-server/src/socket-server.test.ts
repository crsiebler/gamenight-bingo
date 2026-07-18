import { createHash } from "node:crypto";

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
import { io as createClient, Manager, type Socket } from "socket.io-client";
import { afterEach, describe, expect, test } from "vitest";

import {
  AuthenticatedConnectionCapacity,
  BoundedFixedWindowRateLimiter,
  createGameServer,
  type AuthenticatedRealtimeIdentity,
  type GameServer,
  type RealtimeCommandExecutionResult,
} from "./socket-server.js";

const ORIGIN = "https://bingo.example.test";
const NOW = "2026-07-17T20:00:00.000Z";
const LATER = "2026-07-17T20:00:02.000Z";

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
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function waitForSignal<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 2_000);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
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
  readonly limits?: {
    readonly connectionsPerMinute?: number;
    readonly commandsPerMinute?: number;
    readonly maximumConnections?: number;
    readonly connectionsPerSession?: number;
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
  const server = createGameServer({
    allowedOrigin: ORIGIN,
    clock: options.clock ?? (() => new Date(NOW)),
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
            participantPrivateEvent: null,
          })
        );
      },
    },
    snapshotProvider: {
      findAuthorizedSnapshot: async (identity) => options.snapshot?.(identity) ?? null,
    },
    identityAuthorizer: {
      isIdentityActive: async (identity) => options.authorize?.(identity) ?? true,
    },
  });
  servers.push(server);
  const address = await server.listen({ host: "127.0.0.1", port: 0 });

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    consumedHashes,
    executed,
    async connect(
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
      const connected = once<void>(client, "connect");
      const failed = once<Error>(client, "connect_error").then((error) => Promise.reject(error));
      client.connect();
      await Promise.race([connected, failed]);
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
      const client = createClient(`http://127.0.0.1:${address.port}`, {
        autoConnect: false,
        transports: ["websocket"],
        extraHeaders: { Origin: origin },
        auth,
        reconnection: false,
      });
      clients.push(client);
      const errorPromise = once<Error & { data?: unknown }>(client, "connect_error");
      client.connect();
      return errorPromise;
    },
  };
}

describe("authenticated Socket.IO authority", () => {
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
          participantPrivateEvent: null,
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
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
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
          participantPrivateEvent: null,
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
        participantPrivateEvent: null,
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
        participantPrivateEvent: markEvent,
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
      participantPrivateEvent: null,
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
      participantPrivateEvent: null,
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
      participantPrivateEvent: markEvent,
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
      participantPrivateEvent: markEvent,
    },
  ])("rejects a $name acknowledgement for a different incoming command", async (scenario) => {
    const credential = ticket(scenario.fill);
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      execute: async () => ({
        ok: true,
        acknowledgement: scenario.acknowledgement,
        activeLobbyEvent: scenario.activeLobbyEvent,
        participantPrivateEvent: scenario.participantPrivateEvent,
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
        participantPrivateEvent: null,
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

    await harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent);
    await harness.server.publishLobbyEvent(identities.host.lobbyId, secondEvent);

    await expect(
      harness.server.publishLobbyEvent(identities.host.lobbyId, stageEvent),
    ).resolves.toBeUndefined();
    await expect(receivedSequences).resolves.toEqual([1, 2]);
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
          participantPrivateEvent: markEvent,
        };
      },
    });
    const caller = await harness.connect(credentials[0]!);
    const sameParticipant = await harness.connect(credentials[1]!);
    const otherParticipant = await harness.connect(credentials[2]!);
    const callerEvent = once<unknown>(caller, "v1:private-event");
    const sameParticipantEvent = once<unknown>(sameParticipant, "v1:private-event");
    const noOtherParticipantEvent = expectNoEvent(otherParticipant, "v1:private-event");
    const noLobbyEvent = expectNoEvent(otherParticipant, "v1:lobby-event");

    caller.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: markEvent.commandId,
      ball: 1,
    });

    await expect(callerEvent).resolves.toEqual(markEvent);
    await expect(sameParticipantEvent).resolves.toEqual(markEvent);
    await Promise.all([noOtherParticipantEvent, noLobbyEvent]);

    const replayEvent = once<unknown>(caller, "v1:private-event");
    const replayAcknowledgement = once<unknown>(caller, "v1:ack");
    const noReplayToOtherTab = expectNoEvent(sameParticipant, "v1:private-event");
    caller.emit("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: markEvent.commandId,
      ball: 1,
    });
    await expect(replayEvent).resolves.toEqual(markEvent);
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
          participantPrivateEvent: null,
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
      authorize: async () => false,
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
    const resyncHarness = await createHarness({
      tickets: new Map([[ticketHash(resyncCredential), identities.host]]),
      snapshot: async () => null,
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
    const harness = await createHarness({
      tickets: new Map([[ticketHash(credential), identities.host]]),
      snapshot: async () => {
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
