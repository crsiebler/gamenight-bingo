import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  PARTICIPANT_SESSION_COOKIE_NAME,
  issueSameDeviceSession,
  resolveSameDeviceSession,
  type ParticipantSessionStore,
} from "./participant-session.js";

const SESSION_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SESSION_TOKEN_HASH = "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a";

function createStore(overrides: Partial<ParticipantSessionStore> = {}): ParticipantSessionStore {
  return {
    createParticipantSession: async () => "created",
    findParticipantSessionByTokenHash: async () => null,
    ...overrides,
  };
}

describe("same-device participant sessions", () => {
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
      findParticipantSessionByTokenHash: async () => {
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

  test("derives the prior participant only from a lobby-scoped hash lookup", async () => {
    const lookupInputs: Parameters<
      ParticipantSessionStore["findParticipantSessionByTokenHash"]
    >[0][] = [];
    const store = createStore({
      findParticipantSessionByTokenHash: async (input) => {
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
      { lobbyId: "lobby-1", tokenHash: Buffer.from(SESSION_TOKEN_HASH, "hex") },
      { lobbyId: "lobby-2", tokenHash: Buffer.from(SESSION_TOKEN_HASH, "hex") },
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
