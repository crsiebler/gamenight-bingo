import { z } from "zod";

import {
  ActiveLobbyEventSequenceSchema,
  BallNumberSchema,
  CallIdSchema,
  CallPositionSchema,
  CardIdSchema,
  IsoTimestampSchema,
  LobbyCodeSchema,
  LobbyIdSchema,
  MarkIdSchema,
  ParticipantIdSchema,
  ParticipantSessionIdSchema,
  PatternIdSchema,
  PresenceGenerationSchema,
  RoundIdSchema,
  SchemaVersionSchema,
  ThemeIdSchema,
} from "./primitives.js";

export const AutomaticCallIntervalSchema = z.union([
  z.literal(5),
  z.literal(10),
  z.literal(30),
  z.literal(60),
  z.literal(120),
]);

export const CallConfigurationSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("manual") }),
  z.strictObject({
    mode: z.literal("automatic"),
    intervalSeconds: AutomaticCallIntervalSchema,
  }),
]);

const cardCellSchema = z.union([BallNumberSchema, z.literal("FREE")]);

export const CardCellsSchema = z
  .array(cardCellSchema)
  .length(25)
  .superRefine((cells, context) => {
    const valuesByColumn = Array.from({ length: 5 }, () => new Set<number>());

    cells.forEach((value, index) => {
      if (index === 12) {
        if (value !== "FREE") {
          context.addIssue({
            code: "custom",
            message: "The center cell must be FREE.",
            path: [index],
          });
        }
        return;
      }

      if (value === "FREE") {
        context.addIssue({
          code: "custom",
          message: "Only the center cell may be FREE.",
          path: [index],
        });
        return;
      }

      const column = index % 5;
      const minimum = column * 15 + 1;
      const maximum = minimum + 14;

      if (value < minimum || value > maximum) {
        context.addIssue({
          code: "custom",
          message: `Cell value must be between ${minimum} and ${maximum} for its column.`,
          path: [index],
        });
      }

      const columnValues = valuesByColumn[column];
      if (columnValues?.has(value)) {
        context.addIssue({
          code: "custom",
          message: "Card values must be unique within a column.",
          path: [index],
        });
      }
      columnValues?.add(value);
    });
  });

export const CardSchema = z.strictObject({
  id: CardIdSchema,
  roundId: RoundIdSchema,
  participantId: ParticipantIdSchema,
  cells: CardCellsSchema,
});

export const MarkSchema = z.strictObject({
  id: MarkIdSchema,
  cardId: CardIdSchema,
  ball: BallNumberSchema,
  markedAt: IsoTimestampSchema,
});

export const CallSchema = z.strictObject({
  id: CallIdSchema,
  roundId: RoundIdSchema,
  position: CallPositionSchema,
  ball: BallNumberSchema,
  calledAt: IsoTimestampSchema,
});

const presenceShape = {
  participantId: ParticipantIdSchema,
  generation: PresenceGenerationSchema,
  changedAt: IsoTimestampSchema,
};

export const PresenceSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...presenceShape, status: z.literal("connected") }),
  z.strictObject({
    ...presenceShape,
    status: z.literal("grace"),
    graceEndsAt: IsoTimestampSchema,
  }),
  z.strictObject({
    ...presenceShape,
    status: z.literal("absent"),
    absentSince: IsoTimestampSchema,
    overridden: z.boolean(),
  }),
  z.strictObject({
    ...presenceShape,
    status: z.literal("departed"),
    departedAt: IsoTimestampSchema,
  }),
]);

const sessionShape = {
  id: ParticipantSessionIdSchema,
  lobbyId: LobbyIdSchema,
  participantId: ParticipantIdSchema,
  issuedAt: IsoTimestampSchema,
};

export const ParticipantSessionSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...sessionShape, status: z.literal("active") }),
  z.strictObject({
    ...sessionShape,
    status: z.literal("disconnected"),
    disconnectedAt: IsoTimestampSchema,
    rejoinUntil: IsoTimestampSchema,
  }),
  z.strictObject({
    ...sessionShape,
    status: z.literal("departed"),
    departedAt: IsoTimestampSchema,
  }),
]);

