import { describe, expect, it, vi } from "vitest";

import { CONTRACT_SCHEMA_VERSION, SnapshotSchema, type Snapshot } from "@gamenight-bingo/contracts";

import * as privateLobbyFlow from "./private-lobby-flow.js";

const { PrivateLobbyFlowError, WaitingLobbyCommandSession, loadPrivateLobbySnapshot } =
  privateLobbyFlow;

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

  it("sends exact host control requests and returns their acknowledgements", async () => {
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
    const selections = [
      {
        selection: {
          type: "configure" as const,
          code: "ABC234",
          patternId: "shape-x",
          callConfiguration: { mode: "automatic" as const, intervalSeconds: 10 as const },
        },
        commandId: "command-configure",
      },
      {
        selection: { type: "start-round" as const, code: "ABC234" },
        commandId: "command-start",
      },
      {
        selection: { type: "pause-round" as const, code: "ABC234" },
        commandId: "command-pause",
      },
      {
        selection: { type: "resume-round" as const, code: "ABC234" },
        commandId: "command-resume",
      },
      {
        selection: { type: "call-next" as const, code: "ABC234" },
        commandId: "command-call-next",
      },
      {
        selection: {
          type: "continue-round" as const,
          code: "ABC234",
          patternId: "standard-two-lines",
        },
        commandId: "command-continue",
      },
      {
        selection: { type: "end-round" as const, code: "ABC234" },
        commandId: "command-end",
      },
      {
        selection: {
          type: "override-absence" as const,
          code: "ABC234",
          participantId: "participant-player",
          presenceGeneration: 3,
        },
        commandId: "command-override",
      },
    ];

    for (const { commandId, selection } of selections) {
      await expect(
        new WaitingLobbyCommandSession(selection, {
          request,
          nextCommandId: () => commandId,
        }).run(),
      ).resolves.toMatchObject({ commandId });
    }
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
          headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
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
          headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
          body: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "start-round",
            commandId: "command-start",
          },
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/rounds/current/pause",
        init: {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
          body: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "pause-round",
            commandId: "command-pause",
          },
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/rounds/current/resume",
        init: {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
          body: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "resume-round",
            commandId: "command-resume",
          },
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/rounds/current/call-next",
        init: {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
          body: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "call-next",
            commandId: "command-call-next",
          },
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/rounds/current/continue",
        init: {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
          body: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "continue-round",
            commandId: "command-continue",
            patternId: "standard-two-lines",
          },
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/rounds/current/end",
        init: {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
          body: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "end-round",
            commandId: "command-end",
          },
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/participants/absence/override",
        init: {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
          body: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "override-absence",
            commandId: "command-override",
            participantId: "participant-player",
            presenceGeneration: 3,
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

  it("marks the own card with one replayable command ID and accepts both acknowledgement scopes", async () => {
    type MarkSessionConstructor = new (
      selection: { ball: number; code: string },
      dependencies: {
        nextCommandId: () => string;
        request: (path: string, init?: RequestInit) => Promise<Response>;
      },
    ) => { run(): Promise<{ commandId: string; scope: string }> };
    const MarkCardCommandSession = (
      privateLobbyFlow as typeof privateLobbyFlow & {
        MarkCardCommandSession?: MarkSessionConstructor;
      }
    ).MarkCardCommandSession;

    expect(MarkCardCommandSession).toBeTypeOf("function");
    if (MarkCardCommandSession === undefined) return;

    const request = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("not json", { status: 502 }))
      .mockResolvedValueOnce(
        Response.json({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          scope: "participant-private",
          commandId: "command-mark",
          occurredAt: NOW,
          eventSequence: null,
          idempotentReplay: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          scope: "active-lobby",
          commandId: "command-winning-mark",
          occurredAt: NOW,
          eventSequence: 7,
          idempotentReplay: false,
        }),
      );
    const session = new MarkCardCommandSession(
      { ball: 1, code: "ABC234" },
      { request, nextCommandId: () => "command-mark" },
    );

    await expect(session.run()).rejects.toMatchObject({ ambiguous: true, retryable: true });
    await expect(session.run()).resolves.toMatchObject({
      commandId: "command-mark",
      scope: "participant-private",
    });
    await expect(
      new MarkCardCommandSession(
        { ball: 2, code: "ABC234" },
        { request, nextCommandId: () => "command-winning-mark" },
      ).run(),
    ).resolves.toMatchObject({ commandId: "command-winning-mark", scope: "active-lobby" });

    expect(
      request.mock.calls.map(([path, init]) => ({
        path,
        body: JSON.parse(String(init?.body)),
        credentials: init?.credentials,
        method: init?.method,
      })),
    ).toEqual([
      {
        path: "/api/v1/lobbies/ABC234/cards/own/marks",
        method: "POST",
        credentials: "same-origin",
        body: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "mark-card",
          commandId: "command-mark",
          ball: 1,
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/cards/own/marks",
        method: "POST",
        credentials: "same-origin",
        body: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "mark-card",
          commandId: "command-mark",
          ball: 1,
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/cards/own/marks",
        method: "POST",
        credentials: "same-origin",
        body: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "mark-card",
          commandId: "command-winning-mark",
          ball: 2,
        },
      },
    ]);
  });
});
