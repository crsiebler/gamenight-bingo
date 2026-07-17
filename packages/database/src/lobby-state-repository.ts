import { PrismaPg } from "@prisma/adapter-pg";
import { normalizeUsername, type UsernameNormalizationResult } from "@gamenight-bingo/domain";

import {
  Prisma,
  PrismaClient,
  type CallMode as DatabaseCallMode,
  type DeliveryScope as DatabaseDeliveryScope,
  type LobbyStatus as DatabaseLobbyStatus,
  type ParticipantRole as DatabaseParticipantRole,
  type PauseReason as DatabasePauseReason,
  type PresenceStatus as DatabasePresenceStatus,
  type PrismaClient as GeneratedPrismaClient,
  type RoundEligibility as DatabaseRoundEligibility,
  type RoundStage as DatabaseRoundStage,
  type SessionStatus as DatabaseSessionStatus,
} from "../generated/prisma/client.js";
import { runTransactionWithRetry, type TransactionRetryOptions } from "./transaction-retry.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type LobbyStatus = "waiting" | "active" | "completed" | "abandoned";
export type ParticipantRole = "host" | "player";
export type RoundEligibility = "playing" | "waiting";
export type SessionStatus = "active" | "disconnected" | "departed";
export type PresenceStatus = "connected" | "grace" | "absent" | "departed";
export type RoundStage = "waiting" | "active" | "paused" | "co-winner-window" | "result" | "ended";
export type CallMode = "manual" | "automatic";
export type PauseReason = "host-command" | "host-absent" | "participant-absent";
export type DeliveryScope = "active-lobby" | "participant-private";

export interface DurableLobby {
  readonly id: string;
  readonly code: string;
  readonly status: LobbyStatus;
  readonly themeId: string;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly endedAt?: Date | null;
  readonly lastEventSequence: bigint;
}

export interface DurableParticipant {
  readonly id: string;
  readonly username: string;
  readonly normalizedUsername: string;
  readonly role: ParticipantRole;
  readonly roundEligibility: RoundEligibility;
  readonly joinedAt: Date;
  readonly departedAt: Date | null;
}

export interface DurableParticipantSession {
  readonly id: string;
  readonly participantId: string;
  readonly tokenHash: Uint8Array;
  readonly status: SessionStatus;
  readonly issuedAt: Date;
  readonly disconnectedAt: Date | null;
  readonly rejoinUntil: Date | null;
  readonly departedAt: Date | null;
}

export interface DurablePresenceGeneration {
  readonly participantId: string;
  readonly generation: bigint;
  readonly status: PresenceStatus;
  readonly connectionCount: number;
  readonly changedAt: Date;
  readonly graceEndsAt: Date | null;
  readonly absentSince: Date | null;
  readonly departedAt: Date | null;
  readonly overridden: boolean;
  readonly endedAt: Date | null;
}

export interface DurableMark {
  readonly id: string;
  readonly ball: number;
  readonly markedAt: Date;
}

export interface DurableCard {
  readonly id: string;
  readonly participantId: string;
  readonly cells: readonly number[];
  readonly createdAt: Date;
  readonly marks: readonly DurableMark[];
}

export interface DurableDrawPosition {
  readonly position: number;
  readonly ball: number;
}

export interface DurableCall {
  readonly id: string;
  readonly position: number;
  readonly ball: number;
  readonly calledAt: Date;
}

export interface DurableCoWinner {
  readonly participantId: string;
  readonly cardId: string;
  readonly triggeringCallId: string;
  readonly confirmedAt: Date;
}

export interface DurableRoundState {
  readonly id: string;
  readonly initialPatternId: string;
  readonly currentPatternId: string;
  readonly stage: RoundStage;
  readonly callMode: CallMode;
  readonly callIntervalSeconds: number | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly activeAt: Date | null;
  readonly pausedAt: Date | null;
  readonly pauseReason: PauseReason | null;
  readonly nextCallAt: Date | null;
  readonly coWinnerTriggeringCallId: string | null;
  readonly coWinnerOpenedAt: Date | null;
  readonly coWinnerClosesAt: Date | null;
  readonly resultSettledAt: Date | null;
  readonly endedAt: Date | null;
  readonly drawOrder: readonly DurableDrawPosition[];
  readonly cards: readonly DurableCard[];
  readonly calls: readonly DurableCall[];
  readonly coWinners: readonly DurableCoWinner[];
}

export interface DurableActiveLobbyEvent {
  readonly sequence: bigint;
  readonly roundId: string | null;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly payload: JsonObject;
  readonly createdAt: Date;
}

export interface DurableCommandResult<Result extends JsonObject = JsonObject> {
  readonly participantId: string;
  readonly commandId: string;
  readonly roundId: string | null;
  readonly commandType: string;
  readonly deliveryScope: DeliveryScope;
  readonly eventSequence: bigint | null;
  readonly result: Result;
  readonly createdAt: Date;
}

