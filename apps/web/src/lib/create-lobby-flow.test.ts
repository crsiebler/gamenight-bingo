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
  it("creates an invitation-ready lobby with one stable command", async () => {
    const requests: Array<{ body: unknown; path: string }> = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)), path });
      return jsonResponse(entryResponse, 201);
    });
    const nextCommandId = vi.fn(() => "command-create");
    const session = new CreateLobbyFlowSession(
      {
        username: "River",
        themeId: "nature",
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      },
      { request, nextCommandId },
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
          patternId: "standard-one-line",
          callConfiguration: { mode: "manual" },
        },
      },
    ]);
    expect(nextCommandId).toHaveBeenCalledOnce();
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
      });
    }
  });

  it("deduplicates concurrent runs", async () => {
    let releaseCreate!: () => void;
    const createPending = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) await createPending;
      return jsonResponse(entryResponse, 201);
    });
    const session = new CreateLobbyFlowSession(
      {
        username: "River",
        themeId: "nature",
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      },
      { request, nextCommandId: () => "command-create" },
    );

    const first = session.run();
    const second = session.run();
    releaseCreate();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledOnce();
  });

  it("retains ambiguous create failures for safe command replay", async () => {
    const request = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const session = new CreateLobbyFlowSession(
      {
        username: "River",
        themeId: "nature",
        patternId: "standard-one-line",
        callConfiguration: { mode: "manual" },
      },
      { request, nextCommandId: () => "command-create" },
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
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        requests.push({ body: JSON.parse(String(init?.body)), path });
        attempt += 1;
        return attempt === 1 ? firstResponse() : jsonResponse(entryResponse, 201);
      });
      const session = new CreateLobbyFlowSession(
        {
          username: "River",
          themeId: "nature",
          patternId: "standard-one-line",
          callConfiguration: { mode: "manual" },
        },
        { request, nextCommandId: () => "command-create" },
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
});