export const ParticipantSummarySchema = z
  .strictObject({
    id: ParticipantIdSchema,
    username: z.string().min(1).max(128),
    role: z.enum(["host", "player"]),
    roundEligibility: z.enum(["playing", "waiting"]),
    presence: PresenceSchema,
  })
  .refine((participant) => participant.presence.participantId === participant.id, {
    message: "Presence must belong to its participant summary.",
    path: ["presence", "participantId"],
  });

export const CoWinnerWindowSchema = z
  .strictObject({
    triggeringCallId: CallIdSchema,
    openedAt: IsoTimestampSchema,
    closesAt: IsoTimestampSchema,
  })
  .refine((window) => Date.parse(window.openedAt) < Date.parse(window.closesAt), {
    message: "The co-winner window must close after it opens.",
    path: ["closesAt"],
  });

export const CoWinnerResultSchema = z
  .strictObject({
    triggeringCallId: CallIdSchema,
    openedAt: IsoTimestampSchema,
    closesAt: IsoTimestampSchema,
    settledAt: IsoTimestampSchema,
    winnerParticipantIds: z.array(ParticipantIdSchema).min(1).max(25),
  })
  .superRefine((result, context) => {
    if (Date.parse(result.openedAt) >= Date.parse(result.closesAt)) {
      context.addIssue({
        code: "custom",
        message: "The co-winner window must close after it opens.",
        path: ["closesAt"],
      });
    }
    if (Date.parse(result.settledAt) < Date.parse(result.closesAt)) {
      context.addIssue({
        code: "custom",
        message: "The co-winner result cannot settle before the window closes.",
        path: ["settledAt"],
      });
    }
    if (new Set(result.winnerParticipantIds).size !== result.winnerParticipantIds.length) {
      context.addIssue({
        code: "custom",
        message: "Co-winner participant IDs must be unique.",
        path: ["winnerParticipantIds"],
      });
    }
  });

export const TimerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("automatic-call"), deadline: IsoTimestampSchema }),
  z.strictObject({
    kind: z.literal("disconnect-grace"),
    participantId: ParticipantIdSchema,
    generation: PresenceGenerationSchema,
    deadline: IsoTimestampSchema,
  }),
  z.strictObject({
    kind: z.literal("co-winner"),
    triggeringCallId: CallIdSchema,
    deadline: IsoTimestampSchema,
  }),
]);

const lobbyShape = {
  id: LobbyIdSchema,
  code: LobbyCodeSchema,
  hostParticipantId: ParticipantIdSchema,
  themeId: ThemeIdSchema,
  createdAt: IsoTimestampSchema,
};

export const LobbyStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...lobbyShape, status: z.literal("waiting") }),
  z.strictObject({ ...lobbyShape, status: z.literal("active"), roundId: RoundIdSchema }),
  z.strictObject({ ...lobbyShape, status: z.literal("ended"), endedAt: IsoTimestampSchema }),
  z.strictObject({ ...lobbyShape, status: z.literal("expired"), expiredAt: IsoTimestampSchema }),
]);

const roundShape = {
  id: RoundIdSchema,
  lobbyId: LobbyIdSchema,
  patternId: PatternIdSchema,
  callConfiguration: CallConfigurationSchema,
};

const startedRoundShape = {
  ...roundShape,
  startedAt: IsoTimestampSchema,
};

export const PauseReasonSchema = z.enum(["host-command", "host-absent", "participant-absent"]);