export interface DurableLobbyState {
  readonly lobby: DurableLobby;
  readonly participants: readonly DurableParticipant[];
  readonly sessions: readonly DurableParticipantSession[];
  readonly presenceGenerations: readonly DurablePresenceGeneration[];
  readonly round: DurableRoundState | null;
  readonly events: readonly DurableActiveLobbyEvent[];
  readonly commandResults: readonly DurableCommandResult[];
}

export type NewActiveLobbyState = Omit<DurableLobbyState, "lobby"> & {
  readonly lobby: Omit<DurableLobby, "code" | "status"> & {
    readonly status: "waiting" | "active";
  };
};

export interface CreateActiveLobbyOptions {
  readonly maxActiveLobbies: number;
  readonly nextCode: () => string;
}

export interface NewLobbyParticipant {
  readonly id: string;
  readonly lobbyId: string;
  readonly username: string;
  readonly role: "player";
  readonly roundEligibility: RoundEligibility;
  readonly joinedAt: Date;
}

export interface NewParticipantSession {
  readonly id: string;
  readonly lobbyId: string;
  readonly participantId: string;
  readonly tokenHash: Uint8Array;
  readonly issuedAt: Date;
}

export interface RecognizedParticipantSession {
  readonly sessionId: string;
  readonly lobbyId: string;
  readonly participantId: string;
  readonly username: string;
  readonly role: ParticipantRole;
  readonly status: "active" | "disconnected";
}

export type CreateParticipantSessionResult = "created" | "scope-not-found" | "token-hash-collision";

export interface ReserveParticipantOptions {
  readonly maxPlayersPerLobby: number;
}

export type ReserveParticipantResult =
  | {
      readonly ok: true;
      readonly participantId: string;
    }
  | {
      readonly ok: false;
      readonly error:
        | Extract<UsernameNormalizationResult, { readonly ok: false }>["error"]
        | {
            readonly code: "LOBBY_FULL";
            readonly message: "The lobby is full.";
          }
        | {
            readonly code: "USERNAME_TAKEN";
            readonly message: "That username is already in use.";
          }
        | {
            readonly code: "LOBBY_NOT_FOUND";
            readonly message: "The active lobby was not found.";
          };
    };

export type CreateActiveLobbyResult =
  | {
      readonly ok: true;
      readonly lobbyId: string;
      readonly code: string;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "ACTIVE_LOBBY_LIMIT_REACHED";
        readonly message: "The active lobby limit has been reached.";
      };
    };

