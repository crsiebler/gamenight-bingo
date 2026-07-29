import { createHash } from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  PARTICIPANT_SESSION_COOKIE_NAME,
  disconnectSameDeviceSession,
  issueSameDeviceSession,
  rejoinSameDeviceSession,
  resolveSameDeviceSession,
  type ParticipantSessionStore,
} from "./participant-session.js";

const SESSION_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SESSION_TOKEN_HASH = "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a";

function createStore(overrides: Partial<ParticipantSessionStore> = {}): ParticipantSessionStore {
  return {
    createParticipantSession: async () => "created",
    expireParticipantRejoinWindows: async () => 0,
    markParticipantSessionDisconnected: async () => null,
    resolveParticipantSessionByTokenHash: async () => null,
    rejoinParticipantSessionByTokenHash: async () => null,
    ...overrides,
  };
}

describe("same-device participant sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("stores only a SHA-256 hash and returns a secure lobby-scoped cookie", async () => {
    const writes: Parameters<ParticipantSessionStore["createParticipantSession"]>[0][] = [];
    const requestedLengths: number[] = [];
    const store = createStore({
      createParticipantSession: async (session) => {
        writes.push(session);
        return "created";
      },
    });
    const issuedAt = new Date("2026-07-17T10:00:00.000Z");

    const result = await issueSameDeviceSession(
      {
        sessionId: "session-1",
        lobbyId: "lobby-1",
        lobbyCode: "ABC234",
        participantId: "participant-1",
        issuedAt,
      },
      {
        randomBytes: (length) => {
          requestedLengths.push(length);
          return new Uint8Array(length);
        },
        store,
      },
    );

    expect(requestedLengths).toEqual([32]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      id: "session-1",
      lobbyId: "lobby-1",
      participantId: "participant-1",
      tokenHash: Buffer.from(SESSION_TOKEN_HASH, "hex"),
      issuedAt,
    });
    expect(result).toEqual({
      ok: true,
      sessionId: "session-1",
      lobbyId: "lobby-1",
      participantId: "participant-1",
      cookie: {
        name: PARTICIPANT_SESSION_COOKIE_NAME,
        value: SESSION_TOKEN,
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/api/v1/lobbies/ABC234",
      },
    });
    expect(JSON.stringify(writes)).not.toContain(SESSION_TOKEN);
  });

  test("requires a new participant when the cookie is missing or malformed", async () => {
    let lookups = 0;
    const store = createStore({
      resolveParticipantSessionByTokenHash: async () => {
        lookups += 1;
        throw new Error("Invalid cookies must not reach persistence.");
      },
    });

    await expect(resolveSameDeviceSession("lobby-1", undefined, store)).resolves.toEqual({
      status: "new-participant-required",
    });
    await expect(resolveSameDeviceSession("lobby-1", "not-a-token", store)).resolves.toEqual({
      status: "new-participant-required",
    });
    expect(lookups).toBe(0);
  });

  test("expires due rejoin windows before returning for a cleared cookie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:02:00.000Z"));
    const expirySweeps: { readonly lobbyId: string; readonly requestedAt: Date }[] = [];
    const store = createStore({
      expireParticipantRejoinWindows: async (lobbyId) => {
        expirySweeps.push({ lobbyId, requestedAt: new Date() });
        return 1;
      },
      resolveParticipantSessionByTokenHash: async () => {
        throw new Error("A cleared cookie must not reach credential lookup.");
      },
    });

    await expect(resolveSameDeviceSession("lobby-1", undefined, store)).resolves.toEqual({
      status: "new-participant-required",
    });
    expect(expirySweeps).toEqual([
      {
        lobbyId: "lobby-1",
        requestedAt: new Date("2026-07-17T10:02:00.000Z"),
      },
    ]);
  });

  test("derives the prior participant only from a lobby-scoped hash lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:01:00.000Z"));
    const lookupInputs: Parameters<
      ParticipantSessionStore["resolveParticipantSessionByTokenHash"]
    >[0][] = [];
    const store = createStore({
      resolveParticipantSessionByTokenHash: async (input) => {
        lookupInputs.push(input);
        if (input.lobbyId !== "lobby-1") {
          return null;
        }
        return {
          sessionId: "session-1",
          lobbyId: "lobby-1",
          participantId: "participant-1",
          username: "Prior Player",
          role: "player",
          status: "active",
        };
      },
    });

    await expect(resolveSameDeviceSession("lobby-1", SESSION_TOKEN, store)).resolves.toEqual({
      status: "recognized",
      session: {
        sessionId: "session-1",
        lobbyId: "lobby-1",
        participantId: "participant-1",
        username: "Prior Player",
        role: "player",
        status: "active",
      },
    });
    await expect(resolveSameDeviceSession("lobby-2", SESSION_TOKEN, store)).resolves.toEqual({
      status: "new-participant-required",
    });
    expect(lookupInputs).toEqual([
      {
        lobbyId: "lobby-1",
        tokenHash: Buffer.from(SESSION_TOKEN_HASH, "hex"),
      },
      {
        lobbyId: "lobby-2",
        tokenHash: Buffer.from(SESSION_TOKEN_HASH, "hex"),
      },
    ]);
  });

  test("starts the configured rejoin window from the server clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
    const disconnects: Parameters<
      ParticipantSessionStore["markParticipantSessionDisconnected"]
    >[0][] = [];
    const store = createStore({
      markParticipantSessionDisconnected: async (input) => {
        disconnects.push(input);
        const disconnectedAt = new Date();
        return {
          sessionId: "session-1",
          lobbyId: "lobby-1",
          participantId: "participant-1",
          username: "Prior Player",
          role: "player",
          status: "disconnected",
          disconnectedAt,
          rejoinUntil: new Date(disconnectedAt.getTime() + input.reconnectWindowSeconds * 1_000),
        };
      },
    });

    await expect(
      disconnectSameDeviceSession(
        {
          lobbyId: "lobby-1",
          sessionId: "session-1",
          reconnectWindowSeconds: 120,
        },
        store,
      ),
    ).resolves.toEqual({
      ok: true,
      rejoinUntil: new Date("2026-07-17T10:02:00.000Z"),
    });
    expect(disconnects).toEqual([
      {
        lobbyId: "lobby-1",
        sessionId: "session-1",
        reconnectWindowSeconds: 120,
      },
    ]);
  });

  test("offers the prior username while the disconnected cookie remains eligible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:01:59.999Z"));
    const store = createStore({
      resolveParticipantSessionByTokenHash: async () => ({
        sessionId: "session-1",
        lobbyId: "lobby-1",
        participantId: "participant-1",
        username: "Prior Player",
        role: "player",
        status: "disconnected",
        disconnectedAt: new Date("2026-07-17T10:00:00.000Z"),
        rejoinUntil: new Date("2026-07-17T10:02:00.000Z"),
      }),
    });

    await expect(resolveSameDeviceSession("lobby-1", SESSION_TOKEN, store)).resolves.toEqual({
      status: "rejoin-available",
      label: "Rejoin as Prior Player",
      session: {
        sessionId: "session-1",
        lobbyId: "lobby-1",
        participantId: "participant-1",
        username: "Prior Player",
        role: "player",
        status: "disconnected",
        disconnectedAt: new Date("2026-07-17T10:00:00.000Z"),
        rejoinUntil: new Date("2026-07-17T10:02:00.000Z"),
      },
    });
  });

  test("rejoins only through the lobby-scoped cookie hash", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:01:59.999Z"));
    const rejoinInputs: Parameters<
      ParticipantSessionStore["rejoinParticipantSessionByTokenHash"]
    >[0][] = [];
    const store = createStore({
      rejoinParticipantSessionByTokenHash: async (input) => {
        rejoinInputs.push(input);
        return input.lobbyId === "lobby-1"
          ? {
              sessionId: "session-1",
              lobbyId: "lobby-1",
              participantId: "participant-1",
              username: "Prior Player",
              role: "player",
              status: "active",
            }
          : null;
      },
    });

    await expect(rejoinSameDeviceSession("lobby-1", SESSION_TOKEN, store)).resolves.toEqual({
      status: "recognized",
      session: {
        sessionId: "session-1",
        lobbyId: "lobby-1",
        participantId: "participant-1",
        username: "Prior Player",
        role: "player",
        status: "active",
      },
    });
    await expect(rejoinSameDeviceSession("lobby-2", SESSION_TOKEN, store)).resolves.toEqual({
      status: "new-participant-required",
    });
    expect(rejoinInputs).toEqual([
      {
        lobbyId: "lobby-1",
        tokenHash: Buffer.from(SESSION_TOKEN_HASH, "hex"),
      },
      {
        lobbyId: "lobby-2",
        tokenHash: Buffer.from(SESSION_TOKEN_HASH, "hex"),
      },
    ]);
  });

  test("regenerates a credential after an exact token-hash collision", async () => {
    let entropyCalls = 0;
    let persistenceCalls = 0;
    const store = createStore({
      createParticipantSession: async () => {
        persistenceCalls += 1;
        return persistenceCalls === 1 ? "token-hash-collision" : "created";
      },
    });

    const result = await issueSameDeviceSession(
      {
        sessionId: "session-1",
        lobbyId: "lobby-1",
        lobbyCode: "ABC234",
        participantId: "participant-1",
        issuedAt: new Date("2026-07-17T10:00:00.000Z"),
      },
      {
        randomBytes: (length) => {
          entropyCalls += 1;
          return new Uint8Array(length).fill(entropyCalls - 1);
        },
        store,
      },
    );

    expect(entropyCalls).toBe(2);
    expect(persistenceCalls).toBe(2);
    expect(result.ok && result.cookie.value).not.toBe(SESSION_TOKEN);
  });

  test("fails safely when the participant is not in the active lobby", async () => {
    const result = await issueSameDeviceSession(
      {
        sessionId: "session-1",
        lobbyId: "lobby-1",
        lobbyCode: "ABC234",
        participantId: "participant-other-lobby",
        issuedAt: new Date("2026-07-17T10:00:00.000Z"),
      },
      {
        randomBytes: (length) => new Uint8Array(length),
        store: createStore({ createParticipantSession: async () => "scope-not-found" }),
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PARTICIPANT_SESSION_SCOPE_NOT_FOUND",
        message: "The active lobby participant was not found.",
      },
    });
  });

  test("uses the hash of the encoded credential rather than raw entropy", () => {
    expect(createHash("sha256").update(SESSION_TOKEN, "ascii").digest("hex")).toBe(
      SESSION_TOKEN_HASH,
    );
  });
});