export const WaitingRoundStateSchema = z.strictObject({
  ...roundShape,
  stage: z.literal("waiting"),
  createdAt: IsoTimestampSchema,
});
export const ActiveRoundStateSchema = z.strictObject({
  ...startedRoundShape,
  stage: z.literal("active"),
});
export const PausedRoundStateSchema = z.strictObject({
  ...startedRoundShape,
  stage: z.literal("paused"),
  pauseReason: PauseReasonSchema,
  pausedAt: IsoTimestampSchema,
});
export const CoWinnerRoundStateSchema = z.strictObject({
  ...startedRoundShape,
  stage: z.literal("co-winner-window"),
  window: CoWinnerWindowSchema,
});
export const ResultRoundStateSchema = z.strictObject({
  ...startedRoundShape,
  stage: z.literal("result"),
  result: CoWinnerResultSchema,
});
export const EndedRoundStateSchema = z.strictObject({
  ...startedRoundShape,
  stage: z.literal("ended"),
  endedAt: IsoTimestampSchema,
  result: CoWinnerResultSchema.nullable(),
});

export const RoundStateSchema = z.discriminatedUnion("stage", [
  WaitingRoundStateSchema,
  ActiveRoundStateSchema,
  PausedRoundStateSchema,
  CoWinnerRoundStateSchema,
  ResultRoundStateSchema,
  EndedRoundStateSchema,
]);