export interface LobbyStateRepository {
  createActive(
    state: NewActiveLobbyState,
    options: CreateActiveLobbyOptions,
  ): Promise<CreateActiveLobbyResult>;
  reserveParticipant(
    participant: NewLobbyParticipant,
    options: ReserveParticipantOptions,
  ): Promise<ReserveParticipantResult>;
  createParticipantSession(session: NewParticipantSession): Promise<CreateParticipantSessionResult>;
  findById(lobbyId: string): Promise<DurableLobbyState | null>;
  findActiveLobbyIdByCode(code: string): Promise<string | null>;
  findParticipantSessionByTokenHash(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<RecognizedParticipantSession | null>;
}

export interface CommandTransactionRequest<Result extends JsonObject = JsonObject> {
  readonly lobbyId: string;
  readonly participantId: string;
  readonly commandId: string;
  readonly commandType: string;
  readonly roundId: string | null;
  readonly createdAt: Date;
  readonly decodeResult: (result: JsonObject) => Result;
}

export class CommandReplayMismatchError extends Error {
  constructor() {
    super("Command ID is already committed for a different command scope.");
    this.name = "CommandReplayMismatchError";
  }
}

export interface TransactionalLobbyRepository {
  recordActivity(activityAt: Date): Promise<void>;
}

export interface CommandTransactionRepositories {
  readonly lobbies: TransactionalLobbyRepository;
}

export interface PendingActiveLobbyEvent {
  readonly roundId: string | null;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly payload: JsonObject;
  readonly createdAt: Date;
}

export type PendingCommandCommit<Result extends JsonObject> =
  | {
      readonly deliveryScope: "active-lobby";
      readonly result: Result;
      readonly event: PendingActiveLobbyEvent;
    }
  | {
      readonly deliveryScope: "participant-private";
      readonly result: Result;
      readonly event?: never;
    };

export interface CommittedCommand<Result extends JsonObject> {
  readonly commandResult: DurableCommandResult<Result>;
  readonly committedEvent: DurableActiveLobbyEvent | null;
  readonly idempotentReplay: boolean;
}

export interface CommandTransactionRepository {
  /** The callback may run again after a rolled-back conflict and must not perform external effects. */
  execute<Result extends JsonObject>(
    request: CommandTransactionRequest<Result>,
    mutate: (repositories: CommandTransactionRepositories) => Promise<PendingCommandCommit<Result>>,
  ): Promise<CommittedCommand<Result>>;
}

export interface DatabaseConnectionOptions {
  readonly transactionRetry?: TransactionRetryOptions;
}

export interface DatabaseConnection {
  readonly lobbyStates: LobbyStateRepository;
  readonly commandTransactions: CommandTransactionRepository;
  disconnect(): Promise<void>;
}

function defineEnumMapping<ApplicationValue extends string, DatabaseValue extends string>(
  values: Readonly<Record<ApplicationValue, DatabaseValue>>,
) {
  const applicationValues = new Map<DatabaseValue, ApplicationValue>();
  for (const [applicationValue, databaseValue] of Object.entries(values)) {
    applicationValues.set(databaseValue as DatabaseValue, applicationValue as ApplicationValue);
  }

  return {
    toDatabase(value: ApplicationValue): DatabaseValue {
      return values[value];
    },
    fromDatabase(value: DatabaseValue): ApplicationValue {
      const applicationValue = applicationValues.get(value);
      if (applicationValue === undefined) {
        throw new TypeError(`Unsupported persisted enum value: ${value}`);
      }
      return applicationValue;
    },
  };
}

const lobbyStatuses = defineEnumMapping<LobbyStatus, DatabaseLobbyStatus>({
  waiting: "WAITING",
  active: "ACTIVE",
  completed: "COMPLETED",
  abandoned: "ABANDONED",
});
const participantRoles = defineEnumMapping<ParticipantRole, DatabaseParticipantRole>({
  host: "HOST",
  player: "PLAYER",
});
const roundEligibilities = defineEnumMapping<RoundEligibility, DatabaseRoundEligibility>({
  playing: "PLAYING",
  waiting: "WAITING",
});
const sessionStatuses = defineEnumMapping<SessionStatus, DatabaseSessionStatus>({
  active: "ACTIVE",
  disconnected: "DISCONNECTED",
  departed: "DEPARTED",
});
const presenceStatuses = defineEnumMapping<PresenceStatus, DatabasePresenceStatus>({
  connected: "CONNECTED",
  grace: "GRACE",
  absent: "ABSENT",
  departed: "DEPARTED",
});
const roundStages = defineEnumMapping<RoundStage, DatabaseRoundStage>({
  waiting: "WAITING",
  active: "ACTIVE",
  paused: "PAUSED",
  "co-winner-window": "CO_WINNER_WINDOW",
  result: "RESULT",
  ended: "ENDED",
});
const callModes = defineEnumMapping<CallMode, DatabaseCallMode>({
  manual: "MANUAL",
  automatic: "AUTOMATIC",
});
const pauseReasons = defineEnumMapping<PauseReason, DatabasePauseReason>({
  "host-command": "HOST_COMMAND",
  "host-absent": "HOST_ABSENT",
  "participant-absent": "PARTICIPANT_ABSENT",
});
const deliveryScopes = defineEnumMapping<DeliveryScope, DatabaseDeliveryScope>({
  "active-lobby": "ACTIVE_LOBBY",
  "participant-private": "PARTICIPANT_PRIVATE",
});

function toInputJson(value: JsonObject): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

function toJsonObject(value: Prisma.JsonValue): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Persisted event and command payloads must be JSON objects.");
  }
  return value as JsonObject;
}

function isActiveLobbyCodeCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const prismaError = error as { readonly code?: unknown; readonly meta?: unknown };
  if (
    prismaError.code !== "P2002" ||
    typeof prismaError.meta !== "object" ||
    prismaError.meta === null
  ) {
    return false;
  }
  const meta = prismaError.meta as {
    readonly modelName?: unknown;
    readonly driverAdapterError?: unknown;
  };
  if (meta.modelName !== "Lobby") {
    return false;
  }

  const adapterError = meta.driverAdapterError as
    | {
        readonly cause?: {
          readonly constraint?: { readonly fields?: unknown };
        };
      }
    | undefined;
  const fields = adapterError?.cause?.constraint?.fields;
  return Array.isArray(fields) && fields.length === 1 && fields[0] === "code";
}

function isParticipantSessionTokenHashCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const prismaError = error as { readonly code?: unknown; readonly meta?: unknown };
  if (
    prismaError.code !== "P2002" ||
    typeof prismaError.meta !== "object" ||
    prismaError.meta === null
  ) {
    return false;
  }
  const meta = prismaError.meta as {
    readonly modelName?: unknown;
    readonly driverAdapterError?: unknown;
  };
  if (meta.modelName !== "ParticipantSession") {
    return false;
  }

  const adapterError = meta.driverAdapterError as
    | {
        readonly cause?: {
          readonly constraint?: { readonly fields?: unknown };
        };
      }
    | undefined;
  const fields = adapterError?.cause?.constraint?.fields;
  return (
    Array.isArray(fields) &&
    fields.length === 1 &&
    (fields[0] === "tokenHash" || fields[0] === "token_hash")
  );
}

