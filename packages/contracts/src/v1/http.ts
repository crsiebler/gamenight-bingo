import { z } from "zod";

import {
  CommandIdSchema,
  IsoTimestampSchema,
  LobbyCodeSchema,
  LobbyIdSchema,
  ParticipantIdSchema,
  ParticipantSessionIdSchema,
  PatternIdSchema,
  RealtimeTicketSchema,
  SchemaVersionSchema,
  ThemeIdSchema,
} from "./primitives.js";

const usernameSchema = z.string().min(1).max(128);

export const CreateLobbyRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  commandId: CommandIdSchema,
  username: usernameSchema,
  themeId: ThemeIdSchema,
});

export const JoinLobbyRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  commandId: CommandIdSchema,
  username: usernameSchema,
});

export const RejoinLobbyRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  commandId: CommandIdSchema,
});

export const RealtimeTicketRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
});

export const RealtimeTicketResponseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("realtime-ticket"),
  ticket: RealtimeTicketSchema,
  expiresAt: IsoTimestampSchema,
});

const lobbyEntryParticipantSchema = z.strictObject({
  id: ParticipantIdSchema,
  username: usernameSchema,
  role: z.enum(["host", "player"]),
  roundEligibility: z.enum(["playing", "waiting"]),
});

export const LobbyEntryResponseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("lobby-entry"),
  commandId: CommandIdSchema,
  idempotentReplay: z.boolean(),
  lobby: z.strictObject({
    id: LobbyIdSchema,
    code: LobbyCodeSchema,
    themeId: ThemeIdSchema,
  }),
  participant: lobbyEntryParticipantSchema,
  session: z.strictObject({
    id: ParticipantSessionIdSchema,
    status: z.literal("active"),
    issuedAt: IsoTimestampSchema,
  }),
});

const sessionStatusShape = {
  schemaVersion: SchemaVersionSchema,
  type: z.literal("same-device-session-status"),
};

export const SameDeviceSessionStatusResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...sessionStatusShape,
    status: z.literal("new-participant-required"),
  }),
  z.strictObject({
    ...sessionStatusShape,
    status: z.literal("active"),
    username: usernameSchema,
    role: z.enum(["host", "player"]),
  }),
  z.strictObject({
    ...sessionStatusShape,
    status: z.literal("rejoin-available"),
    username: usernameSchema,
    rejoinUntil: IsoTimestampSchema,
  }),
]);

const patternMaskSchema = z.string().regex(/^[#.]{5}(?:\/[#.]{5}){4}$/);
const patternSourceExampleSchema = z.strictObject({
  reference: z.string().regex(/^p[1-9]\d*\/d0*[1-9]\d*$/),
  classification: z.literal("flexible-rule-example"),
  mask: patternMaskSchema,
});

export const PatternCatalogEntrySchema = z.strictObject({
  id: PatternIdSchema,
  name: z.string().min(1).max(128),
  category: z.enum(["standard", "shape", "letter", "number", "christmas"]),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(["exact", "one-line", "two-lines", "blackout"]),
  source: z.strictObject({
    file: z
      .enum([
        "shapes-bingo-patterns.pdf",
        "letter-bingo-patterns.pdf",
        "number-bingo-patterns.pdf",
        "christmas-bingo-patterns.pdf",
      ])
      .nullable(),
    references: z.array(z.string().regex(/^p[1-9]\d*\/d0*[1-9]\d*$/)).max(2),
    alias: z.string().min(1).max(128).nullable(),
    examples: z.array(patternSourceExampleSchema).max(2).optional(),
  }),
  masks: z.array(patternMaskSchema).min(1).max(66),
});

export const PatternCatalogResponseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("pattern-catalog"),
  patterns: z.array(PatternCatalogEntrySchema).min(1),
});

export type CreateLobbyRequest = z.infer<typeof CreateLobbyRequestSchema>;
export type JoinLobbyRequest = z.infer<typeof JoinLobbyRequestSchema>;
export type RejoinLobbyRequest = z.infer<typeof RejoinLobbyRequestSchema>;
export type RealtimeTicketRequest = z.infer<typeof RealtimeTicketRequestSchema>;
export type RealtimeTicketResponse = z.infer<typeof RealtimeTicketResponseSchema>;
export type LobbyEntryResponse = z.infer<typeof LobbyEntryResponseSchema>;
export type SameDeviceSessionStatusResponse = z.infer<typeof SameDeviceSessionStatusResponseSchema>;
export type PatternCatalogEntry = z.infer<typeof PatternCatalogEntrySchema>;
export type PatternCatalogResponse = z.infer<typeof PatternCatalogResponseSchema>;
