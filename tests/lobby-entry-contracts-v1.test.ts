import { describe, expect, test } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  CreateLobbyRequestSchema,
  JoinLobbyRequestSchema,
  LobbyEntryResponseSchema,
  PatternCatalogResponseSchema,
  RealtimeTicketRequestSchema,
  RealtimeTicketResponseSchema,
  RejoinLobbyRequestSchema,
  SameDeviceSessionStatusResponseSchema,
} from "../packages/contracts/src/index.js";

const entry = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  type: "lobby-entry",
  commandId: "command-entry",
  idempotentReplay: false,
  lobby: {
    id: "lobby-1",
    code: "ABC234",
    themeId: "classic",
  },
  participant: {
    id: "participant-1",
    username: "Host Player",
    role: "host",
    roundEligibility: "playing",
  },
  session: {
    id: "session-1",
    status: "active",
    issuedAt: "2026-07-17T12:00:00.000Z",
  },
} as const;

describe("v1 lobby entry HTTP contracts", () => {
  test("accepts intent-only create, join, and rejoin requests", () => {
    expect(
      CreateLobbyRequestSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        commandId: "command-create",
        username: "Host Player",
        themeId: "classic",
      }),
    ).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      commandId: "command-create",
      username: "Host Player",
      themeId: "classic",
    });
    expect(
      JoinLobbyRequestSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        commandId: "command-join",
        username: "Guest Player",
      }),
    ).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      commandId: "command-join",
      username: "Guest Player",
    });
    expect(
      RejoinLobbyRequestSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        commandId: "command-rejoin",
      }),
    ).toEqual({ schemaVersion: CONTRACT_SCHEMA_VERSION, commandId: "command-rejoin" });
  });

  test.each([
    ["create", CreateLobbyRequestSchema, { role: "host" }],
    ["join", JoinLobbyRequestSchema, { participantId: "participant-1" }],
    ["rejoin", RejoinLobbyRequestSchema, { sessionId: "session-1" }],
  ])("rejects authoritative or unknown %s fields", (_, schema, extra) => {
    const base = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      commandId: "command-1",
    };
    const payload =
      schema === CreateLobbyRequestSchema
        ? { ...base, username: "Host", themeId: "classic", ...extra }
        : schema === JoinLobbyRequestSchema
          ? { ...base, username: "Player", ...extra }
          : { ...base, ...extra };

    expect(schema.safeParse(payload).success).toBe(false);
  });

  test("returns an entry projection without a credential", () => {
    expect(LobbyEntryResponseSchema.parse(entry)).toEqual(entry);
    expect(
      LobbyEntryResponseSchema.safeParse({
        ...entry,
        session: { ...entry.session, token: "secret" },
      }).success,
    ).toBe(false);
    expect(LobbyEntryResponseSchema.parse({ ...entry, idempotentReplay: true })).toMatchObject({
      commandId: "command-entry",
      idempotentReplay: true,
    });
  });

  test("accepts intent-only realtime ticket issuance and returns one opaque credential", () => {
    expect(RealtimeTicketRequestSchema.parse({ schemaVersion: CONTRACT_SCHEMA_VERSION })).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
    });
    expect(
      RealtimeTicketRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        participantId: "participant-1",
      }).success,
    ).toBe(false);

    const response = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "realtime-ticket",
      ticket: "A".repeat(43),
      expiresAt: "2026-07-17T12:01:00.000Z",
    } as const;
    expect(RealtimeTicketResponseSchema.parse(response)).toEqual(response);
    for (const ticket of [
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      "A".repeat(42) + "+",
      "A".repeat(42) + "B",
    ]) {
      expect(RealtimeTicketResponseSchema.safeParse({ ...response, ticket }).success).toBe(false);
    }
    expect(
      RealtimeTicketResponseSchema.safeParse({ ...response, participantId: "participant-1" })
        .success,
    ).toBe(false);
  });

  test("exposes identity only for a recognized scoped session", () => {
    expect(
      SameDeviceSessionStatusResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "same-device-session-status",
        status: "new-participant-required",
      }),
    ).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "same-device-session-status",
      status: "new-participant-required",
    });
    expect(
      SameDeviceSessionStatusResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "same-device-session-status",
        status: "rejoin-available",
        username: "Prior Player",
        rejoinUntil: "2026-07-17T12:02:00.000Z",
      }),
    ).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "same-device-session-status",
      status: "rejoin-available",
      username: "Prior Player",
      rejoinUntil: "2026-07-17T12:02:00.000Z",
    });
  });

  test("represents only public pattern catalog data", () => {
    const response = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "pattern-catalog",
      patterns: [
        {
          id: "standard-one-line",
          name: "One Line",
          category: "standard",
          version: 1,
          mode: "one-line",
          masks: ["#####/...../...../...../....."],
          source: {
            file: null,
            references: [],
            alias: null,
          },
        },
      ],
    } as const;

    expect(PatternCatalogResponseSchema.parse(response)).toEqual(response);
    expect(
      PatternCatalogResponseSchema.safeParse({
        ...response,
        patterns: [{ ...response.patterns[0], futureDrawOrder: [1, 2, 3] }],
      }).success,
    ).toBe(false);
  });
});