function toDurableCommandResult<Result extends JsonObject>(
  command: {
    readonly participantId: string;
    readonly commandId: string;
    readonly roundId: string | null;
    readonly commandType: string;
    readonly deliveryScope: DatabaseDeliveryScope;
    readonly eventSequence: bigint | null;
    readonly result: Prisma.JsonValue;
    readonly createdAt: Date;
  },
  decodeResult: (result: JsonObject) => Result,
): DurableCommandResult<Result> {
  return {
    participantId: command.participantId,
    commandId: command.commandId,
    roundId: command.roundId,
    commandType: command.commandType,
    deliveryScope: deliveryScopes.fromDatabase(command.deliveryScope),
    eventSequence: command.eventSequence,
    result: decodeResult(toJsonObject(command.result)),
    createdAt: command.createdAt,
  };
}

function assertAggregate(state: DurableLobbyState): void {
  const participantIds = new Set(state.participants.map((participant) => participant.id));
  const hosts = state.participants.filter((participant) => participant.role === "host");
  if (hosts.length !== 1) {
    throw new RangeError("A durable lobby state must contain exactly one host.");
  }
  if (
    state.sessions.some((session) => !participantIds.has(session.participantId)) ||
    state.presenceGenerations.some(
      (presenceGeneration) => !participantIds.has(presenceGeneration.participantId),
    ) ||
    state.round?.cards.some((card) => !participantIds.has(card.participantId)) === true
  ) {
    throw new RangeError("Sessions and presence generations must belong to lobby participants.");
  }

  if (state.round === null) {
    if (state.events.some((event) => event.roundId !== null)) {
      throw new RangeError("Round-scoped events require a current round.");
    }
    return;
  }

  const drawPositions = new Set(state.round.drawOrder.map((draw) => draw.position));
  const drawBalls = new Set(state.round.drawOrder.map((draw) => draw.ball));
  if (
    state.round.drawOrder.length !== 75 ||
    drawPositions.size !== 75 ||
    drawBalls.size !== 75 ||
    [...drawPositions].some((position) => position < 1 || position > 75) ||
    [...drawBalls].some((ball) => ball < 1 || ball > 75)
  ) {
    throw new RangeError("A durable round draw order must be a complete 1-75 permutation.");
  }
}

class PrismaLobbyStateRepository implements LobbyStateRepository {
  constructor(
    private readonly prisma: GeneratedPrismaClient,
    private readonly retryOptions: TransactionRetryOptions,
  ) {}

