import { z } from "zod";

export const CONTRACT_SCHEMA_VERSION = 1 as const;
export const SchemaVersionSchema = z.literal(CONTRACT_SCHEMA_VERSION);

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const opaqueId = () => z.string().regex(OPAQUE_ID_PATTERN);

export const LobbyIdSchema = opaqueId().brand<"LobbyId">();
export const RoundIdSchema = opaqueId().brand<"RoundId">();
export const ParticipantIdSchema = opaqueId().brand<"ParticipantId">();
export const ParticipantSessionIdSchema = opaqueId().brand<"ParticipantSessionId">();
export const CardIdSchema = opaqueId().brand<"CardId">();
export const MarkIdSchema = opaqueId().brand<"MarkId">();
export const CallIdSchema = opaqueId().brand<"CallId">();
export const PatternIdSchema = opaqueId().brand<"PatternId">();
export const ThemeIdSchema = opaqueId().brand<"ThemeId">();
export const CommandIdSchema = opaqueId().brand<"CommandId">();

export const LobbyCodeSchema = z
  .string()
  .regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
  .brand<"LobbyCode">();

export const IsoTimestampSchema = z.iso.datetime({ precision: 3 }).brand<"IsoTimestamp">();

const positiveSafeInteger = () => z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const ActiveLobbyEventSequenceSchema =
  positiveSafeInteger().brand<"ActiveLobbyEventSequence">();
export const PresenceGenerationSchema = positiveSafeInteger().brand<"PresenceGeneration">();
export const CallPositionSchema = z.number().int().min(1).max(75).brand<"CallPosition">();
export const BallNumberSchema = z.number().int().min(1).max(75).brand<"BallNumber">();

export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;
export type LobbyId = z.infer<typeof LobbyIdSchema>;
export type RoundId = z.infer<typeof RoundIdSchema>;
export type ParticipantId = z.infer<typeof ParticipantIdSchema>;
export type ParticipantSessionId = z.infer<typeof ParticipantSessionIdSchema>;
export type CardId = z.infer<typeof CardIdSchema>;
export type MarkId = z.infer<typeof MarkIdSchema>;
export type CallId = z.infer<typeof CallIdSchema>;
export type PatternId = z.infer<typeof PatternIdSchema>;
export type ThemeId = z.infer<typeof ThemeIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type LobbyCode = z.infer<typeof LobbyCodeSchema>;
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;
export type ActiveLobbyEventSequence = z.infer<typeof ActiveLobbyEventSequenceSchema>;
export type PresenceGeneration = z.infer<typeof PresenceGenerationSchema>;
export type CallPosition = z.infer<typeof CallPositionSchema>;
export type BallNumber = z.infer<typeof BallNumberSchema>;
