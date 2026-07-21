import { describe, expect, it, vi } from "vitest";

import { CreateLobbyFlowError, CreateLobbyFlowSession } from "./create-lobby-flow.js";

const entryResponse = {
  schemaVersion: 1,
  type: "lobby-entry",
  commandId: "command-create",
  idempotentReplay: false,
  lobby: { id: "lobby-1", code: "ABC234", themeId: "nature" },
  participant: {
    id: "participant-1",
    username: "River",
    role: "host",
    roundEligibility: "playing",
  },
  session: {
    id: "session-1",
    status: "active",
    issuedAt: "2026-07-18T12:00:00.000Z",
  },
} as const;

function acknowledgement(commandId: string) {
  return {
    schemaVersion: 1,
    type: "ack",
    commandId,
    occurredAt: "2026-07-18T12:00:01.000Z",
    idempotentReplay: false,
    scope: "active-lobby",
    eventSequence: 1,
  } as const;
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function internalError(commandId: string | null) {
  return {
    schemaVersion: 1,
    type: "error",
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred.",
    commandId,
    occurredAt: "2026-07-18T12:00:02.000Z",
    retryable: true,
    issues: [],
  } as const;
}

describe("public create-lobby flow", () => {
  it("creates, prepares, and configures a lobby with stable commands", async () => {
    const requests: Array<{ body: unknown; path: string }> = [];
    const responses = [
      jsonResponse(entryResponse, 201),
      jsonResponse(acknowledgement("command-round")),
      jsonResponse(acknowledgement("command-configure")),
    ];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)), path });
      return responses.shift()!;
    });
    const ids = ["command-create", "command-round", "command-configure"];
    const session = new CreateLobbyFlowSession(
      {
        username: "River",
        themeId: "nature",
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      },
      { request, nextCommandId: () => ids.shift()! },
    );

    const result = await session.run();

    expect(result).toMatchObject({ code: "ABC234", username: "River", themeId: "nature" });
    expect(requests).toEqual([
      {
        path: "/api/v1/lobbies",
        body: {
          schemaVersion: 1,
          commandId: "command-create",
          username: "River",
          themeId: "nature",
        },
      },
      {
        path: "/api/v1/lobbies/ABC234/rounds",
        body: { schemaVersion: 1, type: "create-round", commandId: "command-round" },
      },
      {
        path: "/api/v1/lobbies/ABC234/configuration",
        body: {
          schemaVersion: 1,
          type: "configure",
          commandId: "command-configure",
          patternId: "standard-one-line",
          callConfiguration: { mode: "manual" },
        },
      },
    ]);
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
      });
    }
  });

  it("retries only the unfinished step with its original command ID", async () => {
    const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
    let configurationAttempts = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)), path });
      if (path === "/api/v1/lobbies") return jsonResponse(entryResponse, 201);
      if (path.endsWith("/rounds")) return jsonResponse(acknowledgement("command-round"));
      configurationAttempts += 1;
      return configurationAttempts === 1
        ? jsonResponse(
            {
              schemaVersion: 1,
              type: "error",
              code: "INTERNAL_ERROR",
              message: "An unexpected error occurred.",
              commandId: "command-configure",
              occurredAt: "2026-07-18T12:00:02.000Z",
              retryable: true,
              issues: [],
            },
            500,
          )
        : jsonResponse(acknowledgement("command-configure"));
    });
    const ids = ["command-create", "command-round", "command-configure"];
    const session = new CreateLobbyFlowSession(
      {
        username: "River",
        themeId: "nature",
        patternId: "shape-four-corners",
        callConfiguration: { mode: "automatic", intervalSeconds: 30 },
      },
      { request, nextCommandId: () => ids.shift()! },
    );

    await expect(session.run()).rejects.toThrow("An unexpected error occurred.");
    expect(session.hasCreatedLobby).toBe(true);

    await expect(session.run()).resolves.toMatchObject({ code: "ABC234" });
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/v1/lobbies",
      "/api/v1/lobbies/ABC234/rounds",
      "/api/v1/lobbies/ABC234/configuration",
      "/api/v1/lobbies/ABC234/configuration",
    ]);
    expect(requests.at(-2)?.body["commandId"]).toBe("command-configure");
    expect(requests.at(-1)?.body["commandId"]).toBe("command-configure");
  });

  it("deduplicates concurrent runs", async () => {
    let releaseCreate!: () => void;
    const createPending = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const responses = [
      jsonResponse(entryResponse, 201),
      jsonResponse(acknowledgement("command-round")),
      jsonResponse(acknowledgement("command-configure")),
    ];
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) await createPending;
      return responses.shift()!;
    });
    const ids = ["command-create", "command-round", "command-configure"];
    const session = new CreateLobbyFlowSession(
      {
        username: "River",
        themeId: "nature",
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      },
      { request, nextCommandId: () => ids.shift()! },
    );

    const first = session.run();
    const second = session.run();
    releaseCreate();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retains ambiguous create failures for safe command replay", async () => {
    const request = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const ids = ["command-create", "command-round", "command-configure"];
    const session = new CreateLobbyFlowSession(
      {
        username: "River",
        themeId: "nature",
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      },
      { request, nextCommandId: () => ids.shift()! },
    );

    const error = await session.run().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CreateLobbyFlowError);
    expect(error).toMatchObject({ ambiguous: true, retryable: true });
    expect(error).toHaveProperty("message", expect.stringMatching(/same command/i));
  });

  it.each([
    ["malformed", () => new Response("Bad gateway", { status: 502 })],
    ["mismatched", () => jsonResponse(internalError("another-command"), 500)],
    ["uncorrelated", () => jsonResponse(internalError(null), 500)],
  ])(
    "replays the original create command after a %s error response",
    async (_name, firstResponse) => {
      const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
      let attempt = 0;
      const responses = [
        jsonResponse(entryResponse, 201),
        jsonResponse(acknowledgement("command-round")),
        jsonResponse(acknowledgement("command-configure")),
      ];
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        requests.push({ body: JSON.parse(String(init?.body)), path });
        attempt += 1;
        return attempt === 1 ? firstResponse() : responses.shift()!;
      });
      const ids = ["command-create", "command-round", "command-configure"];
      const session = new CreateLobbyFlowSession(
        {
          username: "River",
          themeId: "nature",
          patternId: "standard-one-line",
          callConfiguration: { mode: "manual" },
        },
        { request, nextCommandId: () => ids.shift()! },
      );

      await expect(session.run()).rejects.toMatchObject({ ambiguous: true, retryable: true });
      await expect(session.run()).resolves.toMatchObject({ code: "ABC234" });

      expect(requests.slice(0, 2)).toEqual([
        {
          path: "/api/v1/lobbies",
          body: expect.objectContaining({ commandId: "command-create" }),
        },
        {
          path: "/api/v1/lobbies",
          body: expect.objectContaining({ commandId: "command-create" }),
        },
      ]);
    },
  );

  it("rejects participant-private acknowledgements for lobby setup", async () => {
    const privateAck = {
      ...acknowledgement("command-round"),
      scope: "participant-private",
      eventSequence: null,
    } as const;
    const responses = [jsonResponse(entryResponse, 201), jsonResponse(privateAck)];
    const ids = ["command-create", "command-round", "command-configure"];
    const session = new CreateLobbyFlowSession(
      {
        username: "River",
        themeId: "nature",
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      },
      {
        request: async () => responses.shift()!,
        nextCommandId: () => ids.shift()!,
      },
    );

    await expect(session.run()).rejects.toMatchObject({ ambiguous: true });
  });
});
