import { z } from "zod";

import {
  ActiveLobbyEventSequenceSchema,
  BallNumberSchema,
  CommandIdSchema,
  ParticipantIdSchema,
  PatternIdSchema,
  PresenceGenerationSchema,
  SchemaVersionSchema,
} from "./primitives.js";
import { CallConfigurationSchema } from "./game-state.js";

const mutationShape = {
  schemaVersion: SchemaVersionSchema,
  commandId: CommandIdSchema,
};

export const ConfigureCommandSchema = z.strictObject({
  ...mutationShape,
  type: z.literal("configure"),
  patternId: PatternIdSchema,
  callConfiguration: CallConfigurationSchema,
});

const controlCommand = <Type extends string>(type: Type) =>
  z.strictObject({ ...mutationShape, type: z.literal(type) });

export const StartRoundCommandSchema = controlCommand("start-round");
export const CreateRoundCommandSchema = controlCommand("create-round");
export const PauseRoundCommandSchema = controlCommand("pause-round");
export const ResumeRoundCommandSchema = controlCommand("resume-round");
export const CallNextCommandSchema = controlCommand("call-next");
export const EndRoundCommandSchema = controlCommand("end-round");

export const ContinueRoundCommandSchema = z.strictObject({
  ...mutationShape,
  type: z.literal("continue-round"),
  patternId: PatternIdSchema,
});

export const MarkCardCommandSchema = z.strictObject({
  ...mutationShape,
  type: z.literal("mark-card"),
  ball: BallNumberSchema,
});

export const OverrideAbsenceCommandSchema = z.strictObject({
  ...mutationShape,
  type: z.literal("override-absence"),
  participantId: ParticipantIdSchema,
  presenceGeneration: PresenceGenerationSchema,
});

export const MutationCommandSchema = z.discriminatedUnion("type", [
  ConfigureCommandSchema,
  CreateRoundCommandSchema,
  StartRoundCommandSchema,
  PauseRoundCommandSchema,
  ResumeRoundCommandSchema,
  CallNextCommandSchema,
  ContinueRoundCommandSchema,
  EndRoundCommandSchema,
  MarkCardCommandSchema,
  OverrideAbsenceCommandSchema,
]);

export const HeartbeatCommandSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("heartbeat"),
});

export const ResyncCommandSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("resync"),
  lastEventSequence: ActiveLobbyEventSequenceSchema.nullable(),
});

export const RealtimeCommandSchema = z.union([
  MutationCommandSchema,
  HeartbeatCommandSchema,
  ResyncCommandSchema,
]);

export type ConfigureCommand = z.infer<typeof ConfigureCommandSchema>;
export type CreateRoundCommand = z.infer<typeof CreateRoundCommandSchema>;
export type StartRoundCommand = z.infer<typeof StartRoundCommandSchema>;
export type PauseRoundCommand = z.infer<typeof PauseRoundCommandSchema>;
export type ResumeRoundCommand = z.infer<typeof ResumeRoundCommandSchema>;
export type CallNextCommand = z.infer<typeof CallNextCommandSchema>;
export type ContinueRoundCommand = z.infer<typeof ContinueRoundCommandSchema>;
export type EndRoundCommand = z.infer<typeof EndRoundCommandSchema>;
export type MarkCardCommand = z.infer<typeof MarkCardCommandSchema>;
export type OverrideAbsenceCommand = z.infer<typeof OverrideAbsenceCommandSchema>;
export type MutationCommand = z.infer<typeof MutationCommandSchema>;
export type HeartbeatCommand = z.infer<typeof HeartbeatCommandSchema>;
export type ResyncCommand = z.infer<typeof ResyncCommandSchema>;
export type RealtimeCommand = z.infer<typeof RealtimeCommandSchema>;