export const SnapshotSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    generatedAt: IsoTimestampSchema,
    lastEventSequence: ActiveLobbyEventSequenceSchema.nullable(),
    lobby: LobbyStateSchema,
    session: ParticipantSessionSchema,
    self: ParticipantSummarySchema,
    participants: z.array(ParticipantSummarySchema).max(26),
    round: RoundStateSchema.nullable(),
    ownCard: CardSchema.nullable(),
    ownMarks: z.array(MarkSchema).max(24),
    calls: z.array(CallSchema).max(75),
    timer: TimerSchema.nullable(),
  })
  .superRefine((snapshot, context) => {
    if (snapshot.session.lobbyId !== snapshot.lobby.id) {
      context.addIssue({
        code: "custom",
        message: "The session must belong to the snapshot lobby.",
        path: ["session", "lobbyId"],
      });
    }
    if (snapshot.session.participantId !== snapshot.self.id) {
      context.addIssue({
        code: "custom",
        message: "The session must belong to the snapshot participant.",
        path: ["session", "participantId"],
      });
    }

    const participantIds = new Set<string>();
    snapshot.participants.forEach((participant, index) => {
      if (participantIds.has(participant.id)) {
        context.addIssue({
          code: "custom",
          message: "Snapshot participants must be unique.",
          path: ["participants", index, "id"],
        });
      }
      participantIds.add(participant.id);
    });
    if (!participantIds.has(snapshot.self.id)) {
      context.addIssue({
        code: "custom",
        message: "The snapshot participant must appear in the participant list.",
        path: ["participants"],
      });
    } else {
      const rosterSelf = snapshot.participants.find(
        (participant) => participant.id === snapshot.self.id,
      );
      if (JSON.stringify(rosterSelf) !== JSON.stringify(snapshot.self)) {
        context.addIssue({
          code: "custom",
          message: "The self projection must match its participant list entry.",
          path: ["self"],
        });
      }
    }
    if (
      snapshot.participants.length === 26 &&
      (snapshot.lobby.status !== "active" ||
        snapshot.round === null ||
        snapshot.self.roundEligibility !== "waiting" ||
        snapshot.participants.filter((participant) => participant.roundEligibility === "playing")
          .length !== 25)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A 26-participant snapshot requires one waiting self projection and 25 current-round participants.",
        path: ["participants"],
      });
    }

    const hosts = snapshot.participants.filter((participant) => participant.role === "host");
    if (hosts.length !== 1 || hosts[0]?.id !== snapshot.lobby.hostParticipantId) {
      context.addIssue({
        code: "custom",
        message: "The designated lobby host must be the only host in the participant list.",
        path: ["lobby", "hostParticipantId"],
      });
    }
    if (snapshot.timer?.kind === "disconnect-grace") {
      const timer = snapshot.timer;
      const timerParticipant = snapshot.participants.find(
        (participant) => participant.id === timer.participantId,
      );
      if (
        timerParticipant?.presence.status !== "grace" ||
        timerParticipant.presence.generation !== timer.generation ||
        timerParticipant.presence.graceEndsAt !== timer.deadline
      ) {
        context.addIssue({
          code: "custom",
          message: "A disconnect timer must match the participant grace state.",
          path: ["timer"],
        });
      }
    }
    if (
      snapshot.timer?.kind === "automatic-call" &&
      (snapshot.round?.stage !== "active" || snapshot.round.callConfiguration.mode !== "automatic")
    ) {
      context.addIssue({
        code: "custom",
        message: "An automatic-call timer requires an active automatic round.",
        path: ["timer"],
      });
    }
    if (snapshot.round?.stage === "co-winner-window") {
      if (
        snapshot.timer?.kind !== "co-winner" ||
        snapshot.timer.triggeringCallId !== snapshot.round.window.triggeringCallId ||
        snapshot.timer.deadline !== snapshot.round.window.closesAt
      ) {
        context.addIssue({
          code: "custom",
          message: "The co-winner timer must match the current round window.",
          path: ["timer"],
        });
      }
    } else if (snapshot.timer?.kind === "co-winner") {
      context.addIssue({
        code: "custom",
        message: "A co-winner timer requires a co-winner round window.",
        path: ["timer"],
      });
    }

    if (snapshot.round !== null && snapshot.round.lobbyId !== snapshot.lobby.id) {
      context.addIssue({
        code: "custom",
        message: "The current round must belong to the snapshot lobby.",
        path: ["round", "lobbyId"],
      });
    }
    if (snapshot.lobby.status === "active") {
      if (snapshot.round === null) {
        context.addIssue({
          code: "custom",
          message: "An active lobby requires its current round.",
          path: ["round"],
        });
      } else if (snapshot.round.id !== snapshot.lobby.roundId) {
        context.addIssue({
          code: "custom",
          message: "The current round must match the active lobby round.",
          path: ["round", "id"],
        });
      }
    }
    if (snapshot.lobby.status === "expired") {
      context.addIssue({
        code: "custom",
        message: "Expired lobbies cannot be represented by an authorized snapshot.",
        path: ["lobby", "status"],
      });
    }

    if (snapshot.round === null) {
      if (snapshot.ownCard !== null || snapshot.ownMarks.length > 0 || snapshot.calls.length > 0) {
        context.addIssue({
          code: "custom",
          message: "Round data requires a current round.",
          path: ["round"],
        });
      }
      return;
    }

    if (
      snapshot.self.roundEligibility === "waiting" &&
      (snapshot.ownCard !== null || snapshot.ownMarks.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "A waiting participant cannot have current-round card data.",
        path: ["ownCard"],
      });
    }
    if (snapshot.self.roundEligibility === "playing" && snapshot.ownCard === null) {
      context.addIssue({
        code: "custom",
        message: "A playing participant requires a current-round card.",
        path: ["ownCard"],
      });
    }

    if (snapshot.ownCard === null && snapshot.ownMarks.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Marks require an own card.",
        path: ["ownMarks"],
      });
    }
    if (snapshot.ownCard !== null) {
      if (snapshot.ownCard.roundId !== snapshot.round.id) {
        context.addIssue({
          code: "custom",
          message: "The own card must belong to the current round.",
          path: ["ownCard", "roundId"],
        });
      }
      if (snapshot.ownCard.participantId !== snapshot.self.id) {
        context.addIssue({
          code: "custom",
          message: "The own card must belong to the snapshot participant.",
          path: ["ownCard", "participantId"],
        });
      }
      const markedIds = new Set<string>();
      const markedBalls = new Set<number>();
      const cardBalls = new Set(snapshot.ownCard.cells.filter((cell) => cell !== "FREE"));
      const calledBalls = new Set(snapshot.calls.map((call) => call.ball));
      snapshot.ownMarks.forEach((mark, index) => {
        if (mark.cardId !== snapshot.ownCard?.id) {
          context.addIssue({
            code: "custom",
            message: "Marks must belong to the own card.",
            path: ["ownMarks", index, "cardId"],
          });
        }
        if (markedIds.has(mark.id) || markedBalls.has(mark.ball)) {
          context.addIssue({
            code: "custom",
            message: "Marks must have unique IDs and balls.",
            path: ["ownMarks", index],
          });
        }
        if (!cardBalls.has(mark.ball)) {
          context.addIssue({
            code: "custom",
            message: "A mark must identify a ball on the own card.",
            path: ["ownMarks", index, "ball"],
          });
        }
        if (!calledBalls.has(mark.ball)) {
          context.addIssue({
            code: "custom",
            message: "A mark must identify a called ball.",
            path: ["ownMarks", index, "ball"],
          });
        }
        markedIds.add(mark.id);
        markedBalls.add(mark.ball);
      });
    }
    const callIds = new Set<string>();
    const calledBalls = new Set<number>();
    snapshot.calls.forEach((call, index) => {
      if (call.roundId !== snapshot.round?.id) {
        context.addIssue({
          code: "custom",
          message: "Calls must belong to the current round.",
          path: ["calls", index, "roundId"],
        });
      }
      if (call.position !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Calls must have contiguous positions in chronological order.",
          path: ["calls", index, "position"],
        });
      }
      if (callIds.has(call.id)) {
        context.addIssue({
          code: "custom",
          message: "Call IDs must be unique.",
          path: ["calls", index, "id"],
        });
      }
      if (calledBalls.has(call.ball)) {
        context.addIssue({
          code: "custom",
          message: "Called balls must be unique.",
          path: ["calls", index, "ball"],
        });
      }
      callIds.add(call.id);
      calledBalls.add(call.ball);
    });
    const latestCall = snapshot.calls[snapshot.calls.length - 1];
    if (
      snapshot.round.stage === "co-winner-window" &&
      snapshot.round.window.triggeringCallId !== latestCall?.id
    ) {
      context.addIssue({
        code: "custom",
        message: "The co-winner window must reference the latest call.",
        path: ["round", "window", "triggeringCallId"],
      });
    }
    if ("result" in snapshot.round && snapshot.round.result !== null) {
      if (snapshot.round.result.triggeringCallId !== latestCall?.id) {
        context.addIssue({
          code: "custom",
          message: "The co-winner result must reference the latest call.",
          path: ["round", "result", "triggeringCallId"],
        });
      }
      snapshot.round.result.winnerParticipantIds.forEach((participantId, index) => {
        const winner = snapshot.participants.find(
          (participant) => participant.id === participantId,
        );
        if (winner?.roundEligibility !== "playing") {
          context.addIssue({
            code: "custom",
            message: "Winners must be playing participants in the current round.",
            path: ["round", "result", "winnerParticipantIds", index],
          });
        }
      });
    }
  });

