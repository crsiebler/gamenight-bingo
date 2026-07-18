import { describe, expect, it, vi } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  SnapshotMessageSchema,
  type ActiveLobbyEvent,
  type Snapshot,
} from "@gamenight-bingo/contracts";

import {
  connectPrivateLobbyRealtime,
  parseRealtimeTicketResponse,
} from "./private-lobby-realtime.js";

const NOW = "2026-07-18T12:00:00.000Z";

type Listener = (...arguments_: unknown[]) => void;

function fakeSocket() {
  const listeners = new Map<string, Listener>();
  return {
    close: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
    }),
    trigger(event: string, value?: unknown) {
      listeners.get(event)?.(value);
    },
  };
}

const snapshotMessage = SnapshotMessageSchema.parse({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  type: "snapshot",
  snapshot: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    generatedAt: NOW,
    lastEventSequence: null,
    lobby: {
      id: "lobby-1",
      code: "ABC234",
      hostParticipantId: "participant-1",
      themeId: "animals",
      status: "waiting",
      createdAt: NOW,
    },
    session: {
      id: "session-1",
      lobbyId: "lobby-1",
      participantId: "participant-1",
      status: "active",
      issuedAt: NOW,
    },
    self: {
      id: "participant-1",
      username: "Casey",
      role: "host",
      roundEligibility: "playing",
      presence: {
        participantId: "participant-1",
        generation: 1,
        status: "connected",
        changedAt: NOW,
      },
    },
    participants: [
      {
        id: "participant-1",
        username: "Casey",
        role: "host",
        roundEligibility: "playing",
        presence: {
          participantId: "participant-1",
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
  },
});

describe("connectPrivateLobbyRealtime", () => {
  it("classifies a strict non-retryable HTTP ticket response", async () => {
    const response = new Response(
      JSON.stringify({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "error",
        code: "UNAUTHORIZED",
        message: "Authentication is required.",
        commandId: null,
        occurredAt: NOW,
        retryable: false,
        issues: [],
      }),
      { status: 401 },
    );

    await expect(parseRealtimeTicketResponse(response)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      retryable: false,
    });
  });

  it("uses a fresh ticket for each connection and parses snapshots before delivery", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    const tickets = ["A".repeat(43), "B".repeat(43)];
    const issueTicket = vi.fn(async () => tickets.shift()!);
    const createSocket = vi.fn((...arguments_: [string | undefined, unknown]) => {
      void arguments_;
      return sockets.shift()!;
    });
    const onConnectionState = vi.fn();
    const onSnapshot = vi.fn<(snapshot: Snapshot) => void>();
    const connection = connectPrivateLobbyRealtime({
      code: "ABC234",
      handlers: {
        onConnectionState,
        onLobbyEvent: vi.fn<(event: ActiveLobbyEvent) => void>(),
        onSnapshot,
      },
      issueTicket,
      createSocket,
      serverUrl: "https://game.example",
      scheduleRetry: (retry) => {
        retry();
        return retry;
      },
    });

    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());
    expect(createSocket).toHaveBeenCalledWith("https://game.example", {
      auth: { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket: "A".repeat(43) },
      reconnection: false,
      transports: ["websocket"],
    });
    const first = createSocket.mock.results[0]!.value;
    first.trigger("connect");
    expect(onConnectionState).toHaveBeenLastCalledWith("snapshot-syncing");
    first.trigger("v1:snapshot", snapshotMessage);
    expect(onSnapshot).toHaveBeenCalledWith(snapshotMessage.snapshot);

    first.trigger("disconnect", "transport close");
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledTimes(2));
    expect(issueTicket).toHaveBeenCalledTimes(2);
    expect(createSocket.mock.calls[1]?.[1]).toMatchObject({
      auth: { ticket: "B".repeat(43) },
      reconnection: false,
    });
    expect(onConnectionState).toHaveBeenCalledWith("reconnecting");

    connection.requestResync(7);
    const second = createSocket.mock.results[1]!.value;
    expect(second.emit).toHaveBeenCalledWith("v1:command", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resync",
      lastEventSequence: 7,
    });
    connection.close();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed messages and reports the connection offline", async () => {
    const socket = fakeSocket();
    const onConnectionState = vi.fn();
    const onLobbyEvent = vi.fn();
    connectPrivateLobbyRealtime({
      code: "ABC234",
      handlers: { onConnectionState, onLobbyEvent, onSnapshot: vi.fn() },
      issueTicket: async () => "A".repeat(43),
      createSocket: () => socket,
    });
    await vi.waitFor(() => expect(socket.on).toHaveBeenCalled());

    socket.trigger("v1:lobby-event", { type: "call", futureDrawOrder: [1, 2, 3] });
    expect(onLobbyEvent).not.toHaveBeenCalled();
    expect(onConnectionState).toHaveBeenLastCalledWith("offline");
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("retries transient ticket and handshake failures with fresh credentials", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    const retries: Array<() => void> = [];
    const createSocket = vi.fn((...arguments_: [string | undefined, unknown]) => {
      void arguments_;
      return sockets.shift()!;
    });
    const issueTicket = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("A".repeat(43))
      .mockResolvedValueOnce("B".repeat(43));
    const onConnectionState = vi.fn();
    const connection = connectPrivateLobbyRealtime({
      code: "ABC234",
      handlers: {
        onConnectionState,
        onLobbyEvent: vi.fn(),
        onSnapshot: vi.fn(),
      },
      issueTicket,
      createSocket,
      scheduleRetry: (retry: () => void) => {
        retries.push(retry);
        return retry;
      },
      cancelRetry: vi.fn(),
    });

    await vi.waitFor(() => expect(retries).toHaveLength(1));
    expect(onConnectionState).toHaveBeenLastCalledWith("offline");
    retries.shift()?.();
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());
    expect(createSocket.mock.calls[0]?.[1]).toMatchObject({
      auth: { ticket: "A".repeat(43) },
    });
    const first = createSocket.mock.results[0]!.value;
    first.trigger("connect_error", new Error("temporary"));
    expect(first.close).toHaveBeenCalledOnce();
    expect(retries).toHaveLength(1);
    expect(onConnectionState).toHaveBeenLastCalledWith("offline");
    retries.shift()?.();
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledTimes(2));
    expect(createSocket.mock.calls[1]?.[1]).toMatchObject({
      auth: { ticket: "B".repeat(43) },
    });

    connection.close();
  });

  it("expires instead of retrying when ticket issuance rejects the session", async () => {
    const retries: Array<() => void> = [];
    const onConnectionState = vi.fn();
    const createSocket = vi.fn();
    const issueError = Object.assign(new Error("Session expired."), {
      code: "UNAUTHORIZED",
      retryable: false,
    });

    connectPrivateLobbyRealtime({
      code: "ABC234",
      handlers: { onConnectionState, onLobbyEvent: vi.fn(), onSnapshot: vi.fn() },
      issueTicket: async () => Promise.reject(issueError),
      createSocket,
      scheduleRetry: (retry: () => void) => {
        retries.push(retry);
        return retry;
      },
    });

    await vi.waitFor(() => expect(onConnectionState).toHaveBeenLastCalledWith("expired"));
    expect(createSocket).not.toHaveBeenCalled();
    expect(retries).toHaveLength(0);
  });

  it("fails closed offline for a non-session terminal ticket error", async () => {
    const retries: Array<() => void> = [];
    const onConnectionState = vi.fn();
    connectPrivateLobbyRealtime({
      code: "ABC234",
      handlers: { onConnectionState, onLobbyEvent: vi.fn(), onSnapshot: vi.fn() },
      issueTicket: async () =>
        Promise.reject(
          Object.assign(new Error("Invalid client protocol."), {
            code: "INVALID_PAYLOAD",
            retryable: false,
          }),
        ),
      createSocket: vi.fn(),
      scheduleRetry: (retry: () => void) => {
        retries.push(retry);
        return retry;
      },
    });

    await vi.waitFor(() => expect(onConnectionState).toHaveBeenLastCalledWith("offline"));
    expect(retries).toHaveLength(0);
  });

  it("expires on a strict non-retryable handshake rejection", async () => {
    const socket = fakeSocket();
    const retries: Array<() => void> = [];
    const onConnectionState = vi.fn();
    connectPrivateLobbyRealtime({
      code: "ABC234",
      handlers: { onConnectionState, onLobbyEvent: vi.fn(), onSnapshot: vi.fn() },
      issueTicket: async () => "A".repeat(43),
      createSocket: () => socket,
      scheduleRetry: (retry: () => void) => {
        retries.push(retry);
        return retry;
      },
    });
    await vi.waitFor(() => expect(socket.on).toHaveBeenCalled());

    socket.trigger("connect_error", {
      data: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "error",
        code: "UNAUTHORIZED",
        message: "Authentication is required.",
        commandId: null,
        occurredAt: NOW,
        retryable: false,
        issues: [],
      },
    });

    expect(onConnectionState).toHaveBeenLastCalledWith("expired");
    expect(socket.close).toHaveBeenCalledOnce();
    expect(retries).toHaveLength(0);
  });

  it("keeps increasing retry delays until a snapshot establishes readiness", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    const retries: Array<{ delay: number; run: () => void }> = [];
    const createSocket = vi.fn(() => sockets.shift()!);
    connectPrivateLobbyRealtime({
      code: "ABC234",
      handlers: { onConnectionState: vi.fn(), onLobbyEvent: vi.fn(), onSnapshot: vi.fn() },
      issueTicket: async () => "A".repeat(43),
      createSocket,
      scheduleRetry: (run, delay) => {
        retries.push({ delay, run });
        return run;
      },
    });
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());

    const first = createSocket.mock.results[0]!.value;
    first.trigger("connect");
    first.trigger("disconnect", "transport close");
    expect(retries[0]?.delay).toBe(1_000);
    retries.shift()?.run();
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledTimes(2));

    const second = createSocket.mock.results[1]!.value;
    second.trigger("connect");
    second.trigger("disconnect", "transport close");
    expect(retries[0]?.delay).toBe(2_000);
  });

  it("parses participant-private events before delivery", async () => {
    const socket = fakeSocket();
    const onPrivateEvent = vi.fn();
    connectPrivateLobbyRealtime({
      code: "ABC234",
      handlers: {
        onConnectionState: vi.fn(),
        onLobbyEvent: vi.fn(),
        onPrivateEvent,
        onSnapshot: vi.fn(),
      },
      issueTicket: async () => "A".repeat(43),
      createSocket: () => socket,
    });
    await vi.waitFor(() => expect(socket.on).toHaveBeenCalled());
    const event = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-result",
      commandId: "command-private",
      occurredAt: NOW,
      mark: { id: "mark-1", cardId: "card-1", ball: 1, markedAt: NOW },
    } as const;

    socket.trigger("v1:private-event", event);

    expect(onPrivateEvent).toHaveBeenCalledWith(event);
  });

  it("reconnects with a fresh snapshot when a retryable server error rejects resync", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    const retries: Array<() => void> = [];
    const createSocket = vi.fn((...arguments_: [string | undefined, unknown]) => {
      void arguments_;
      return sockets.shift()!;
    });
    const issueTicket = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("A".repeat(43))
      .mockResolvedValueOnce("B".repeat(43));
    const connection = connectPrivateLobbyRealtime({
      code: "ABC234",
      handlers: { onConnectionState: vi.fn(), onLobbyEvent: vi.fn(), onSnapshot: vi.fn() },
      issueTicket,
      createSocket,
      scheduleRetry: (retry: () => void) => {
        retries.push(retry);
        return retry;
      },
      cancelRetry: vi.fn(),
    });
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());
    const first = createSocket.mock.results[0]!.value;
    first.trigger("v1:error", {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "error",
      code: "RATE_LIMITED",
      message: "Too many requests. Try again later.",
      commandId: null,
      occurredAt: NOW,
      retryable: true,
      issues: [],
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(retries).toHaveLength(1);
    retries.shift()?.();
    await vi.waitFor(() => expect(issueTicket).toHaveBeenCalledTimes(2));
    connection.close();
  });
});