  private async insert(
    transaction: Prisma.TransactionClient,
    state: DurableLobbyState,
  ): Promise<void> {
    assertAggregate(state);

    await transaction.lobby.create({
      data: {
        id: state.lobby.id,
        code: state.lobby.code,
        status: lobbyStatuses.toDatabase(state.lobby.status),
        themeId: state.lobby.themeId,
        createdAt: state.lobby.createdAt,
        lastActivityAt: state.lobby.lastActivityAt,
        endedAt: state.lobby.endedAt ?? null,
        lastEventSequence: state.lobby.lastEventSequence,
      },
    });

    await transaction.participant.createMany({
      data: state.participants.map((participant) => ({
        id: participant.id,
        lobbyId: state.lobby.id,
        username: participant.username,
        normalizedUsername: participant.normalizedUsername,
        role: participantRoles.toDatabase(participant.role),
        roundEligibility: roundEligibilities.toDatabase(participant.roundEligibility),
        joinedAt: participant.joinedAt,
        departedAt: participant.departedAt,
      })),
    });

    await transaction.participantSession.createMany({
      data: state.sessions.map((session) => ({
        id: session.id,
        lobbyId: state.lobby.id,
        participantId: session.participantId,
        tokenHash: new Uint8Array(session.tokenHash),
        status: sessionStatuses.toDatabase(session.status),
        issuedAt: session.issuedAt,
        disconnectedAt: session.disconnectedAt,
        rejoinUntil: session.rejoinUntil,
        departedAt: session.departedAt,
      })),
    });

    await transaction.presenceGeneration.createMany({
      data: state.presenceGenerations.map((presence) => ({
        lobbyId: state.lobby.id,
        participantId: presence.participantId,
        generation: presence.generation,
        status: presenceStatuses.toDatabase(presence.status),
        connectionCount: presence.connectionCount,
        changedAt: presence.changedAt,
        graceEndsAt: presence.graceEndsAt,
        absentSince: presence.absentSince,
        departedAt: presence.departedAt,
        overridden: presence.overridden,
        endedAt: presence.endedAt,
      })),
    });

    if (state.round !== null) {
      const round = state.round;
      await transaction.round.create({
        data: {
          id: round.id,
          lobbyId: state.lobby.id,
          initialPatternId: round.initialPatternId,
          currentPatternId: round.currentPatternId,
          stage: roundStages.toDatabase(round.stage),
          callMode: callModes.toDatabase(round.callMode),
          callIntervalSeconds: round.callIntervalSeconds,
          createdAt: round.createdAt,
          startedAt: round.startedAt,
          activeAt: round.activeAt,
          pausedAt: round.pausedAt,
          pauseReason:
            round.pauseReason === null ? null : pauseReasons.toDatabase(round.pauseReason),
          nextCallAt: round.nextCallAt,
          coWinnerTriggeringCallId: round.coWinnerTriggeringCallId,
          coWinnerOpenedAt: round.coWinnerOpenedAt,
          coWinnerClosesAt: round.coWinnerClosesAt,
          resultSettledAt: round.resultSettledAt,
          endedAt: round.endedAt,
        },
      });

      await transaction.drawPosition.createMany({
        data: round.drawOrder.map((draw) => ({
          roundId: round.id,
          position: draw.position,
          ball: draw.ball,
        })),
      });
      await transaction.card.createMany({
        data: round.cards.map((card) => ({
          id: card.id,
          lobbyId: state.lobby.id,
          roundId: round.id,
          participantId: card.participantId,
          cells: [...card.cells],
          createdAt: card.createdAt,
        })),
      });
      await transaction.call.createMany({
        data: round.calls.map((call) => ({
          id: call.id,
          roundId: round.id,
          position: call.position,
          ball: call.ball,
          calledAt: call.calledAt,
        })),
      });
      await transaction.mark.createMany({
        data: round.cards.flatMap((card) =>
          card.marks.map((mark) => ({
            id: mark.id,
            roundId: round.id,
            cardId: card.id,
            ball: mark.ball,
            markedAt: mark.markedAt,
          })),
        ),
      });
      await transaction.coWinner.createMany({
        data: round.coWinners.map((winner) => ({
          lobbyId: state.lobby.id,
          roundId: round.id,
          participantId: winner.participantId,
          cardId: winner.cardId,
          triggeringCallId: winner.triggeringCallId,
          confirmedAt: winner.confirmedAt,
        })),
      });
    }

    await transaction.activeLobbyEvent.createMany({
      data: state.events.map((event) => ({
        lobbyId: state.lobby.id,
        sequence: event.sequence,
        roundId: event.roundId,
        eventType: event.eventType,
        schemaVersion: event.schemaVersion,
        payload: toInputJson(event.payload),
        createdAt: event.createdAt,
      })),
    });
    await transaction.commandResult.createMany({
      data: state.commandResults.map((command) => ({
        lobbyId: state.lobby.id,
        participantId: command.participantId,
        commandId: command.commandId,
        roundId: command.roundId,
        commandType: command.commandType,
        deliveryScope: deliveryScopes.toDatabase(command.deliveryScope),
        eventSequence: command.eventSequence,
        result: toInputJson(command.result),
        createdAt: command.createdAt,
      })),
    });
  }

  async createActive(
    state: NewActiveLobbyState,
    options: CreateActiveLobbyOptions,
  ): Promise<CreateActiveLobbyResult> {
    if (!Number.isSafeInteger(options.maxActiveLobbies) || options.maxActiveLobbies < 1) {
      throw new RangeError("The active lobby limit must be a positive safe integer.");
    }

    for (let attempt = 0; attempt < 128; attempt += 1) {
      const code = options.nextCode();
      if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
        throw new RangeError(
          "Generated lobby codes must use the canonical six-character alphabet.",
        );
      }

      let result: "collision" | "created" | "limit-reached";
      try {
        result = await runTransactionWithRetry(
          async () =>
            this.prisma.$transaction(
              async (transaction) => {
                // There is no parent row to lock before the first lobby, so admissions share one lock.
                await transaction.$queryRaw`
                  SELECT pg_advisory_xact_lock(17742, 23001)::text AS "lock"
                `;

                const activeLobbyCount = await transaction.lobby.count({
                  where: { status: { in: ["WAITING", "ACTIVE"] } },
                });
                if (activeLobbyCount >= options.maxActiveLobbies) {
                  return "limit-reached" as const;
                }

                const collision = await transaction.lobby.findFirst({
                  where: {
                    code,
                    status: { in: ["WAITING", "ACTIVE"] },
                  },
                  select: { id: true },
                });
                if (collision !== null) {
                  return "collision" as const;
                }

                await this.insert(transaction, {
                  ...state,
                  lobby: { ...state.lobby, code },
                });
                return "created" as const;
              },
              {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                maxWait: 5_000,
                timeout: 10_000,
              },
            ),
          this.retryOptions,
        );
      } catch (error) {
        if (isActiveLobbyCodeCollision(error)) {
          continue;
        }
        throw error;
      }

      if (result === "collision") {
        continue;
      }
      if (result === "limit-reached") {
        return {
          ok: false,
          error: {
            code: "ACTIVE_LOBBY_LIMIT_REACHED",
            message: "The active lobby limit has been reached.",
          },
        };
      }
      return { ok: true, lobbyId: state.lobby.id, code };
    }