export type AutomaticCallInterval = z.infer<typeof AutomaticCallIntervalSchema>;
export type CallConfiguration = z.infer<typeof CallConfigurationSchema>;
export type CardCells = z.infer<typeof CardCellsSchema>;
export type Card = z.infer<typeof CardSchema>;
export type Mark = z.infer<typeof MarkSchema>;
export type Call = z.infer<typeof CallSchema>;
export type Presence = z.infer<typeof PresenceSchema>;
export type ParticipantSession = z.infer<typeof ParticipantSessionSchema>;
export type ParticipantSummary = z.infer<typeof ParticipantSummarySchema>;
export type CoWinnerWindow = z.infer<typeof CoWinnerWindowSchema>;
export type CoWinnerResult = z.infer<typeof CoWinnerResultSchema>;
export type Timer = z.infer<typeof TimerSchema>;
export type LobbyState = z.infer<typeof LobbyStateSchema>;
export type PauseReason = z.infer<typeof PauseReasonSchema>;
export type WaitingRoundState = z.infer<typeof WaitingRoundStateSchema>;
export type ActiveRoundState = z.infer<typeof ActiveRoundStateSchema>;
export type PausedRoundState = z.infer<typeof PausedRoundStateSchema>;
export type CoWinnerRoundState = z.infer<typeof CoWinnerRoundStateSchema>;
export type ResultRoundState = z.infer<typeof ResultRoundStateSchema>;
export type EndedRoundState = z.infer<typeof EndedRoundStateSchema>;
export type RoundState = z.infer<typeof RoundStateSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
