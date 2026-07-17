import { z } from "zod";

import {
  ActiveLobbyEventSequenceSchema,
  BallNumberSchema,
  CommandIdSchema,
  IsoTimestampSchema,
  SchemaVersionSchema,
} from "./primitives.js";
import {
  CallSchema,
  CoWinnerResultSchema,
  CoWinnerWindowSchema,
  EndedRoundStateSchema,
  MarkSchema,
  PresenceSchema,
  RoundStateSchema,
  SnapshotSchema,
} from "./game-state.js";

const eventShape = {
  schemaVersion: SchemaVersionSchema,
  eventSequence: ActiveLobbyEventSequenceSchema,
  occurredAt: IsoTimestampSchema,
};

const privateEventShape = {
  schemaVersion: SchemaVersionSchema,
  occurredAt: IsoTimestampSchema,
};

export const ActiveLobbyEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventShape, type: z.literal("presence"), presence: PresenceSchema }),
  z.strictObject({ ...eventShape, type: z.literal("call"), call: CallSchema }),
  z.strictObject({
    ...eventShape,
    type: z.literal("co-winner-window"),
    window: CoWinnerWindowSchema,
  }),
  z.strictObject({
    ...eventShape,
    type: z.literal("co-winner-result"),
    result: CoWinnerResultSchema,
  }),
  z.strictObject({ ...eventShape, type: z.literal("stage"), round: RoundStateSchema }),
  z.strictObject({ ...eventShape, type: z.literal("round-end"), round: EndedRoundStateSchema }),
]);

export const ParticipantPrivateEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...privateEventShape,
    type: z.literal("mark-result"),
    commandId: CommandIdSchema,
    mark: MarkSchema,
  }),
  z.strictObject({
    ...privateEventShape,
    type: z.literal("near-win"),
    requiredBall: BallNumberSchema,
  }),
]);

export const SnapshotMessageSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("snapshot"),
  snapshot: SnapshotSchema,
});

const commandAckShape = {
  schemaVersion: SchemaVersionSchema,
  type: z.literal("ack"),
  commandId: CommandIdSchema,
  occurredAt: IsoTimestampSchema,
  idempotentReplay: z.boolean(),
};

export const CommandAckSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    ...commandAckShape,
    scope: z.literal("active-lobby"),
    eventSequence: ActiveLobbyEventSequenceSchema,
  }),
  z.strictObject({
    ...commandAckShape,
    scope: z.literal("participant-private"),
    eventSequence: z.null(),
  }),
]);

export const ErrorIssueCodeSchema = z.enum([
  "required",
  "invalid_type",
  "invalid_value",
  "unknown_field",
  "out_of_range",
]);
export const SafeErrorIssueMessageSchema = z.enum([
  "Required.",
  "Invalid value type.",
  "Invalid value.",
  "Unknown field.",
  "Value is out of range.",
  "Unsupported command.",
]);
export const ErrorIssuePathSchema = z.enum([
  "schemaVersion",
  "type",
  "commandId",
  "patternId",
  "callConfiguration",
  "callConfiguration.mode",
  "callConfiguration.intervalSeconds",
  "ball",
  "participantId",
  "presenceGeneration",
  "lastEventSequence",
]);
const issueMessagesByCode = {
  required: ["Required."],
  invalid_type: ["Invalid value type."],
  invalid_value: ["Invalid value.", "Unsupported command."],
  unknown_field: ["Unknown field."],
  out_of_range: ["Value is out of range."],
} as const satisfies Record<
  z.infer<typeof ErrorIssueCodeSchema>,
  readonly z.infer<typeof SafeErrorIssueMessageSchema>[]
>;
export const ErrorIssueSchema = z
  .strictObject({
    path: ErrorIssuePathSchema,
    code: ErrorIssueCodeSchema,
    message: SafeErrorIssueMessageSchema,
  })
  .refine((issue) => issueMessagesByCode[issue.code].includes(issue.message as never), {
    message: "The validation issue message must match its code.",
    path: ["message"],
  });

export const ErrorCodeSchema = z.enum([
  "INVALID_PAYLOAD",
  "INVALID_COMMAND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "LOBBY_FULL",
  "LOBBY_EXPIRED",
  "USERNAME_TAKEN",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);
export const SafeErrorMessageSchema = z.enum([
  "The request payload is invalid.",
  "The command is not valid in the current state.",
  "Authentication is required.",
  "You are not allowed to perform this action.",
  "The requested resource was not found.",
  "The lobby is full.",
  "The lobby has expired.",
  "That username is already in use.",
  "Too many requests. Try again later.",
  "An unexpected error occurred.",
]);

const errorMessageByCode = {
  INVALID_PAYLOAD: "The request payload is invalid.",
  INVALID_COMMAND: "The command is not valid in the current state.",
  UNAUTHORIZED: "Authentication is required.",
  FORBIDDEN: "You are not allowed to perform this action.",
  NOT_FOUND: "The requested resource was not found.",
  LOBBY_FULL: "The lobby is full.",
  LOBBY_EXPIRED: "The lobby has expired.",
  USERNAME_TAKEN: "That username is already in use.",
  RATE_LIMITED: "Too many requests. Try again later.",
  INTERNAL_ERROR: "An unexpected error occurred.",
} as const satisfies Record<
  z.infer<typeof ErrorCodeSchema>,
  z.infer<typeof SafeErrorMessageSchema>
>;

export const ErrorSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: SafeErrorMessageSchema,
    commandId: CommandIdSchema.nullable(),
    occurredAt: IsoTimestampSchema,
    retryable: z.boolean(),
    issues: z.array(ErrorIssueSchema).max(25),
  })
  .refine((error) => error.message === errorMessageByCode[error.code], {
    message: "The public error message must match its code.",
    path: ["message"],
  });

export type ActiveLobbyEvent = z.infer<typeof ActiveLobbyEventSchema>;
export type ParticipantPrivateEvent = z.infer<typeof ParticipantPrivateEventSchema>;
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;
export type CommandAck = z.infer<typeof CommandAckSchema>;
export type ErrorIssue = z.infer<typeof ErrorIssueSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ContractError = z.infer<typeof ErrorSchema>;
