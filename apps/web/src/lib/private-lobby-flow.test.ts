import { describe, expect, it, vi } from "vitest";

import { CONTRACT_SCHEMA_VERSION, SnapshotSchema, type Snapshot } from "@gamenight-bingo/contracts";

import {
  PrivateLobbyFlowError,
  WaitingLobbyCommandSession,
  loadPrivateLobbySnapshot,
} from "./private-lobby-flow.js";

const NOW = "2026-07-18T12:00:00.000Z";

function hostSnapshot(): Snapshot {
  return SnapshotSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    generatedAt: NOW,
    lastEventSequence: null,
    lobby: {
      id: "lobby-1",
      code: "ABC234",
      hostParticipantId: "participant-host",
      themeId: "animals",
      status: "waiting",
      createdAt: NOW,
    },
    session: {
      id: "session-host",
      lobbyId: "lobby-1",
      participantId: "participant-host",
      status: "active",
      issuedAt: NOW,
    },
    self: {
      id: "participant-host",
      username: "Casey",
      role: "host",
      roundEligibility: "playing",
      presence: {
        participantId: "participant-host",
        generation: 1,
        status: "connected",
        changedAt: NOW,
      },
    },
    participants: [
      {
        id: "participant-host",
        username: "Casey",
        role: "host",
        roundEligibility: "playing",
        presence: {
          participantId: "participant-host",
          generation: 1,
          status: "connected",
          changedAt: NOW,
        },
      },
    ],
    round: {
      id: "round-1",
      lobbyId: "lobby-1",
      patternId: "standard-one-line",
      callConfiguration: { mode: "manual" },
      stage: "waiting",
      createdAt: NOW,
    },
    ownCard: {
      id: "card-host",
      roundId: "round-1",
      participantId: "participant-host",
      cells: [
        1,
        16,
        31,
        46,
        61,
        2,
        17,
        32,
        47,
        62,
        3,
        18,
        "FREE",
        48,
        63,
        4,
        19,
        34,
        49,
        64,
        5,
        20,
        35,
        50,
        65,
      ],
    },
    ownMarks: [],
    calls: [],
    timer: null,
  });
}

describe("private lobby flow", () => {
  it("loads and validates the actor-authorized snapshot without caching", async () => {
    const snapshot = hostSnapshot();
    const request = vi.fn(async () =>
      Response.json({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "snapshot",
        snapshot,
      }),
    );

    await expect(loadPrivateLobbySnapshot("ABC234", request)).resolves.toEqual(snapshot);
    expect(request).toHaveBeenCalledWith("/api/v1/lobbies/ABC234/snapshot", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("rejects a snapshot for a different route code", async () => {
    const snapshot = hostSnapshot();
    const request = async () =>
      Response.json({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "snapshot",
        snapshot: { ...snapshot, lobby: { ...snapshot.lobby, code: "XYZ678" } },
      });

    await expect(loadPrivateLobbySnapshot("ABC234", request)).rejects.toMatchObject({
      name: "PrivateLobbyFlowError",
      message: "We could not confirm the private lobby response.",
    });
  });

  it("replays an ambiguous start with one command ID and suppresses duplicate requests", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const request = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          scope: "active-lobby",
          commandId: "command-start",
          occurredAt: NOW,
          eventSequence: 2,
          idempotentReplay: true,
        }),
      );
    const session = new WaitingLobbyCommandSession(
      { type: "start-round", code: "ABC234" },
      { request, nextCommandId: () => "command-start" },
    );

    const first = session.run();
    expect(session.run()).toBe(first);
    resolveFirst?.(new Response("not json", { status: 502 }));
    await expect(first).rejects.toMatchObject({ ambiguous: true, retryable: true });
    await expect(session.run()).resolves.toMatchObject({
      commandId: "command-start",
      eventSequence: 2,
      scope: "active-lobby",
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.map(([, init]) => {
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        return body.commandId;
      }),
    ).toEqual(["command-start", "command-start"]);
  });

  it("sends exact configure and start requests and returns their acknowledgements", async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { commandId: string };
      return Response.json({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "ack",
        scope: "active-lobby",
        commandId: body.commandId,
        occurredAt: NOW,
        eventSequence: body.commandId === "command-configure" ? 4 : 5,
        idempotentReplay: false,
      });
    });
    const configure = new WaitingLobbyCommandSession(
      {
        type: "configure",
        code: "ABC234",
        patternId: "shape-x",
        callConfiguration: { mode: "automatic", intervalSeconds: 10 },
      },
      { request, nextCommandId: () => "command-configure" },
    );
    const start = new WaitingLobbyCommandSession(
      { type: "start-round", code: "ABC234" },
      { request, nextCommandId: () => "command-start" },
    );

    await expect(configure.run()).resolves.toMatchObject({ eventSequence: 4 });
    await expect(start.run()).resolves.toMatchObject({ eventSequence: 5 });
    expect(
      request.mock.calls.map(([path, init]) => ({
        path,
        init: { ...init, body: JSON.parse(String(init?.body)) },
      })),
    ).toEqual([
      {
        path: "/api/v1/lobbies/ABC234/configuration",
        init: {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "configure",
            commandId: "command-configure",
            patternId: "shape-x",
            callConfiguration: { mode: "automatic", intervalSeconds: 10 },
          },
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/rounds/current/start",
        init: {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "start-round",
            commandId: "command-start",
          },
        },
      },
    ]);
  });

  it("treats only an exactly correlated command error as definitive", async () => {
    const request = vi.fn(async () =>
      Response.json(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "error",
          code: "FORBIDDEN",
          message: "You are not allowed to perform this action.",
          commandId: "different-command",
          occurredAt: NOW,
          retryable: false,
          issues: [],
        },
        { status: 403 },
      ),
    );
    const session = new WaitingLobbyCommandSession(
      { type: "start-round", code: "ABC234" },
      { request, nextCommandId: () => "command-start" },
    );

    await expect(session.run()).rejects.toBeInstanceOf(PrivateLobbyFlowError);
    await expect(session.run()).rejects.toMatchObject({ ambiguous: true, retryable: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