    throw new Error("Unable to generate a unique active lobby code.");
  }

  async reserveParticipant(
    participant: NewLobbyParticipant,
    options: ReserveParticipantOptions,
  ): Promise<ReserveParticipantResult> {
    if (
      !Number.isSafeInteger(options.maxPlayersPerLobby) ||
      options.maxPlayersPerLobby < 1 ||
      options.maxPlayersPerLobby > 25
    ) {
      throw new RangeError("The participant limit must be a safe integer between 1 and 25.");
    }

    const normalized = normalizeUsername(participant.username);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error };
    }

    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const lobbies = await transaction.$queryRaw<readonly { id: string }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence"
               WHERE "id" = ${participant.lobbyId}
                 AND "status" IN ('WAITING', 'ACTIVE')
               RETURNING "id"
            `;
            if (lobbies.length !== 1) {
              return {
                ok: false,
                error: {
                  code: "LOBBY_NOT_FOUND",
                  message: "The active lobby was not found.",
                },
              } as const;
            }

            const existing = await transaction.participant.findUnique({
              where: {
                lobbyId_normalizedUsername: {
                  lobbyId: participant.lobbyId,
                  normalizedUsername: normalized.normalizedUsername,
                },
              },
              select: { id: true },
            });
            if (existing !== null) {
              return {
                ok: false,
                error: {
                  code: "USERNAME_TAKEN",
                  message: "That username is already in use.",
                },
              } as const;
            }

            const participantCount = await transaction.participant.count({
              where: { lobbyId: participant.lobbyId },
            });
            if (participantCount >= options.maxPlayersPerLobby) {
              return {
                ok: false,
                error: {
                  code: "LOBBY_FULL",
                  message: "The lobby is full.",
                },
              } as const;
            }

            await transaction.participant.create({
              data: {
                id: participant.id,
                lobbyId: participant.lobbyId,
                username: normalized.username,
                normalizedUsername: normalized.normalizedUsername,
                role: "PLAYER",
                roundEligibility: roundEligibilities.toDatabase(participant.roundEligibility),
                joinedAt: participant.joinedAt,
                departedAt: null,
              },
            });
            return { ok: true, participantId: participant.id } as const;
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

  async createParticipantSession(
    session: NewParticipantSession,
  ): Promise<CreateParticipantSessionResult> {
    if (session.tokenHash.length !== 32) {
      throw new RangeError("Participant session token hashes must contain exactly 32 bytes.");
    }

    try {
      return await runTransactionWithRetry(
        async () =>
          this.prisma.$transaction(
            async (transaction) => {
              const participant = await transaction.participant.findFirst({
                where: {
                  id: session.participantId,
                  lobbyId: session.lobbyId,
                  departedAt: null,
                  lobby: { status: { in: ["WAITING", "ACTIVE"] } },
                },
                select: { id: true },
              });
              if (participant === null) {
                return "scope-not-found" as const;
              }

              await transaction.participantSession.create({
                data: {
                  id: session.id,
                  lobbyId: session.lobbyId,
                  participantId: session.participantId,
                  tokenHash: new Uint8Array(session.tokenHash),
                  status: "ACTIVE",
                  issuedAt: session.issuedAt,
                  disconnectedAt: null,
                  rejoinUntil: null,
                  departedAt: null,
                },
              });
              return "created" as const;
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 5_000,
              timeout: 10_000,
            },
          ),
        this.retryOptions,
      );
    } catch (error) {
      if (isParticipantSessionTokenHashCollision(error)) {
        return "token-hash-collision";
      }
      throw error;
    }
  }

  async findById(lobbyId: string): Promise<DurableLobbyState | null> {
    const lobby = await this.prisma.lobby.findUnique({
      where: { id: lobbyId },
      include: {
        participants: { orderBy: { id: "asc" } },
        participantSessions: { orderBy: { id: "asc" } },
        presenceGenerations: { orderBy: [{ participantId: "asc" }, { generation: "asc" }] },
        currentRound: {
          include: {
            drawPositions: { orderBy: { position: "asc" } },
            cards: { include: { marks: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" } },
            calls: { orderBy: { position: "asc" } },
            coWinners: { orderBy: { participantId: "asc" } },
          },
        },
        activeLobbyEvents: { orderBy: { sequence: "asc" } },
        commandResults: {
          orderBy: [{ participantId: "asc" }, { commandId: "asc" }],
        },
      },
    });

    if (lobby === null) {
      return null;
    }

    return {
      lobby: {
        id: lobby.id,
        code: lobby.code,
        status: lobbyStatuses.fromDatabase(lobby.status),
        themeId: lobby.themeId,
        createdAt: lobby.createdAt,
        lastActivityAt: lobby.lastActivityAt,
        endedAt: lobby.endedAt,
        lastEventSequence: lobby.lastEventSequence,
      },
      participants: lobby.participants.map((participant) => ({
        id: participant.id,
        username: participant.username,
        normalizedUsername: participant.normalizedUsername,
        role: participantRoles.fromDatabase(participant.role),
        roundEligibility: roundEligibilities.fromDatabase(participant.roundEligibility),
        joinedAt: participant.joinedAt,
        departedAt: participant.departedAt,
      })),
      sessions: lobby.participantSessions.map((session) => ({
        id: session.id,
        participantId: session.participantId,
        tokenHash: session.tokenHash,
        status: sessionStatuses.fromDatabase(session.status),
        issuedAt: session.issuedAt,
        disconnectedAt: session.disconnectedAt,
        rejoinUntil: session.rejoinUntil,
        departedAt: session.departedAt,
      })),
      presenceGenerations: lobby.presenceGenerations.map((presence) => ({
        participantId: presence.participantId,
        generation: presence.generation,
        status: presenceStatuses.fromDatabase(presence.status),
        connectionCount: presence.connectionCount,
        changedAt: presence.changedAt,
        graceEndsAt: presence.graceEndsAt,
        absentSince: presence.absentSince,
        departedAt: presence.departedAt,
        overridden: presence.overridden,
        endedAt: presence.endedAt,
      })),
      round:
        lobby.currentRound === null
          ? null
          : {
              id: lobby.currentRound.id,
              initialPatternId: lobby.currentRound.initialPatternId,
              currentPatternId: lobby.currentRound.currentPatternId,
              stage: roundStages.fromDatabase(lobby.currentRound.stage),
              callMode: callModes.fromDatabase(lobby.currentRound.callMode),
              callIntervalSeconds: lobby.currentRound.callIntervalSeconds,
              createdAt: lobby.currentRound.createdAt,
              startedAt: lobby.currentRound.startedAt,
              activeAt: lobby.currentRound.activeAt,
              pausedAt: lobby.currentRound.pausedAt,
              pauseReason:
                lobby.currentRound.pauseReason === null
                  ? null
                  : pauseReasons.fromDatabase(lobby.currentRound.pauseReason),
              nextCallAt: lobby.currentRound.nextCallAt,
              coWinnerTriggeringCallId: lobby.currentRound.coWinnerTriggeringCallId,
              coWinnerOpenedAt: lobby.currentRound.coWinnerOpenedAt,
              coWinnerClosesAt: lobby.currentRound.coWinnerClosesAt,
              resultSettledAt: lobby.currentRound.resultSettledAt,
              endedAt: lobby.currentRound.endedAt,
              drawOrder: lobby.currentRound.drawPositions.map((draw) => ({
                position: draw.position,
                ball: draw.ball,
              })),
              cards: lobby.currentRound.cards.map((card) => ({
                id: card.id,
                participantId: card.participantId,
                cells: card.cells,
                createdAt: card.createdAt,
                marks: card.marks.map((mark) => ({
                  id: mark.id,
                  ball: mark.ball,
                  markedAt: mark.markedAt,
                })),
              })),
              calls: lobby.currentRound.calls.map((call) => ({
                id: call.id,
                position: call.position,
                ball: call.ball,
                calledAt: call.calledAt,
              })),
              coWinners: lobby.currentRound.coWinners.map((winner) => ({
                participantId: winner.participantId,
                cardId: winner.cardId,
                triggeringCallId: winner.triggeringCallId,
                confirmedAt: winner.confirmedAt,
              })),
            },
      events: lobby.activeLobbyEvents.map((event) => ({
        sequence: event.sequence,
        roundId: event.roundId,
        eventType: event.eventType,
        schemaVersion: event.schemaVersion,
        payload: toJsonObject(event.payload),
        createdAt: event.createdAt,
      })),
      commandResults: lobby.commandResults.map((command) => ({
        participantId: command.participantId,
        commandId: command.commandId,
        roundId: command.roundId,
        commandType: command.commandType,
        deliveryScope: deliveryScopes.fromDatabase(command.deliveryScope),
        eventSequence: command.eventSequence,
        result: toJsonObject(command.result),
        createdAt: command.createdAt,
      })),
    };
  }

  async findActiveLobbyIdByCode(code: string): Promise<string | null> {
    const lobby = await this.prisma.lobby.findFirst({
      where: {
        code,
        status: { in: ["WAITING", "ACTIVE"] },
      },
      select: { id: true },
    });

    return lobby?.id ?? null;
  }

  async findParticipantSessionByTokenHash(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<RecognizedParticipantSession | null> {
    if (input.tokenHash.length !== 32) {
      throw new RangeError("Participant session token hashes must contain exactly 32 bytes.");
    }

    const session = await this.prisma.participantSession.findFirst({
      where: {
        lobbyId: input.lobbyId,
        tokenHash: new Uint8Array(input.tokenHash),
        status: { in: ["ACTIVE", "DISCONNECTED"] },
        lobby: { status: { in: ["WAITING", "ACTIVE"] } },
        participant: { departedAt: null },
      },
      select: {
        id: true,
        lobbyId: true,
        participantId: true,
        status: true,
        participant: { select: { username: true, role: true } },
      },
    });
    if (session === null || session.status === "DEPARTED") {
      return null;
    }

    return {
      sessionId: session.id,
      lobbyId: session.lobbyId,
      participantId: session.participantId,
      username: session.participant.username,
      role: participantRoles.fromDatabase(session.participant.role),
      status: session.status === "ACTIVE" ? "active" : "disconnected",
    };
  }
}

class PrismaTransactionalLobbyRepository implements TransactionalLobbyRepository {
  constructor(
    private readonly transaction: Prisma.TransactionClient,
    private readonly lobbyId: string,
  ) {}

  async recordActivity(activityAt: Date): Promise<void> {
    const updated = await this.transaction.$executeRaw`
      UPDATE "lobbies"
         SET "last_activity_at" = GREATEST("last_activity_at", ${activityAt})
       WHERE "id" = ${this.lobbyId}
    `;
    if (updated !== 1) {
      throw new Error("Cannot record activity for an unknown lobby.");
    }
  }
}

class PrismaCommandTransactionRepository implements CommandTransactionRepository {
  constructor(
    private readonly prisma: GeneratedPrismaClient,
    private readonly retryOptions: TransactionRetryOptions,
  ) {}

  async execute<Result extends JsonObject>(
    request: CommandTransactionRequest<Result>,
    mutate: (repositories: CommandTransactionRepositories) => Promise<PendingCommandCommit<Result>>,
  ): Promise<CommittedCommand<Result>> {
    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const lockedLobbies = await transaction.$queryRaw<readonly { id: string }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence"
               WHERE "id" = ${request.lobbyId}
               RETURNING "id"
            `;
            if (lockedLobbies.length !== 1) {
              throw new Error("Cannot execute a command for an unknown lobby.");
            }

            const existing = await transaction.commandResult.findUnique({
              where: {
                lobbyId_participantId_commandId: {
                  lobbyId: request.lobbyId,
                  participantId: request.participantId,
                  commandId: request.commandId,
                },
              },
            });
            if (existing !== null) {
              if (
                existing.commandType !== request.commandType ||
                existing.roundId !== request.roundId
              ) {
                throw new CommandReplayMismatchError();
              }
              return {
                commandResult: toDurableCommandResult(existing, request.decodeResult),
                committedEvent: null,
                idempotentReplay: true,
              };
            }

            const pending = await mutate({
              lobbies: new PrismaTransactionalLobbyRepository(transaction, request.lobbyId),
            });
            const validatedResult = request.decodeResult(pending.result);

            let eventSequence: bigint | null = null;
            let committedEvent: DurableActiveLobbyEvent | null = null;
            if (pending.deliveryScope === "active-lobby") {
              if (pending.event.roundId !== request.roundId) {
                throw new RangeError("A command event must use the command's round scope.");
              }
              const sequenceRows = await transaction.$queryRaw<readonly { sequence: bigint }[]>`
                UPDATE "lobbies"
                   SET "last_event_sequence" = "last_event_sequence" + 1
                 WHERE "id" = ${request.lobbyId}
                 RETURNING "last_event_sequence" AS "sequence"
              `;
              const sequence = sequenceRows[0]?.sequence;
              if (sequence === undefined) {
                throw new Error("Cannot allocate an event sequence for an unknown lobby.");
              }
              eventSequence = sequence;
              committedEvent = {
                sequence,
                roundId: pending.event.roundId,
                eventType: pending.event.eventType,
                schemaVersion: pending.event.schemaVersion,
                payload: pending.event.payload,
                createdAt: pending.event.createdAt,
              };
              await transaction.activeLobbyEvent.create({
                data: {
                  lobbyId: request.lobbyId,
                  sequence,
                  roundId: pending.event.roundId,
                  eventType: pending.event.eventType,
                  schemaVersion: pending.event.schemaVersion,
                  payload: toInputJson(pending.event.payload),
                  createdAt: pending.event.createdAt,
                },
              });
            }

            const storedCommand = await transaction.commandResult.create({
              data: {
                lobbyId: request.lobbyId,
                participantId: request.participantId,
                commandId: request.commandId,
                roundId: request.roundId,
                commandType: request.commandType,
                deliveryScope: deliveryScopes.toDatabase(pending.deliveryScope),
                eventSequence,
                result: toInputJson(validatedResult),
                createdAt: request.createdAt,
              },
            });

            return {
              commandResult: toDurableCommandResult(storedCommand, request.decodeResult),
              committedEvent,
              idempotentReplay: false,
            };
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

export async function connectDatabase(
  connectionString: string,
  options: DatabaseConnectionOptions = {},
): Promise<DatabaseConnection> {
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();

  return {
    lobbyStates: new PrismaLobbyStateRepository(prisma, options.transactionRetry ?? {}),
    commandTransactions: new PrismaCommandTransactionRepository(
      prisma,
      options.transactionRetry ?? {},
    ),
    async disconnect() {
      await prisma.$disconnect();
    },
  };
}
