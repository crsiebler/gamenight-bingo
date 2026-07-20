import { createHash, timingSafeEqual } from "node:crypto";

import {
  ActiveLobbyEventSchema,
  CONTRACT_SCHEMA_VERSION,
  ParticipantPrivateEventSchema,
  RoundStateSchema,
  type ActiveLobbyEvent,
  type MutationCommand,
  type ParticipantPrivateEvent,
} from "@gamenight-bingo/contracts";
import {
  FREE_BINGO_CELL,
  commitNextDrawPosition,
  createWaitingRound,
  generateBingoCards,
  generateDrawOrder,
  transitionRound,
  type CryptographicRandomBytes,
  type RoundPatternMode,
  type RoundState,
} from "@gamenight-bingo/domain";
import {
  PatternCardStateSchema,
  PatternDefinitionSchema,
  calculatePatternProgress,
  type PatternCardState,
  type PatternDefinition,
} from "@gamenight-bingo/patterns";

import {
  Prisma,
  type ParticipantRole as DatabaseParticipantRole,
  type PrismaClient as GeneratedPrismaClient,
  type RoundStage as DatabaseRoundStage,
} from "../generated/prisma/client.js";
import {
  ACTIVE_LOBBY_EVENT_CHANNEL,
  encodeActiveLobbyEventReference,
} from "./active-lobby-events.js";
import { expireDueParticipantSessions } from "./participant-session-expiry.js";
import { runTransactionWithRetry, type TransactionRetryOptions } from "./transaction-retry.js";

export type RoundCommandPattern = PatternDefinition;
type RoundCommandPatternReference = Pick<RoundCommandPattern, "id" | "mode">;

export interface RoundCommandRuntimeOptions {
  readonly patterns: readonly RoundCommandPattern[];
  readonly nearWinFeedbackEnabled: boolean;
  readonly coWinnerWindowMs: number;
  readonly randomBytes: CryptographicRandomBytes;
  readonly nextId: (prefix: "round" | "card" | "call" | "mark") => string;
  readonly clock: () => Date;
}

export interface RoundCommandAcknowledgement {
  readonly commandId: string;
  readonly scope: "active-lobby" | "participant-private";
  readonly eventSequence: number | null;
  readonly occurredAt: Date;
  readonly idempotentReplay: boolean;
}

export interface AutomaticCallLease {
  readonly lobbyId: string;
  readonly roundId: string;
  readonly deadline: Date;
}

export type AutomaticCallExecutionResult =
  "called" | "stale" | "too-early" | "blocked" | "exhausted";

export interface CoWinnerSettlementLease {
  readonly lobbyId: string;
  readonly roundId: string;
  readonly triggeringCallId: string;
  readonly deadline: Date;
}

export type CoWinnerSettlementExecutionResult = "settled" | "stale" | "too-early";

export type RoundCommandExecutionResult =
  | {
      readonly ok: true;
      readonly acknowledgement: RoundCommandAcknowledgement;
      readonly activeLobbyEvent: ActiveLobbyEvent | null;
      readonly participantPrivateEvents: readonly ParticipantPrivateEvent[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_COMMAND" | "NOT_FOUND";
      };
    };

export interface RoundCommandExecutor {
  execute(input: {
    readonly lobbyId: string;
    readonly sessionTokenHash: Uint8Array;
    readonly command: MutationCommand;
  }): Promise<RoundCommandExecutionResult>;
  executeAuthenticated(input: {
    readonly lobbyId: string;
    readonly participantId: string;
    readonly participantSessionId: string;
    readonly command: MutationCommand;
  }): Promise<RoundCommandExecutionResult>;
  findAutomaticCallLeases(maximum?: number): Promise<readonly AutomaticCallLease[]>;
  findAutomaticCallLease(lobbyId: string): Promise<AutomaticCallLease | null>;
  executeAutomaticCall(lease: AutomaticCallLease): Promise<AutomaticCallExecutionResult>;
  findCoWinnerSettlementLeases(maximum?: number): Promise<readonly CoWinnerSettlementLease[]>;
  findCoWinnerSettlementLease(lobbyId: string): Promise<CoWinnerSettlementLease | null>;
  executeCoWinnerSettlement(
    lease: CoWinnerSettlementLease,
  ): Promise<CoWinnerSettlementExecutionResult>;
}

type PendingCommand =
  | {
      readonly roundId: string | null;
      readonly scope: "active-lobby";
      readonly event: {
        readonly type: "presence" | "stage" | "call" | "co-winner-window" | "round-end";
        readonly payload: Prisma.InputJsonObject;
      };
      readonly progress?: ParticipantPrivateProgress;
      readonly events?: readonly ParticipantPrivateEvent[];
    }
  | {
      readonly roundId: string;
      readonly scope: "participant-private";
      readonly progress: ParticipantPrivateProgress;
      readonly events: readonly ParticipantPrivateEvent[];
    };

interface CurrentRound {
  readonly id: string;
  readonly initialPatternId: string;
  readonly currentPatternId: string;
  readonly stage: DatabaseRoundStage;
  readonly callMode: "MANUAL" | "AUTOMATIC";
  readonly callIntervalSeconds: number | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly activeAt: Date | null;
  readonly pausedAt: Date | null;
  readonly pauseReason: "HOST_COMMAND" | "HOST_ABSENT" | "PARTICIPANT_ABSENT" | null;
  readonly nextCallAt: Date | null;
  readonly resultSettledAt: Date | null;
  readonly endedAt: Date | null;
  readonly coWinnerOpenedAt: Date | null;
  readonly coWinnerClosesAt: Date | null;
  readonly coWinnerTriggeringCallId: string | null;
}

