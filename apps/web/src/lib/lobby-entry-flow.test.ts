import { describe, expect, it, vi } from "vitest";

import {
  LobbyEntryFlowError,
  LobbyEntryFlowSession,
  lookupSameDeviceSession,
} from "./lobby-entry-flow.js";

const statusResponse = {
  schemaVersion: 1,
  type: "same-device-session-status",
  status: "rejoin-available",
  username: "Prior Player",
  rejoinUntil: "2026-07-18T12:02:00.000Z",
} as const;

const entryResponse = {
  schemaVersion: 1,
  type: "lobby-entry",
  commandId: "command-entry",
  idempotentReplay: false,
  lobby: { id: "lobby-1", code: "ABC234", themeId: "nature" },
  participant: {
    id: "participant-1",
    username: "River Song",
    role: "player",
    roundEligibility: "waiting",
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

function contractError(code: "NOT_FOUND" | "UNAUTHORIZED", commandId: string | null) {
  const messages = {
    NOT_FOUND: "The requested resource was not found.",
    UNAUTHORIZED: "Authentication is required.",
  } as const;
  return {
    schemaVersion: 1,
    type: "error",
    code,
    message: messages[code],
    commandId,
    occurredAt: "2026-07-18T12:00:01.000Z",
    retryable: false,
    issues: [],
  } as const;
}

describe("public lobby entry flow", () => {
  it("looks up scoped same-device status without sending identity in the URL", async () => {
    const request = vi.fn(async () => jsonResponse(statusResponse));

    await expect(lookupSameDeviceSession("ABC234", { request })).resolves.toEqual(statusResponse);

    expect(request).toHaveBeenCalledWith("/api/v1/lobbies/ABC234/session", {
      credentials: "same-origin",
      method: "GET",
    });
  });

  it("turns an unknown locator into actionable lobby-specific copy", async () => {
    const request = vi.fn(async () => jsonResponse(contractError("NOT_FOUND", null), 404));

    await expect(lookupSameDeviceSession("ABC234", { request })).rejects.toThrow(
      "We couldn't find a lobby with that code. Check the code and try again.",
    );
  });

  it("joins with a stable command and retains server-provided waiting eligibility", async () => {
    const requests: Array<{ body: unknown; path: string }> = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)), path });
      return jsonResponse(entryResponse, 201);
    });
    const session = new LobbyEntryFlowSession(
      { action: "join", code: "ABC234", username: "River Song" },
      { request, nextCommandId: () => "command-entry" },
    );

    await expect(session.run()).resolves.toMatchObject({
      participant: { roundEligibility: "waiting" },
    });
    expect(requests).toEqual([
      {
        path: "/api/v1/lobbies/ABC234/participants",
        body: { schemaVersion: 1, commandId: "command-entry", username: "River Song" },
      },
    ]);
  });

  it("rejoins through the cookie-scoped endpoint without a browser identity claim", async () => {
    const request = vi.fn(async () => jsonResponse(entryResponse));
    const session = new LobbyEntryFlowSession(
      { action: "rejoin", code: "ABC234" },
      { request, nextCommandId: () => "command-entry" },
    );

    await session.run();

    expect(request).toHaveBeenCalledWith("/api/v1/lobbies/ABC234/session/rejoin", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
      body: JSON.stringify({ schemaVersion: 1, commandId: "command-entry" }),
    });
  });

  it("deduplicates concurrent runs into one state-changing request", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const session = new LobbyEntryFlowSession(
      { action: "join", code: "ABC234", username: "River Song" },
      { request, nextCommandId: () => "command-entry" },
    );

    const first = session.run();
    const second = session.run();

    expect(second).toBe(first);
    expect(request).toHaveBeenCalledOnce();
    resolveRequest(jsonResponse(entryResponse, 201));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledOnce();
  });

  it("verifies the cookie-scoped identity before accepting a replayed join", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...entryResponse, idempotentReplay: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: 1,
          type: "same-device-session-status",
          status: "active",
          username: "River Song",
          role: "player",
        }),
      );
    const session = new LobbyEntryFlowSession(
      { action: "join", code: "ABC234", username: "River Song" },
      { request, nextCommandId: () => "command-entry" },
    );

    await expect(session.run()).resolves.toMatchObject({ idempotentReplay: true });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/lobbies/ABC234/participants",
      "/api/v1/lobbies/ABC234/session",
    ]);
  });

  it("does not report replay success when the browser lacks the committed session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...entryResponse, idempotentReplay: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: 1,
          type: "same-device-session-status",
          status: "new-participant-required",
        }),
      );
    const session = new LobbyEntryFlowSession(
      { action: "join", code: "ABC234", username: "River Song" },
      { request, nextCommandId: () => "command-entry" },
    );

    await expect(session.run()).rejects.toMatchObject({
      ambiguous: false,
      code: "UNAUTHORIZED",
      retryable: false,
    } satisfies Partial<LobbyEntryFlowError>);
  });

  it.each([
    ["network failure", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["malformed response", async () => new Response("Bad gateway", { status: 502 })],
    [
      "mismatched response",
      async () => jsonResponse({ ...entryResponse, commandId: "different-command" }),
    ],
  ])("replays the original command after a %s", async (_name, firstRequest) => {
    const bodies: Array<Record<string, unknown>> = [];
    let attempt = 0;
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      attempt += 1;
      return attempt === 1 ? firstRequest() : jsonResponse(entryResponse);
    });
    const session = new LobbyEntryFlowSession(
      { action: "join", code: "ABC234", username: "River Song" },
      { request, nextCommandId: () => "command-entry" },
    );

    await expect(session.run()).rejects.toMatchObject({
      ambiguous: true,
      retryable: true,
    } satisfies Partial<LobbyEntryFlowError>);
    await expect(session.run()).resolves.toMatchObject({ lobby: { code: "ABC234" } });
    expect(bodies.map((body) => body["commandId"])).toEqual(["command-entry", "command-entry"]);
  });

  it.each([null, "different-command"])(
    "treats a non-success response with command ID %s as ambiguous",
    async (commandId) => {
      const bodies: Array<Record<string, unknown>> = [];
      const request = vi
        .fn(async (_path: string, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return jsonResponse(contractError("UNAUTHORIZED", commandId), 401);
        })
        .mockResolvedValueOnce(jsonResponse(contractError("UNAUTHORIZED", commandId), 401))
        .mockResolvedValueOnce(jsonResponse(entryResponse, 201));
      const session = new LobbyEntryFlowSession(
        { action: "join", code: "ABC234", username: "River Song" },
        { request, nextCommandId: () => "command-entry" },
      );

      await expect(session.run()).rejects.toMatchObject({
        ambiguous: true,
        retryable: true,
      } satisfies Partial<LobbyEntryFlowError>);
      await expect(session.run()).resolves.toMatchObject({ commandId: "command-entry" });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves a correlated mutation error as definitive", async () => {
    const request = vi.fn(async () =>
      jsonResponse(contractError("UNAUTHORIZED", "command-entry"), 401),
    );
    const session = new LobbyEntryFlowSession(
      { action: "join", code: "ABC234", username: "River Song" },
      { request, nextCommandId: () => "command-entry" },
    );

    await expect(session.run()).rejects.toMatchObject({
      ambiguous: false,
      code: "UNAUTHORIZED",
      retryable: false,
    } satisfies Partial<LobbyEntryFlowError>);
    expect(request).toHaveBeenCalledOnce();
  });
});
