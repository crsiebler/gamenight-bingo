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

export interface RoundCommandPattern {
  readonly id: string;
  readonly mode: RoundPatternMode;
}

export interface RoundCommandRuntimeOptions {
  readonly patterns: readonly RoundCommandPattern[];
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

export type RoundCommandExecutionResult =
  | {
      readonly ok: true;
      readonly acknowledgement: RoundCommandAcknowledgement;
      readonly activeLobbyEvent: ActiveLobbyEvent | null;
      readonly participantPrivateEvent: ParticipantPrivateEvent | null;
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
}

type PendingCommand =
  | {
      readonly roundId: string;
      readonly scope: "active-lobby";
      readonly event: {
        readonly type: "stage" | "call" | "round-end";
        readonly payload: Prisma.InputJsonObject;
      };
    }
  | {
      readonly roundId: string;
      readonly scope: "participant-private";
      readonly event: ParticipantPrivateEvent;
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
  patterns: readonly RoundCommandPattern[],
  patternId: string,
): RoundPatternMode | null {
  return patterns.find((pattern) => pattern.id === patternId)?.mode ?? null;
}

function patternModeOrThrow(
  patterns: readonly RoundCommandPattern[],
  patternId: string,
): RoundPatternMode {
  const mode = resolveRoundPatternMode(patterns, patternId);
  if (mode === null) throw new Error("Persisted round references an unknown canonical pattern.");
  return mode;
}

function requireDate(value: Date | null, name: string): Date {
  if (value === null) throw new Error(`${name} is required by the persisted round stage.`);
  return value;
}

function toDomainRound(round: CurrentRound, patterns: readonly RoundCommandPattern[]): RoundState {
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
          ? { ...base, stage: "result", startedAt, result }
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
               "result" = "result" - 'participantPrivateEvent'
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
    const blockingPresence = await transaction.presenceGeneration.findFirst({
      where: {
        lobbyId,
        endedAt: null,
        participant: { departedAt: null },
        OR: [
          { status: "ABSENT", overridden: false },
          { status: "GRACE", graceEndsAt: { lte: now } },
        ],
      },
      select: { participantId: true },
    });
    if (blockingPresence !== null) return null;
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
    const [drawPositions, committedCount] = await Promise.all([
      transaction.drawPosition.findMany({
        where: { roundId: current.id },
        select: { ball: true },
        orderBy: { position: "asc" },
      }),
      transaction.call.count({ where: { roundId: current.id } }),
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
        roundId: current.id,
        position: next.position,
        ball: next.ball,
        calledAt: now,
      },
    });
    await transaction.round.update({
      where: { id: current.id },
      data: { nextCallAt: nextAutomaticCallAt(current, now) },
    });
    return {
      roundId: current.id,
      scope: "active-lobby",
      event: {
        type: "call",
        payload: {
          call: {
            id: callId,
            roundId: current.id,
            position: next.position,
            ball: next.ball,
            calledAt: now.toISOString(),
          },
        },
      },
    };
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
    await transaction.coWinner.deleteMany({ where: { roundId: current.id } });
    await transaction.round.update({
      where: { id: current.id },
      data: {
        currentPatternId: command.patternId,
        stage: "ACTIVE",
        activeAt: now,
        pausedAt: null,
        pauseReason: null,
        nextCallAt: nextAutomaticCallAt(current, now),
        coWinnerTriggeringCallId: null,
        coWinnerOpenedAt: null,
        coWinnerClosesAt: null,
        resultSettledAt: null,
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
    const card = await transaction.card.findUnique({
      where: { roundId_participantId: { roundId: current.id, participantId } },
      select: { id: true, cells: true },
    });
    if (card === null || !card.cells.includes(command.ball)) return null;
    const called = await transaction.call.findUnique({
      where: { roundId_ball: { roundId: current.id, ball: command.ball } },
      select: { id: true },
    });
    if (called === null) return null;
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
    return {
      roundId: current.id,
      scope: "participant-private",
      event: ParticipantPrivateEventSchema.parse({
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
      }),
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
              const participantPrivateEvent =
                scope === "participant-private" && result["participantPrivateEvent"] !== undefined
                  ? ParticipantPrivateEventSchema.parse(result["participantPrivateEvent"])
                  : null;
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
                participantPrivateEvent,
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
            let participantPrivateEvent: ParticipantPrivateEvent | null = null;
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
              participantPrivateEvent = pending.event;
              await transaction.$executeRaw`
                UPDATE "lobbies"
                   SET "last_activity_at" = GREATEST("last_activity_at", ${now})
                 WHERE "id" = ${input.lobbyId}
              `;
            }
            await transaction.commandResult.create({
              data: {
                lobbyId: input.lobbyId,
                participantId,
                commandId: input.command.commandId,
                roundId: pending.roundId,
                commandType: input.command.type,
                deliveryScope:
                  pending.scope === "active-lobby" ? "ACTIVE_LOBBY" : "PARTICIPANT_PRIVATE",
                eventSequence,
                result: {
                  intent: commandIntent(input.command),
                  ...(participantPrivateEvent === null
                    ? {}
                    : {
                        participantPrivateEvent: JSON.parse(
                          JSON.stringify(participantPrivateEvent),
                        ) as Prisma.InputJsonObject,
                      }),
                },
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
              participantPrivateEvent,
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
  return new PrismaRoundCommandExecutor(prisma, retryOptions, options);
}