const invalidCommand = (): RoundCommandExecutionResult => ({
  ok: false,
  error: { code: "INVALID_COMMAND" },
});

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${name} must be a valid date.`);
  }
}

function toSafeSequence(sequence: bigint | null): number | null {
  if (sequence === null) return null;
  const value = Number(sequence);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Active lobby event sequences must be positive safe integers.");
  }
  return value;
}

function roleFromDatabase(role: DatabaseParticipantRole): "host" | "player" {
  return role === "HOST" ? "host" : "player";
}

export function isRoundCommandAuthorized(
  role: "host" | "player",
  command: MutationCommand,
): boolean {
  return command.type === "mark-card" || role === "host";
}

export function resolveRoundPatternMode(
  patterns: readonly RoundCommandPatternReference[],
  patternId: string,
): RoundPatternMode | null {
  return patterns.find((pattern) => pattern.id === patternId)?.mode ?? null;
}

function patternModeOrThrow(
  patterns: readonly RoundCommandPatternReference[],
  patternId: string,
): RoundPatternMode {
  const mode = resolveRoundPatternMode(patterns, patternId);
  if (mode === null) throw new Error("Persisted round references an unknown canonical pattern.");
  return mode;
}

function patternOrThrow(
  patterns: readonly RoundCommandPattern[],
  patternId: string,
): RoundCommandPattern {
  const pattern = patterns.find((candidate) => candidate.id === patternId);
  if (pattern === undefined)
    throw new Error("Persisted round references an unknown canonical pattern.");
  return pattern;
}

interface ParsedParticipantPrivateEvents {
  readonly events: readonly ParticipantPrivateEvent[];
  readonly progress: ParticipantPrivateProgress | null;
  readonly legacy: boolean;
}

interface ParticipantPrivateProgress {
  readonly pattern: RoundCommandPattern;
  readonly calledCells: PatternCardState;
  readonly markedCells: PatternCardState;
  readonly nearWinFeedbackEnabled: boolean;
}

function parseParticipantPrivateProgress(value: unknown): ParticipantPrivateProgress {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted participant-private progress is invalid.");
  }
  const progress = value as Record<string, unknown>;
  if (
    Object.keys(progress).sort().join(",") !==
      ["calledCells", "markedCells", "nearWinFeedbackEnabled", "pattern"].join(",") ||
    typeof progress["nearWinFeedbackEnabled"] !== "boolean"
  ) {
    throw new Error("Persisted participant-private progress is invalid.");
  }
  const calledCells = PatternCardStateSchema.parse(progress["calledCells"]);
  const markedCells = PatternCardStateSchema.parse(progress["markedCells"]);
  if (
    !calledCells[12] ||
    !markedCells[12] ||
    markedCells.some((marked, index) => marked && !calledCells[index])
  ) {
    throw new Error("Persisted participant-private progress is inconsistent.");
  }
  return {
    pattern: PatternDefinitionSchema.parse(progress["pattern"]),
    calledCells,
    markedCells,
    nearWinFeedbackEnabled: progress["nearWinFeedbackEnabled"],
  };
}

function parseParticipantPrivateEvents(
  result: Readonly<Record<string, unknown>>,
  resultFormat: number,
): ParsedParticipantPrivateEvents {
  const persistedEvents = result["participantPrivateEvents"];
  const legacyEvent = result["participantPrivateEvent"];
  const persistedProgress = result["participantPrivateProgress"];
  if (persistedEvents !== undefined && legacyEvent !== undefined) {
    throw new Error("Persisted participant-private event shapes conflict.");
  }
  if (resultFormat === 3 || resultFormat === 4) {
    if (legacyEvent !== undefined) {
      throw new Error("Current participant-private results cannot use the legacy event shape.");
    }
    if (persistedEvents === undefined && persistedProgress === undefined) {
      return { events: [], progress: null, legacy: false };
    }
    if (persistedEvents === undefined || persistedProgress === undefined) {
      throw new Error("Persisted participant-private result context is incomplete.");
    }
    if (!Array.isArray(persistedEvents) || persistedEvents.length > 2) {
      throw new Error("Persisted participant-private events are invalid.");
    }
    const events = persistedEvents.map((event) => ParticipantPrivateEventSchema.parse(event));
    if (
      (events.length > 0 && events[0]?.type !== "mark-result") ||
      (events.length === 2 && events[1]?.type !== "near-win")
    ) {
      throw new Error("Persisted participant-private event order is invalid.");
    }
    return {
      events,
      progress: parseParticipantPrivateProgress(persistedProgress),
      legacy: false,
    };
  }
  if (resultFormat === 2) {
    throw new Error("Unverified participant-private result format is not replayable.");
  }
  if (resultFormat !== 1 || persistedEvents !== undefined || persistedProgress !== undefined) {
    throw new Error("Persisted participant-private result format is invalid.");
  }
  if (legacyEvent === undefined) return { events: [], progress: null, legacy: true };
  const parsedLegacyEvent = ParticipantPrivateEventSchema.parse(legacyEvent);
  if (parsedLegacyEvent.type !== "mark-result") {
    throw new Error("Persisted legacy participant-private event is invalid.");
  }
  return { events: [parsedLegacyEvent], progress: null, legacy: true };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Integrity data contains an invalid number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Integrity data is not JSON-compatible.");
}

function verifiedCommandResultIntegrity(input: {
  readonly lobbyId: string;
  readonly participantId: string;
  readonly commandId: string;
  readonly roundId: string;
  readonly commandType: string;
  readonly result: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly deliveryScope: "ACTIVE_LOBBY" | "PARTICIPANT_PRIVATE";
  readonly eventSequence: bigint | null;
  readonly resultFormat: 3 | 4;
}): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    createHash("sha256")
      .update(
        canonicalJson({
          ...input,
          createdAt: input.createdAt.toISOString(),
          eventSequence: input.eventSequence?.toString() ?? null,
        }),
        "utf8",
      )
      .digest(),
  );
}

function verifyParticipantPrivateResultIntegrity(
  expected: Uint8Array | null,
  input: Parameters<typeof verifiedCommandResultIntegrity>[0],
): void {
  if (expected === null || expected.length !== 32) {
    throw new Error("Persisted participant-private result integrity is missing.");
  }
  const actual = verifiedCommandResultIntegrity(input);
  if (!timingSafeEqual(expected, actual)) {
    throw new Error("Persisted participant-private result integrity is invalid.");
  }
}

async function validateReplayedParticipantPrivateEvents(
  transaction: Prisma.TransactionClient,
  input: {
    readonly participantId: string;
    readonly roundId: string | null;
    readonly command: MutationCommand;
    readonly events: readonly ParticipantPrivateEvent[];
    readonly progress: ParticipantPrivateProgress | null;
    readonly legacy: boolean;
    readonly committedAt: Date;
  },
): Promise<void> {
  if (input.events.length === 0) {
    if (input.roundId !== null) {
      throw new Error("Persisted current-round participant-private replay has no events.");
    }
    return;
  }
  const markResult = input.events[0];
  if (
    input.command.type !== "mark-card" ||
    input.roundId === null ||
    markResult?.type !== "mark-result" ||
    markResult.commandId !== input.command.commandId ||
    markResult.mark.ball !== input.command.ball
  ) {
    throw new Error("Persisted participant-private replay metadata is invalid.");
  }
  const card = await transaction.card.findFirst({
    where: {
      id: markResult.mark.cardId,
      roundId: input.roundId,
      participantId: input.participantId,
    },
    select: {
      cells: true,
      marks: { select: { ball: true } },
    },
  });
  const round = await transaction.round.findUnique({
    where: { id: input.roundId },
    select: {
      calls: { select: { ball: true } },
    },
  });
  const persistedMark = await transaction.mark.findUnique({
    where: {
      cardId_ball: { cardId: markResult.mark.cardId, ball: markResult.mark.ball },
    },
    select: { id: true, markedAt: true },
  });
  const nearWin = input.events[1];
  if (
    card === null ||
    round === null ||
    persistedMark === null ||
    persistedMark.id !== markResult.mark.id ||
    persistedMark.markedAt.toISOString() !== markResult.mark.markedAt ||
    markResult.occurredAt !== input.committedAt.toISOString() ||
    !card.cells.includes(markResult.mark.ball) ||
    (nearWin !== undefined &&
      (nearWin.type !== "near-win" || !card.cells.includes(nearWin.requiredBall)))
  ) {
    throw new Error("Persisted participant-private replay does not match authoritative state.");
  }
  if (input.legacy) return;
  if (input.progress === null) {
    throw new Error("Persisted participant-private replay has no canonical progress.");
  }
  const calledBalls = new Set(round.calls.map(({ ball }) => ball));
  const markedBalls = new Set(card.marks.map(({ ball }) => ball));
  if (
    input.progress.calledCells.some(
      (called, index) => called && card.cells[index] !== 0 && !calledBalls.has(card.cells[index]!),
    ) ||
    input.progress.markedCells.some(
      (marked, index) => marked && card.cells[index] !== 0 && !markedBalls.has(card.cells[index]!),
    )
  ) {
    throw new Error("Persisted participant-private progress exceeds authoritative state.");
  }
  const progress = calculatePatternProgress(input.progress.pattern, {
    calledCells: input.progress.calledCells,
    markedCells: input.progress.markedCells,
  });
  const expectedRequiredBall =
    progress.nearWinCellIndex === null ? null : card.cells[progress.nearWinCellIndex];
  if (expectedRequiredBall === undefined || expectedRequiredBall === 0) {
    throw new Error("Canonical near-win progress references an invalid card cell.");
  }
  const shouldIncludeNearWin =
    input.progress.nearWinFeedbackEnabled && expectedRequiredBall !== null;
  if (
    shouldIncludeNearWin !== (nearWin !== undefined) ||
    (nearWin !== undefined &&
      (nearWin.requiredBall !== expectedRequiredBall ||
        nearWin.occurredAt !== markResult.occurredAt))
  ) {
    throw new Error("Persisted near-win replay does not match authoritative progress.");
  }
}

function requireDate(value: Date | null, name: string): Date {
  if (value === null) throw new Error(`${name} is required by the persisted round stage.`);
  return value;
}

function requireString(value: string | null, name: string): string {
  if (value === null) throw new Error(`${name} is required by the persisted round stage.`);
  return value;
}

function toDomainRound(
  round: CurrentRound,
  patterns: readonly RoundCommandPatternReference[],
): RoundState {
  const base = {
    initialPatternMode: patternModeOrThrow(patterns, round.initialPatternId),
    patternMode: patternModeOrThrow(patterns, round.currentPatternId),
    createdAt: round.createdAt.getTime(),
  } as const;
  switch (round.stage) {
    case "WAITING":
      return { ...base, stage: "waiting" };
    case "ACTIVE":
      return {
        ...base,
        stage: "active",
        startedAt: requireDate(round.startedAt, "Round start time").getTime(),
        activeAt: requireDate(round.activeAt, "Round activation time").getTime(),
      };
    case "PAUSED":
      return {
        ...base,
        stage: "paused",
        startedAt: requireDate(round.startedAt, "Round start time").getTime(),
        pausedAt: requireDate(round.pausedAt, "Round pause time").getTime(),
        pauseReason:
          round.pauseReason === "HOST_ABSENT"
            ? "host-absent"
            : round.pauseReason === "PARTICIPANT_ABSENT"
              ? "participant-absent"
              : "host-command",
      };
    case "CO_WINNER_WINDOW":
      return {
        ...base,
        stage: "co-winner-window",
        startedAt: requireDate(round.startedAt, "Round start time").getTime(),
        windowOpenedAt: requireDate(round.coWinnerOpenedAt, "Co-winner opening time").getTime(),
        windowClosesAt: requireDate(round.coWinnerClosesAt, "Co-winner closing time").getTime(),
      };
    case "RESULT":
      return {
        ...base,
        stage: "result",
        startedAt: requireDate(round.startedAt, "Round start time").getTime(),
        settledAt: requireDate(round.resultSettledAt, "Result settlement time").getTime(),
      };
    case "ENDED":
      return {
        ...base,
        stage: "ended",
        startedAt: requireDate(round.startedAt, "Round start time").getTime(),
        endedAt: requireDate(round.endedAt, "Round end time").getTime(),
      };
  }
}

function callConfiguration(round: CurrentRound) {
  if (round.callMode === "MANUAL") return { mode: "manual" as const };
  if (![5, 10, 30, 60, 120].includes(round.callIntervalSeconds ?? -1)) {
    throw new Error("Persisted automatic round has an invalid call interval.");
  }
  return {
    mode: "automatic" as const,
    intervalSeconds: round.callIntervalSeconds as 5 | 10 | 30 | 60 | 120,
  };
}

export function nextContinuationPatternId(
  initialPatternId: string,
  currentPatternId: string,
): string | null {
  if (initialPatternId !== "standard-one-line") return null;
  if (currentPatternId === "standard-one-line") return "standard-two-lines";
  if (currentPatternId === "standard-two-lines") return "standard-blackout";
  return null;
}

async function publicRoundState(
  transaction: Prisma.TransactionClient,
  lobbyId: string,
  round: CurrentRound,
): Promise<Prisma.InputJsonObject> {
  const base = {
    id: round.id,
    lobbyId,
    patternId: round.currentPatternId,
    callConfiguration: callConfiguration(round),
  };
  const startedAt = round.startedAt?.toISOString();
  let candidate: unknown;
  switch (round.stage) {
    case "WAITING":
      candidate = { ...base, stage: "waiting", createdAt: round.createdAt.toISOString() };
      break;
    case "ACTIVE":
      candidate = { ...base, stage: "active", startedAt };
      break;
    case "PAUSED":
      candidate = {
        ...base,
        stage: "paused",
        startedAt,
        pauseReason:
          round.pauseReason === "HOST_ABSENT"
            ? "host-absent"
            : round.pauseReason === "PARTICIPANT_ABSENT"
              ? "participant-absent"
              : "host-command",
        pausedAt: round.pausedAt?.toISOString(),
      };
      break;
    case "CO_WINNER_WINDOW":
      candidate = {
        ...base,
        stage: "co-winner-window",
        startedAt,
        window: {
          triggeringCallId: round.coWinnerTriggeringCallId,
          openedAt: round.coWinnerOpenedAt?.toISOString(),
          closesAt: round.coWinnerClosesAt?.toISOString(),
        },
      };
      break;
    case "RESULT":
    case "ENDED": {
      const winners = await transaction.coWinner.findMany({
        where: { lobbyId, roundId: round.id },
        select: { participantId: true },
        orderBy: { participantId: "asc" },
      });
      const result =
        winners.length === 0
          ? null
          : {
              triggeringCallId: round.coWinnerTriggeringCallId,
              openedAt: round.coWinnerOpenedAt?.toISOString(),
              closesAt: round.coWinnerClosesAt?.toISOString(),
              settledAt: round.resultSettledAt?.toISOString(),
              winnerParticipantIds: winners.map(({ participantId }) => participantId),
            };
      candidate =
        round.stage === "RESULT"
          ? {
              ...base,
              stage: "result",
              startedAt,
              continuationPatternId: nextContinuationPatternId(
                round.initialPatternId,
                round.currentPatternId,
              ),
              result,
            }
          : {
              ...base,
              stage: "ended",
              startedAt,
              endedAt: round.endedAt?.toISOString(),
              result,
            };
      break;
    }
  }
  return RoundStateSchema.parse(candidate) as unknown as Prisma.InputJsonObject;
}

function commandIntent(command: MutationCommand): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(command)) as Prisma.InputJsonObject;
}

export function roundCommandIntentsMatch(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => roundCommandIntentsMatch(value, right[index]))
    );
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && roundCommandIntentsMatch(leftRecord[key], rightRecord[key]),
    )
  );
}

async function loadCurrentRound(
  transaction: Prisma.TransactionClient,
  lobbyId: string,
): Promise<CurrentRound | null> {
  return transaction.round.findUnique({
    where: { lobbyId },
    select: {
      id: true,
      initialPatternId: true,
      currentPatternId: true,
      stage: true,
      callMode: true,
      callIntervalSeconds: true,
      createdAt: true,
      startedAt: true,
      activeAt: true,
      pausedAt: true,
      pauseReason: true,
      nextCallAt: true,
      resultSettledAt: true,
      endedAt: true,
      coWinnerOpenedAt: true,
      coWinnerClosesAt: true,
      coWinnerTriggeringCallId: true,
    },
  });
}

function nextAutomaticCallAt(round: CurrentRound, now: Date): Date | null {
  if (round.callMode !== "AUTOMATIC" || round.callIntervalSeconds === null) return null;
  return new Date(now.getTime() + round.callIntervalSeconds * 1_000);
}

async function hasBlockingPresence(
  transaction: Prisma.TransactionClient,
  lobbyId: string,
  now: Date,
): Promise<boolean> {
  const blockingPresence = await transaction.presenceGeneration.findFirst({
    where: {
      lobbyId,
      endedAt: null,
      participant: {
        departedAt: null,
        OR: [{ role: "HOST" }, { roundEligibility: "PLAYING" }],
      },
      OR: [
        { status: "ABSENT", overridden: false },
        { status: "GRACE", graceEndsAt: { lte: now } },
      ],
    },
    select: { participantId: true },
  });
  return blockingPresence !== null;
}

async function commitNextCall(
  transaction: Prisma.TransactionClient,
  input: { readonly round: CurrentRound; readonly now: Date },
  options: RoundCommandRuntimeOptions,
): Promise<Extract<PendingCommand, { readonly scope: "active-lobby" }> | null> {
  const { now, round } = input;
  const [drawPositions, committedCount] = await Promise.all([
    transaction.drawPosition.findMany({
      where: { roundId: round.id },
      select: { ball: true },
      orderBy: { position: "asc" },
    }),
    transaction.call.count({ where: { roundId: round.id } }),
  ]);
  const next = commitNextDrawPosition(
    drawPositions.map(({ ball }) => ball),
    committedCount,
  );
  if (!next.ok) return null;
  const callId = options.nextId("call");
  await transaction.call.create({
    data: {
      id: callId,
      roundId: round.id,
      position: next.position,
      ball: next.ball,
      calledAt: now,
    },
  });
  await transaction.round.update({
    where: { id: round.id },
    data: {
      nextCallAt: next.position === drawPositions.length ? null : nextAutomaticCallAt(round, now),
    },
  });
  return {
    roundId: round.id,
    scope: "active-lobby",
    event: {
      type: "call",
      payload: {
        call: {
          id: callId,
          roundId: round.id,
          position: next.position,
          ball: next.ball,
          calledAt: now.toISOString(),
        },
      },
    },
  };
}

async function executeMutation(
  transaction: Prisma.TransactionClient,
  input: {
    readonly lobbyId: string;
    readonly participantId: string;
    readonly command: MutationCommand;
    readonly now: Date;
  },
  options: RoundCommandRuntimeOptions,
): Promise<PendingCommand | null> {
  const { command, lobbyId, now, participantId } = input;
  const current = await loadCurrentRound(transaction, lobbyId);

  if (command.type === "override-absence") {
    await expireDueParticipantSessions(transaction, lobbyId, now);
    const presence = await transaction.presenceGeneration.findFirst({
      where: {
        lobbyId,
        participantId: command.participantId,
        generation: BigInt(command.presenceGeneration),
        status: "ABSENT",
        overridden: false,
        endedAt: null,
        participant: { role: "PLAYER", departedAt: null },
      },
      select: { absentSince: true },
    });
    if (presence === null) return null;
    if (presence.absentSince === null) {
      throw new Error("Absent presence requires a start timestamp.");
    }
    await transaction.presenceGeneration.update({
      where: {
        participantId_generation: {
          participantId: command.participantId,
          generation: BigInt(command.presenceGeneration),
        },
      },
      data: { overridden: true, changedAt: now },
    });
    return {
      roundId: null,
      scope: "active-lobby",
      event: {
        type: "presence",
        payload: {
          presence: {
            participantId: command.participantId,
            generation: command.presenceGeneration,
            status: "absent",
            changedAt: now.toISOString(),
            absentSince: presence.absentSince.toISOString(),
            overridden: true,
          },
        },
      },
    };
  }

  if (command.type === "create-round") {
    if (current !== null && current.stage !== "ENDED") return null;
    const defaultPatternId = "standard-one-line";
    if (resolveRoundPatternMode(options.patterns, defaultPatternId) !== "one-line") return null;
    await expireDueParticipantSessions(transaction, lobbyId, now);
    const participants = await transaction.participant.findMany({
      where: { lobbyId, departedAt: null },
      select: { id: true },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    });
    if (participants.length < 1 || participants.length > 25) return null;
    const roundId = options.nextId("round");
    const cards = generateBingoCards(participants.length, options.randomBytes);
    const drawOrder = generateDrawOrder(options.randomBytes);
    createWaitingRound("one-line", now.getTime());

    if (current !== null) {
      await transaction.activeLobbyEvent.updateMany({
        where: { roundId: current.id },
        data: { roundId: null },
      });
      await transaction.$executeRaw`
        UPDATE "command_results"
           SET "round_id" = NULL,
                 "result_integrity" = NULL,
                 "result" = "result" - 'participantPrivateEvent' - 'participantPrivateEvents'
                   - 'patternId' - 'participantPrivateProgress'
         WHERE "round_id" = ${current.id}
      `;
      await transaction.round.delete({ where: { id: current.id } });
    }
    await transaction.participant.updateMany({
      where: { lobbyId, departedAt: null },
      data: { roundEligibility: "PLAYING" },
    });
    await transaction.round.create({
      data: {
        id: roundId,
        lobbyId,
        initialPatternId: defaultPatternId,
        currentPatternId: defaultPatternId,
        stage: "WAITING",
        callMode: "MANUAL",
        callIntervalSeconds: null,
        createdAt: now,
      },
    });
    await transaction.drawPosition.createMany({
      data: drawOrder.map((ball, index) => ({ roundId, position: index + 1, ball })),
    });
    await transaction.card.createMany({
      data: cards.map((cells, index) => ({
        id: options.nextId("card"),
        lobbyId,
        roundId,
        participantId: participants[index]!.id,
        cells: cells.map((cell) => (cell === FREE_BINGO_CELL ? 0 : cell)),
        createdAt: now,
      })),
    });
    await transaction.lobby.update({ where: { id: lobbyId }, data: { status: "WAITING" } });
    const round = await loadCurrentRound(transaction, lobbyId);
    if (round === null) throw new Error("Created round could not be reloaded.");
    return {
      roundId,
      scope: "active-lobby",
      event: {
        type: "stage",
        payload: { round: await publicRoundState(transaction, lobbyId, round) },
      },
    };
  }

  if (current === null) return null;

  if (
    command.type === "start-round" ||
    command.type === "resume-round" ||
    command.type === "call-next" ||
    command.type === "continue-round"
  ) {
    if (await hasBlockingPresence(transaction, lobbyId, now)) return null;
  }

  if (command.type === "configure") {
    const patternMode = resolveRoundPatternMode(options.patterns, command.patternId);
    if (current.stage !== "WAITING" || patternMode === null) return null;
    await transaction.round.update({
      where: { id: current.id },
      data: {
        initialPatternId: command.patternId,
        currentPatternId: command.patternId,
        callMode: command.callConfiguration.mode === "manual" ? "MANUAL" : "AUTOMATIC",
        callIntervalSeconds:
          command.callConfiguration.mode === "manual"
            ? null
            : command.callConfiguration.intervalSeconds,
      },
    });
    const round = await loadCurrentRound(transaction, lobbyId);
    if (round === null) throw new Error("Configured round could not be reloaded.");
    return {
      roundId: current.id,
      scope: "active-lobby",
      event: {
        type: "stage",
        payload: { round: await publicRoundState(transaction, lobbyId, round) },
      },
    };
  }

  if (command.type === "start-round") {
    const transition = transitionRound(toDomainRound(current, options.patterns), {
      type: "start",
      at: now.getTime(),
    });
    if (!transition.ok) return null;
    await transaction.round.update({
      where: { id: current.id },
      data: {
        stage: "ACTIVE",
        startedAt: now,
        activeAt: now,
        pausedAt: null,
        pauseReason: null,
        nextCallAt: nextAutomaticCallAt(current, now),
      },
    });
    await transaction.lobby.update({ where: { id: lobbyId }, data: { status: "ACTIVE" } });
    const round = await loadCurrentRound(transaction, lobbyId);
    if (round === null) throw new Error("Started round could not be reloaded.");
    return {
      roundId: current.id,
      scope: "active-lobby",
      event: {
        type: "stage",
        payload: { round: await publicRoundState(transaction, lobbyId, round) },
      },
    };
  }

  if (command.type === "pause-round" || command.type === "resume-round") {
    const transition = transitionRound(
      toDomainRound(current, options.patterns),
      command.type === "pause-round"
        ? { type: "pause", reason: "host-command", at: now.getTime() }
        : { type: "resume", at: now.getTime() },
    );
    if (!transition.ok) return null;
    const pausing = command.type === "pause-round";
    await transaction.round.update({
      where: { id: current.id },
      data: pausing
        ? { stage: "PAUSED", pausedAt: now, pauseReason: "HOST_COMMAND", nextCallAt: null }
        : {
            stage: "ACTIVE",
            activeAt: now,
            pausedAt: null,
            pauseReason: null,
            nextCallAt: nextAutomaticCallAt(current, now),
          },
    });
    const round = await loadCurrentRound(transaction, lobbyId);
    if (round === null) throw new Error("Transitioned round could not be reloaded.");
    return {
      roundId: current.id,
      scope: "active-lobby",
      event: {
        type: "stage",
        payload: { round: await publicRoundState(transaction, lobbyId, round) },
      },
    };
  }

  if (command.type === "call-next") {
    if (current.stage !== "ACTIVE") return null;
    return commitNextCall(transaction, { round: current, now }, options);
  }

  if (command.type === "continue-round") {
    const patternMode = resolveRoundPatternMode(options.patterns, command.patternId);
    if (patternMode === null) return null;
    const transition = transitionRound(toDomainRound(current, options.patterns), {
      type: "continue",
      patternMode,
      at: now.getTime(),
    });
    if (!transition.ok) return null;
    const [drawPositionCount, calls, settledWinners] = await Promise.all([
      transaction.drawPosition.count({ where: { roundId: current.id } }),
      transaction.call.findMany({
        where: { roundId: current.id },
        select: { id: true, ball: true },
        orderBy: { position: "asc" },
      }),
      transaction.coWinner.findMany({
        where: { lobbyId, roundId: current.id },
        select: { participantId: true, cardId: true, triggeringCallId: true },
      }),
    ]);
    const winnerCards = await transaction.card.findMany({
      where: { roundId: current.id, id: { in: settledWinners.map(({ cardId }) => cardId) } },
      select: { id: true, cells: true, marks: { select: { ball: true } } },
    });
    const cardsById = new Map(winnerCards.map((card) => [card.id, card]));
    const latestCall = calls.at(-1);
    const calledBalls = new Set(calls.map(({ ball }) => ball));
    const pattern = patternOrThrow(options.patterns, command.patternId);
    const carriedParticipantIds = settledWinners.flatMap((winner) => {
      const card = cardsById.get(winner.cardId);
      const markedBalls = new Set(card?.marks.map(({ ball }) => ball));
      if (
        card === undefined ||
        latestCall === undefined ||
        winner.triggeringCallId !== latestCall.id ||
        !markedBalls.has(latestCall.ball)
      ) {
        return [];
      }
      const calledCells = card.cells.map((ball) => ball === 0 || calledBalls.has(ball));
      const progress = calculatePatternProgress(pattern, {
        calledCells,
        markedCells: card.cells.map((ball) => ball === 0 || markedBalls.has(ball)),
      });
      const priorProgress = calculatePatternProgress(pattern, {
        calledCells,
        markedCells: card.cells.map(
          (ball) => ball === 0 || (ball !== latestCall.ball && markedBalls.has(ball)),
        ),
      });
      return !priorProgress.complete && progress.complete ? [winner.participantId] : [];
    });
    const carriesResult = carriedParticipantIds.length > 0;
    await transaction.coWinner.deleteMany({
      where: {
        roundId: current.id,
        ...(carriesResult ? { participantId: { notIn: carriedParticipantIds } } : {}),
      },
    });
    await transaction.round.update({
      where: { id: current.id },
      data: {
        currentPatternId: command.patternId,
        stage: carriesResult ? "RESULT" : "ACTIVE",
        activeAt: now,
        pausedAt: null,
        pauseReason: null,
        nextCallAt:
          !carriesResult && calls.length < drawPositionCount
            ? nextAutomaticCallAt(current, now)
            : null,
        coWinnerTriggeringCallId: carriesResult
          ? requireString(current.coWinnerTriggeringCallId, "Winning call ID")
          : null,
        coWinnerOpenedAt: carriesResult
          ? requireDate(current.coWinnerOpenedAt, "Co-winner opening time")
          : null,
        coWinnerClosesAt: carriesResult
          ? requireDate(current.coWinnerClosesAt, "Co-winner closing time")
          : null,
        resultSettledAt: carriesResult ? now : null,
      },
    });
    const round = await loadCurrentRound(transaction, lobbyId);
    if (round === null) throw new Error("Continued round could not be reloaded.");
    return {
      roundId: current.id,
      scope: "active-lobby",
      event: {
        type: "stage",
        payload: { round: await publicRoundState(transaction, lobbyId, round) },
      },
    };
  }

  if (command.type === "end-round") {
    const transition = transitionRound(toDomainRound(current, options.patterns), {
      type: "end",
      at: now.getTime(),
    });
    if (!transition.ok) return null;
    await transaction.round.update({
      where: { id: current.id },
      data: { stage: "ENDED", endedAt: now, nextCallAt: null },
    });
    await transaction.lobby.update({ where: { id: lobbyId }, data: { status: "WAITING" } });
    const round = await loadCurrentRound(transaction, lobbyId);
    if (round === null) throw new Error("Ended round could not be reloaded.");
    return {
      roundId: current.id,
      scope: "active-lobby",
      event: {
        type: "round-end",
        payload: { round: await publicRoundState(transaction, lobbyId, round) },
      },
    };
  }

  if (command.type === "mark-card") {
    if (!["ACTIVE", "PAUSED", "CO_WINNER_WINDOW"].includes(current.stage)) return null;
    if (
      current.stage === "CO_WINNER_WINDOW" &&
      (current.coWinnerClosesAt === null || now.getTime() >= current.coWinnerClosesAt.getTime())
    ) {
      return null;
    }
    const card = await transaction.card.findUnique({
      where: { roundId_participantId: { roundId: current.id, participantId } },
      select: { id: true, cells: true, marks: { select: { ball: true } } },
    });
    if (card === null || !card.cells.includes(command.ball)) return null;
    const calls = await transaction.call.findMany({
      where: { roundId: current.id },
      select: { id: true, ball: true, position: true },
      orderBy: { position: "asc" },
    });
    const calledBalls = new Set(calls.map(({ ball }) => ball));
    if (!calledBalls.has(command.ball)) return null;
    const priorMark = await transaction.mark.findUnique({
      where: { cardId_ball: { cardId: card.id, ball: command.ball } },
      select: { id: true, markedAt: true },
    });
    const mark =
      priorMark ??
      (await transaction.mark.create({
        data: {
          id: options.nextId("mark"),
          roundId: current.id,
          cardId: card.id,
          ball: command.ball,
          markedAt: now,
        },
        select: { id: true, markedAt: true },
      }));
    const markResult = ParticipantPrivateEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-result",
      commandId: command.commandId,
      occurredAt: now.toISOString(),
      mark: {
        id: mark.id,
        cardId: card.id,
        ball: command.ball,
        markedAt: mark.markedAt.toISOString(),
      },
    });
    const priorMarkedBalls = new Set(card.marks.map(({ ball }) => ball));
    const markedBalls = new Set([...priorMarkedBalls, command.ball]);
    const progressInput = {
      calledCells: card.cells.map((ball) => ball === 0 || calledBalls.has(ball)),
      markedCells: card.cells.map((ball) => ball === 0 || markedBalls.has(ball)),
    };
    const pattern = patternOrThrow(options.patterns, current.currentPatternId);
    const progress = calculatePatternProgress(pattern, progressInput);
    const priorProgress = calculatePatternProgress(pattern, {
      calledCells: progressInput.calledCells,
      markedCells: card.cells.map((ball) => ball === 0 || priorMarkedBalls.has(ball)),
    });
    const requiredBall =
      progress.nearWinCellIndex === null ? null : card.cells[progress.nearWinCellIndex];
    if (requiredBall === undefined || requiredBall === 0) {
      throw new Error("Canonical near-win progress references an invalid card cell.");
    }
    const events = [
      markResult,
      ...(options.nearWinFeedbackEnabled && requiredBall !== null
        ? [
            ParticipantPrivateEventSchema.parse({
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              type: "near-win",
              occurredAt: now.toISOString(),
              requiredBall,
            }),
          ]
        : []),
    ];
    const latestCall = calls.at(-1);
    const attributableCompletion =
      priorMark === null &&
      !priorProgress.complete &&
      progress.complete &&
      latestCall !== undefined &&
      command.ball === latestCall.ball;
    if (attributableCompletion && (current.stage === "ACTIVE" || current.stage === "PAUSED")) {
      const closesAt = new Date(now.getTime() + options.coWinnerWindowMs);
      const transition = transitionRound(toDomainRound(current, options.patterns), {
        type: "open-co-winner-window",
        at: now.getTime(),
        closesAt: closesAt.getTime(),
      });
      if (!transition.ok) return null;
      await transaction.coWinner.create({
        data: {
          lobbyId,
          roundId: current.id,
          participantId,
          cardId: card.id,
          triggeringCallId: latestCall.id,
          confirmedAt: now,
        },
      });
      await transaction.round.update({
        where: { id: current.id },
        data: {
          stage: "CO_WINNER_WINDOW",
          pausedAt: null,
          pauseReason: null,
          nextCallAt: null,
          coWinnerTriggeringCallId: latestCall.id,
          coWinnerOpenedAt: now,
          coWinnerClosesAt: closesAt,
        },
      });
      return {
        roundId: current.id,
        scope: "active-lobby",
        event: {
          type: "co-winner-window",
          payload: {
            window: {
              triggeringCallId: latestCall.id,
              openedAt: now.toISOString(),
              closesAt: closesAt.toISOString(),
            },
          },
        },
        progress: {
          pattern,
          ...progressInput,
          nearWinFeedbackEnabled: options.nearWinFeedbackEnabled,
        },
        events,
      };
    }
    if (
      attributableCompletion &&
      current.stage === "CO_WINNER_WINDOW" &&
      current.coWinnerTriggeringCallId === latestCall.id
    ) {
      await transaction.coWinner.create({
        data: {
          lobbyId,
          roundId: current.id,
          participantId,
          cardId: card.id,
          triggeringCallId: latestCall.id,
          confirmedAt: now,
        },
      });
    }
    return {
      roundId: current.id,
      scope: "participant-private",
      progress: {
        pattern,
        ...progressInput,
        nearWinFeedbackEnabled: options.nearWinFeedbackEnabled,
      },
      events,
    };
  }

  return null;
}

class PrismaRoundCommandExecutor implements RoundCommandExecutor {
  constructor(
    private readonly prisma: GeneratedPrismaClient,
    private readonly retryOptions: TransactionRetryOptions,
    private readonly options: RoundCommandRuntimeOptions | undefined,
  ) {}

  async execute(input: {
    readonly lobbyId: string;
    readonly sessionTokenHash: Uint8Array;
    readonly command: MutationCommand;
  }): Promise<RoundCommandExecutionResult> {
    if (input.sessionTokenHash.length !== 32) {
      throw new RangeError("Participant session token hashes must contain exactly 32 bytes.");
    }
    return this.executeForActor(input);
  }

  executeAuthenticated(input: {
    readonly lobbyId: string;
    readonly participantId: string;
    readonly participantSessionId: string;
    readonly command: MutationCommand;
  }): Promise<RoundCommandExecutionResult> {
    return this.executeForActor(input);
  }

  async findAutomaticCallLeases(maximum = 2_500): Promise<readonly AutomaticCallLease[]> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2_500) {
      throw new RangeError("The automatic call recovery limit must be between 1 and 2500.");
    }
    const rows = await this.prisma.round.findMany({
      where: {
        stage: "ACTIVE",
        callMode: "AUTOMATIC",
        nextCallAt: { not: null },
        lobby: { status: "ACTIVE" },
      },
      select: { lobbyId: true, id: true, nextCallAt: true },
      orderBy: [{ nextCallAt: "asc" }, { lobbyId: "asc" }],
      take: maximum + 1,
    });
    if (rows.length > maximum) throw new Error("The automatic call recovery limit was exceeded.");
    return rows.map((row) => {
      if (row.nextCallAt === null) throw new Error("An automatic call lease requires a deadline.");
      return { lobbyId: row.lobbyId, roundId: row.id, deadline: row.nextCallAt };
    });
  }

  async findAutomaticCallLease(lobbyId: string): Promise<AutomaticCallLease | null> {
    const row = await this.prisma.round.findFirst({
      where: {
        lobbyId,
        stage: "ACTIVE",
        callMode: "AUTOMATIC",
        nextCallAt: { not: null },
        lobby: { status: "ACTIVE" },
      },
      select: { id: true, nextCallAt: true },
    });
    if (row?.nextCallAt === null || row?.nextCallAt === undefined) return null;
    return { lobbyId, roundId: row.id, deadline: row.nextCallAt };
  }

  executeAutomaticCall(lease: AutomaticCallLease): Promise<AutomaticCallExecutionResult> {
    if (this.options === undefined) {
      throw new Error("Round command runtime dependencies were not configured.");
    }
    assertValidDate(lease.deadline, "Automatic call deadline");
    const options = this.options;
    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const fenced = await transaction.$queryRaw<readonly { id: string }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence"
               WHERE "id" = ${lease.lobbyId}
                 AND "status" = 'ACTIVE'
               RETURNING "id"
            `;
            if (fenced.length !== 1) return "stale";
            const now = options.clock();
            assertValidDate(now, "Automatic call timestamp");
            const current = await loadCurrentRound(transaction, lease.lobbyId);
            if (
              current === null ||
              current.id !== lease.roundId ||
              current.stage !== "ACTIVE" ||
              current.callMode !== "AUTOMATIC" ||
              current.nextCallAt?.getTime() !== lease.deadline.getTime()
            ) {
              return "stale";
            }
            if (now.getTime() < current.nextCallAt.getTime()) return "too-early";
            if (await hasBlockingPresence(transaction, lease.lobbyId, now)) return "blocked";

            const pending = await commitNextCall(transaction, { round: current, now }, options);
            if (pending === null) {
              await transaction.round.update({
                where: { id: current.id },
                data: { nextCallAt: null },
              });
              return "exhausted";
            }
            const rows = await transaction.$queryRaw<readonly { sequence: bigint }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence" + 1,
                     "last_activity_at" = GREATEST("last_activity_at", ${now})
               WHERE "id" = ${lease.lobbyId}
               RETURNING "last_event_sequence" AS "sequence"
            `;
            const sequence = rows[0]?.sequence;
            if (sequence === undefined) throw new Error("Unable to allocate an event sequence.");
            ActiveLobbyEventSchema.parse({
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              type: pending.event.type,
              eventSequence: toSafeSequence(sequence),
              occurredAt: now.toISOString(),
              ...pending.event.payload,
            });
            await transaction.activeLobbyEvent.create({
              data: {
                lobbyId: lease.lobbyId,
                sequence,
                roundId: pending.roundId,
                eventType: pending.event.type,
                schemaVersion: CONTRACT_SCHEMA_VERSION,
                payload: pending.event.payload,
                createdAt: now,
              },
            });
            await transaction.$executeRaw`
              SELECT pg_notify(
                ${ACTIVE_LOBBY_EVENT_CHANNEL},
                ${encodeActiveLobbyEventReference(lease.lobbyId, sequence)}
              )
            `;
            return "called";
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 10_000,
          },
        ),
      this.retryOptions,
    );
  }

  async findCoWinnerSettlementLeases(maximum = 2_500): Promise<readonly CoWinnerSettlementLease[]> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2_500) {
      throw new RangeError("The co-winner settlement recovery limit must be between 1 and 2500.");
    }
    const rows = await this.prisma.round.findMany({
      where: {
        stage: "CO_WINNER_WINDOW",
        coWinnerTriggeringCallId: { not: null },
        coWinnerClosesAt: { not: null },
        lobby: { status: "ACTIVE" },
      },
      select: {
        lobbyId: true,
        id: true,
        coWinnerTriggeringCallId: true,
        coWinnerClosesAt: true,
      },
      orderBy: [{ coWinnerClosesAt: "asc" }, { lobbyId: "asc" }],
      take: maximum + 1,
    });
    if (rows.length > maximum)
      throw new Error("The co-winner settlement recovery limit was exceeded.");
    return rows.map((row) => {
      if (row.coWinnerTriggeringCallId === null || row.coWinnerClosesAt === null) {
        throw new Error("A co-winner settlement lease is incomplete.");
      }
      return {
        lobbyId: row.lobbyId,
        roundId: row.id,
        triggeringCallId: row.coWinnerTriggeringCallId,
        deadline: row.coWinnerClosesAt,
      };
    });
  }

  async findCoWinnerSettlementLease(lobbyId: string): Promise<CoWinnerSettlementLease | null> {
    const row = await this.prisma.round.findFirst({
      where: {
        lobbyId,
        stage: "CO_WINNER_WINDOW",
        coWinnerTriggeringCallId: { not: null },
        coWinnerClosesAt: { not: null },
        lobby: { status: "ACTIVE" },
      },
      select: { id: true, coWinnerTriggeringCallId: true, coWinnerClosesAt: true },
    });
    if (row?.coWinnerTriggeringCallId === null || row?.coWinnerTriggeringCallId === undefined) {
      return null;
    }
    if (row.coWinnerClosesAt === null)
      throw new Error("A co-winner settlement lease is incomplete.");
    return {
      lobbyId,
      roundId: row.id,
      triggeringCallId: row.coWinnerTriggeringCallId,
      deadline: row.coWinnerClosesAt,
    };
  }

  executeCoWinnerSettlement(
    lease: CoWinnerSettlementLease,
  ): Promise<CoWinnerSettlementExecutionResult> {
    if (this.options === undefined) {
      throw new Error("Round command runtime dependencies were not configured.");
    }
    if (
      lease.lobbyId.length === 0 ||
      lease.roundId.length === 0 ||
      lease.triggeringCallId.length === 0
    ) {
      throw new RangeError("Co-winner settlement lease identifiers must be nonempty.");
    }
    assertValidDate(lease.deadline, "Co-winner settlement deadline");
    const options = this.options;
    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const fenced = await transaction.$queryRaw<readonly { id: string }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence"
               WHERE "id" = ${lease.lobbyId}
                 AND "status" = 'ACTIVE'
               RETURNING "id"
            `;
            if (fenced.length !== 1) return "stale";
            const now = options.clock();
            assertValidDate(now, "Co-winner settlement timestamp");
            const current = await loadCurrentRound(transaction, lease.lobbyId);
            if (
              current === null ||
              current.id !== lease.roundId ||
              current.stage !== "CO_WINNER_WINDOW" ||
              current.coWinnerTriggeringCallId !== lease.triggeringCallId ||
              current.coWinnerClosesAt?.getTime() !== lease.deadline.getTime()
            ) {
              return "stale";
            }
            if (now.getTime() < lease.deadline.getTime()) return "too-early";
            const transition = transitionRound(toDomainRound(current, options.patterns), {
              type: "settle-result",
              at: now.getTime(),
            });
            if (!transition.ok) throw new Error("A due co-winner window could not settle.");
            const winners = await transaction.coWinner.findMany({
              where: { lobbyId: lease.lobbyId, roundId: lease.roundId },
              select: { participantId: true },
              orderBy: { participantId: "asc" },
            });
            if (winners.length === 0) throw new Error("A co-winner window requires a winner.");
            await transaction.round.update({
              where: { id: lease.roundId },
              data: { stage: "RESULT", resultSettledAt: now, nextCallAt: null },
            });
            const payload = {
              result: {
                triggeringCallId: lease.triggeringCallId,
                openedAt: requireDate(
                  current.coWinnerOpenedAt,
                  "Co-winner opening time",
                ).toISOString(),
                closesAt: lease.deadline.toISOString(),
                settledAt: now.toISOString(),
                winnerParticipantIds: winners.map(({ participantId }) => participantId),
              },
            } satisfies Prisma.InputJsonObject;
            const rows = await transaction.$queryRaw<readonly { sequence: bigint }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence" + 1,
                     "last_activity_at" = GREATEST("last_activity_at", ${now})
               WHERE "id" = ${lease.lobbyId}
               RETURNING "last_event_sequence" AS "sequence"
            `;
            const sequence = rows[0]?.sequence;
            if (sequence === undefined) throw new Error("Unable to allocate an event sequence.");
            ActiveLobbyEventSchema.parse({
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              type: "co-winner-result",
              eventSequence: toSafeSequence(sequence),
              occurredAt: now.toISOString(),
              ...payload,
            });
            await transaction.activeLobbyEvent.create({
              data: {
                lobbyId: lease.lobbyId,
                sequence,
                roundId: lease.roundId,
                eventType: "co-winner-result",
                schemaVersion: CONTRACT_SCHEMA_VERSION,
                payload,
                createdAt: now,
              },
            });
            await transaction.$executeRaw`
              SELECT pg_notify(
                ${ACTIVE_LOBBY_EVENT_CHANNEL},
                ${encodeActiveLobbyEventReference(lease.lobbyId, sequence)}
              )
            `;
            return "settled";
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 10_000,
          },
        ),
      this.retryOptions,
    );
  }

  private executeForActor(
    input:
      | {
          readonly lobbyId: string;
          readonly sessionTokenHash: Uint8Array;
          readonly command: MutationCommand;
        }
      | {
          readonly lobbyId: string;
          readonly participantId: string;
          readonly participantSessionId: string;
          readonly command: MutationCommand;
        },
  ): Promise<RoundCommandExecutionResult> {
    if (this.options === undefined) {
      throw new Error("Round command runtime dependencies were not configured.");
    }
    const options = this.options;
    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const fenced = await transaction.$queryRaw<readonly { id: string }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence"
               WHERE "id" = ${input.lobbyId}
                 AND "status" IN ('WAITING', 'ACTIVE')
               RETURNING "id"
            `;
            if (fenced.length !== 1) return { ok: false, error: { code: "NOT_FOUND" } } as const;
            const now = options.clock();
            assertValidDate(now, "Round command timestamp");
            const session = await transaction.participantSession.findFirst({
              where: {
                lobbyId: input.lobbyId,
                ...("sessionTokenHash" in input
                  ? { tokenHash: new Uint8Array(input.sessionTokenHash) }
                  : {
                      id: input.participantSessionId,
                      participantId: input.participantId,
                    }),
                status: "ACTIVE",
                participant: { departedAt: null },
              },
              select: { participant: { select: { id: true, role: true } } },
            });
            if (session === null) {
              return { ok: false, error: { code: "UNAUTHORIZED" } } as const;
            }
            const participantId = session.participant.id;
            const existing = await transaction.commandResult.findUnique({
              where: {
                lobbyId_participantId_commandId: {
                  lobbyId: input.lobbyId,
                  participantId,
                  commandId: input.command.commandId,
                },
              },
            });
            if (existing !== null) {
              const result = existing.result;
              if (
                existing.commandType !== input.command.type ||
                result === null ||
                Array.isArray(result) ||
                typeof result !== "object" ||
                !roundCommandIntentsMatch(result["intent"] ?? null, input.command)
              ) {
                return invalidCommand();
              }
              const scope =
                existing.deliveryScope === "ACTIVE_LOBBY"
                  ? ("active-lobby" as const)
                  : ("participant-private" as const);
              if (
                (existing.resultFormat === 3 && scope !== "participant-private") ||
                (existing.resultFormat === 4 && scope !== "active-lobby")
              ) {
                throw new Error("Persisted verified command-result scope is invalid.");
              }
              const parsedParticipantPrivateEvents =
                scope === "participant-private" || existing.resultFormat === 4
                  ? parseParticipantPrivateEvents(result, existing.resultFormat)
                  : { events: [], progress: null, legacy: false };
              const participantPrivateEvents = parsedParticipantPrivateEvents.events;
              if (scope === "participant-private" || existing.resultFormat === 4) {
                if (
                  (existing.resultFormat === 3 || existing.resultFormat === 4) &&
                  existing.roundId !== null
                ) {
                  verifyParticipantPrivateResultIntegrity(existing.resultIntegrity, {
                    lobbyId: existing.lobbyId,
                    participantId: existing.participantId,
                    commandId: existing.commandId,
                    roundId: existing.roundId,
                    commandType: existing.commandType,
                    result,
                    createdAt: existing.createdAt,
                    deliveryScope: existing.deliveryScope,
                    eventSequence: existing.eventSequence,
                    resultFormat: existing.resultFormat,
                  });
                } else if (existing.resultIntegrity !== null) {
                  throw new Error("Persisted participant-private result integrity is unexpected.");
                }
                await validateReplayedParticipantPrivateEvents(transaction, {
                  participantId,
                  roundId: existing.roundId,
                  command: input.command,
                  events: participantPrivateEvents,
                  progress: parsedParticipantPrivateEvents.progress,
                  legacy: parsedParticipantPrivateEvents.legacy,
                  committedAt: existing.createdAt,
                });
              }
              return {
                ok: true,
                acknowledgement: {
                  commandId: input.command.commandId,
                  scope,
                  eventSequence: toSafeSequence(existing.eventSequence),
                  occurredAt: existing.createdAt,
                  idempotentReplay: true,
                },
                activeLobbyEvent: null,
                participantPrivateEvents,
              } as const;
            }
            if (
              !isRoundCommandAuthorized(roleFromDatabase(session.participant.role), input.command)
            ) {
              return { ok: false, error: { code: "FORBIDDEN" } } as const;
            }

            const pending = await executeMutation(
              transaction,
              { lobbyId: input.lobbyId, participantId, command: input.command, now },
              options,
            );
            if (pending === null) return invalidCommand();

            let eventSequence: bigint | null = null;
            let activeLobbyEvent: ActiveLobbyEvent | null = null;
            const participantPrivateEvents =
              pending.scope === "active-lobby" ? (pending.events ?? []) : pending.events;
            const participantPrivateProgress =
              pending.scope === "active-lobby" ? (pending.progress ?? null) : pending.progress;
            if (pending.scope === "active-lobby") {
              const rows = await transaction.$queryRaw<readonly { sequence: bigint }[]>`
                UPDATE "lobbies"
                   SET "last_event_sequence" = "last_event_sequence" + 1,
                       "last_activity_at" = GREATEST("last_activity_at", ${now})
                 WHERE "id" = ${input.lobbyId}
                 RETURNING "last_event_sequence" AS "sequence"
              `;
              eventSequence = rows[0]?.sequence ?? null;
              if (eventSequence === null) throw new Error("Unable to allocate an event sequence.");
              activeLobbyEvent = ActiveLobbyEventSchema.parse({
                schemaVersion: CONTRACT_SCHEMA_VERSION,
                type: pending.event.type,
                eventSequence: toSafeSequence(eventSequence),
                occurredAt: now.toISOString(),
                ...pending.event.payload,
              });
              await transaction.activeLobbyEvent.create({
                data: {
                  lobbyId: input.lobbyId,
                  sequence: eventSequence,
                  roundId: pending.roundId,
                  eventType: pending.event.type,
                  schemaVersion: CONTRACT_SCHEMA_VERSION,
                  payload: pending.event.payload,
                  createdAt: now,
                },
              });
              await transaction.$executeRaw`
                SELECT pg_notify(
                  ${ACTIVE_LOBBY_EVENT_CHANNEL},
                  ${encodeActiveLobbyEventReference(input.lobbyId, eventSequence)}
                )
              `;
            } else {
              await transaction.$executeRaw`
                UPDATE "lobbies"
                   SET "last_activity_at" = GREATEST("last_activity_at", ${now})
                 WHERE "id" = ${input.lobbyId}
              `;
            }
            const persistedResult = {
              intent: commandIntent(input.command),
              ...(participantPrivateProgress === null
                ? {}
                : {
                    participantPrivateProgress: JSON.parse(
                      JSON.stringify(participantPrivateProgress),
                    ) as Prisma.InputJsonObject,
                  }),
              ...(participantPrivateEvents.length === 0
                ? {}
                : {
                    participantPrivateEvents: JSON.parse(
                      JSON.stringify(participantPrivateEvents),
                    ) as Prisma.InputJsonArray,
                  }),
            };
            const deliveryScope =
              pending.scope === "active-lobby"
                ? ("ACTIVE_LOBBY" as const)
                : ("PARTICIPANT_PRIVATE" as const);
            const resultFormat: 1 | 3 | 4 =
              pending.scope === "participant-private"
                ? 3
                : participantPrivateEvents.length > 0
                  ? 4
                  : 1;
            const resultIntegrity =
              resultFormat === 3 || resultFormat === 4
                ? verifiedCommandResultIntegrity({
                    lobbyId: input.lobbyId,
                    participantId,
                    commandId: input.command.commandId,
                    roundId: requireString(pending.roundId, "Verified command result round"),
                    commandType: input.command.type,
                    result: persistedResult,
                    createdAt: now,
                    deliveryScope,
                    eventSequence,
                    resultFormat,
                  })
                : null;
            await transaction.commandResult.create({
              data: {
                lobbyId: input.lobbyId,
                participantId,
                commandId: input.command.commandId,
                roundId: pending.roundId,
                commandType: input.command.type,
                deliveryScope,
                eventSequence,
                resultFormat,
                resultIntegrity,
                result: persistedResult,
                createdAt: now,
              },
            });
            return {
              ok: true,
              acknowledgement: {
                commandId: input.command.commandId,
                scope: pending.scope,
                eventSequence: toSafeSequence(eventSequence),
                occurredAt: now,
                idempotentReplay: false,
              },
              activeLobbyEvent,
              participantPrivateEvents,
            } as const;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 10_000,
          },
        ),
      this.retryOptions,
    );
  }
}

export function createPrismaRoundCommandExecutor(
  prisma: GeneratedPrismaClient,
  retryOptions: TransactionRetryOptions,
  options: RoundCommandRuntimeOptions | undefined,
): RoundCommandExecutor {
  if (
    options !== undefined &&
    (!Number.isSafeInteger(options.coWinnerWindowMs) || options.coWinnerWindowMs < 1)
  ) {
    throw new RangeError("The co-winner window duration must be a positive safe integer.");
  }
  return new PrismaRoundCommandExecutor(prisma, retryOptions, options);
}
