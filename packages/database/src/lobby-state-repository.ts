import { PrismaPg } from "@prisma/adapter-pg";
import {
  CONTRACT_SCHEMA_VERSION,
  LobbyEntryResponseSchema,
  SnapshotSchema,
  type Snapshot,
} from "@gamenight-bingo/contracts";
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
  readonly joinedAt: Date;
}

export interface NewParticipantSession {
  readonly id: string;
  readonly lobbyId: string;
  readonly participantId: string;
  readonly tokenHash: Uint8Array;
  readonly issuedAt: Date;
}

interface RecognizedParticipantSessionIdentity {
  readonly sessionId: string;
  readonly lobbyId: string;
  readonly participantId: string;
  readonly username: string;
  readonly role: ParticipantRole;
}

export type RecognizedParticipantSession =
  | (RecognizedParticipantSessionIdentity & {
      readonly status: "active";
    })
  | (RecognizedParticipantSessionIdentity & {
      readonly status: "disconnected";
      readonly disconnectedAt: Date;
      readonly rejoinUntil: Date;
    });

export type CreateParticipantSessionResult = "created" | "scope-not-found" | "token-hash-collision";

export interface IssueRealtimeTicketInput {
  readonly lobbyId: string;
  readonly sessionTokenHash: Uint8Array;
  readonly ticketHash: Uint8Array;
  readonly ttlSeconds: number;
}

export type IssueRealtimeTicketResult =
  | { readonly ok: true; readonly expiresAt: Date }
  | {
      readonly ok: false;
      readonly error: { readonly code: "TICKET_HASH_COLLISION" | "UNAUTHORIZED" };
    };

export interface ConsumedRealtimeTicket {
  readonly lobbyId: string;
  readonly participantId: string;
  readonly participantSessionId: string;
}

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

export interface LobbyEntryRecord {
  readonly commandId: string;
  readonly idempotentReplay: boolean;
  readonly lobbyId: string;
  readonly lobbyCode: string;
  readonly themeId: string;
  readonly participantId: string;
  readonly username: string;
  readonly role: ParticipantRole;
  readonly roundEligibility: RoundEligibility;
  readonly sessionId: string;
  readonly issuedAt: Date;
}

interface NewLobbyEntrySession {
  readonly commandId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly tokenHash: Uint8Array;
  readonly issuedAt: Date;
}

export interface CreateLobbyWithHostInput extends NewLobbyEntrySession {
  readonly lobbyId: string;
  readonly themeId: string;
  readonly maxActiveLobbies: number;
  readonly nextCode: () => string;
}

export interface JoinLobbyWithSessionInput extends NewLobbyEntrySession {
  readonly lobbyId: string;
  readonly lobbyCode: string;
  readonly maxPlayersPerLobby: number;
}

export interface RejoinLobbyWithSessionInput {
  readonly lobbyId: string;
  readonly tokenHash: Uint8Array;
  readonly commandId: string;
}

type LobbyEntryMutationError =
  | Extract<UsernameNormalizationResult, { readonly ok: false }>["error"]
  | {
      readonly code:
        | "ACTIVE_LOBBY_LIMIT_REACHED"
        | "COMMAND_REPLAY_MISMATCH"
        | "LOBBY_FULL"
        | "LOBBY_NOT_FOUND"
        | "TOKEN_HASH_COLLISION"
        | "USERNAME_TAKEN";
      readonly message: string;
    };

export type LobbyEntryMutationResult =
  | { readonly ok: true; readonly entry: LobbyEntryRecord }
  | {
      readonly ok: false;
      readonly error: LobbyEntryMutationError;
    };

export interface LobbyStateRepository {
  createLobbyWithHost(input: CreateLobbyWithHostInput): Promise<LobbyEntryMutationResult>;
  joinLobbyWithSession(input: JoinLobbyWithSessionInput): Promise<LobbyEntryMutationResult>;
  rejoinLobbyWithSession(
    input: RejoinLobbyWithSessionInput,
  ): Promise<LobbyEntryMutationResult | null>;
  createActive(
    state: NewActiveLobbyState,
    options: CreateActiveLobbyOptions,
  ): Promise<CreateActiveLobbyResult>;
  reserveParticipant(
    participant: NewLobbyParticipant,
    options: ReserveParticipantOptions,
  ): Promise<ReserveParticipantResult>;
  createParticipantSession(session: NewParticipantSession): Promise<CreateParticipantSessionResult>;
  issueRealtimeTicket(input: IssueRealtimeTicketInput): Promise<IssueRealtimeTicketResult>;
  consumeRealtimeTicket(input: {
    readonly ticketHash: Uint8Array;
  }): Promise<ConsumedRealtimeTicket | null>;
  expireParticipantRejoinWindows(lobbyId: string): Promise<number>;
  markParticipantSessionDisconnected(input: {
    readonly lobbyId: string;
    readonly sessionId: string;
    readonly reconnectWindowSeconds: number;
  }): Promise<Extract<RecognizedParticipantSession, { readonly status: "disconnected" }> | null>;
  findById(lobbyId: string): Promise<DurableLobbyState | null>;
  findActiveLobbyIdByCode(code: string): Promise<string | null>;
  findAuthorizedSnapshot(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<Snapshot | null>;
  resolveParticipantSessionByTokenHash(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<RecognizedParticipantSession | null>;
  rejoinParticipantSessionByTokenHash(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<Extract<RecognizedParticipantSession, { readonly status: "active" }> | null>;
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
  readonly lifecycleClock?: () => Date;
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

function toPersistedLobbyEntry(entry: LobbyEntryRecord): JsonObject {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    type: "lobby-entry",
    commandId: entry.commandId,
    idempotentReplay: false,
    lobby: { id: entry.lobbyId, code: entry.lobbyCode, themeId: entry.themeId },
    participant: {
      id: entry.participantId,
      username: entry.username,
      role: entry.role,
      roundEligibility: entry.roundEligibility,
    },
    session: {
      id: entry.sessionId,
      status: "active",
      issuedAt: entry.issuedAt.toISOString(),
    },
  };
}

function fromPersistedLobbyEntry(
  value: JsonValue | undefined,
  commandId: string,
): LobbyEntryRecord {
  const entry = LobbyEntryResponseSchema.parse(value);
  if (entry.commandId !== commandId || entry.idempotentReplay) {
    throw new Error("Persisted lobby entry command metadata is inconsistent.");
  }
  return {
    commandId,
    idempotentReplay: true,
    lobbyId: entry.lobby.id,
    lobbyCode: entry.lobby.code,
    themeId: entry.lobby.themeId,
    participantId: entry.participant.id,
    username: entry.participant.username,
    role: entry.participant.role,
    roundEligibility: entry.participant.roundEligibility,
    sessionId: entry.session.id,
    issuedAt: new Date(entry.session.issuedAt),
  };
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${name} must be a valid date.`);
  }
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
    private readonly lifecycleClock: () => Date,
  ) {}

  private currentLifecycleTime(): Date {
    const now = this.lifecycleClock();
    assertValidDate(now, "The participant session lifecycle timestamp");
    return now;
  }

  private async expireDueParticipantSessions(
    transaction: Prisma.TransactionClient,
    lobbyId: string,
    now: Date,
  ): Promise<number> {
    const dueSessions = await transaction.participantSession.findMany({
      where: {
        lobbyId,
        status: "DISCONNECTED",
        rejoinUntil: { lte: now },
        participant: { departedAt: null },
      },
      select: { id: true, participantId: true, rejoinUntil: true },
      orderBy: { rejoinUntil: "asc" },
    });
    const participantDeadlines = new Map<string, Date>();
    for (const session of dueSessions) {
      if (session.rejoinUntil === null) {
        throw new Error("Disconnected participant sessions require a rejoin deadline.");
      }
      await transaction.realtimeTicket.deleteMany({
        where: { participantSessionId: session.id },
      });
      await transaction.participantSession.update({
        where: { id: session.id },
        data: { status: "DEPARTED", departedAt: session.rejoinUntil },
      });
      participantDeadlines.set(session.participantId, session.rejoinUntil);
    }

    let departedParticipants = 0;
    for (const [participantId, departedAt] of participantDeadlines) {
      const validSessions = await transaction.participantSession.count({
        where: {
          lobbyId,
          participantId,
          status: { in: ["ACTIVE", "DISCONNECTED"] },
        },
      });
      if (validSessions !== 0) {
        continue;
      }
      const departed = await transaction.participant.updateMany({
        where: { id: participantId, lobbyId, departedAt: null },
        data: { departedAt },
      });
      departedParticipants += departed.count;
    }
    return departedParticipants;
  }

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

  async createLobbyWithHost(input: CreateLobbyWithHostInput): Promise<LobbyEntryMutationResult> {
    if (!Number.isSafeInteger(input.maxActiveLobbies) || input.maxActiveLobbies < 1) {
      throw new RangeError("The active lobby limit must be a positive safe integer.");
    }
    if (input.tokenHash.length !== 32) {
      throw new RangeError("Participant session token hashes must contain exactly 32 bytes.");
    }
    assertValidDate(input.issuedAt, "The participant session issuance timestamp");
    const normalized = normalizeUsername(input.username);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error };
    }

    for (let attempt = 0; attempt < 128; attempt += 1) {
      const code = input.nextCode();
      if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
        throw new RangeError(
          "Generated lobby codes must use the canonical six-character alphabet.",
        );
      }
      try {
        const result = await runTransactionWithRetry(
          async () =>
            this.prisma.$transaction(
              async (transaction) => {
                await transaction.$queryRaw`
                  SELECT pg_advisory_xact_lock(17742, 23001)::text AS "lock"
                `;
                const prior = await transaction.commandResult.findFirst({
                  where: { commandId: input.commandId, commandType: "create-lobby" },
                  select: {
                    result: true,
                    lobby: { select: { id: true, code: true, status: true, themeId: true } },
                    participant: {
                      select: {
                        id: true,
                        username: true,
                        role: true,
                        roundEligibility: true,
                        departedAt: true,
                      },
                    },
                  },
                });
                if (prior !== null) {
                  const intent = toJsonObject(prior.result);
                  if (
                    intent["normalizedUsername"] !== normalized.normalizedUsername ||
                    intent["themeId"] !== input.themeId
                  ) {
                    return {
                      ok: false,
                      error: {
                        code: "COMMAND_REPLAY_MISMATCH",
                        message:
                          "The command ID was already used for different lobby entry intent.",
                      },
                    } as const;
                  }
                  if (
                    !["WAITING", "ACTIVE"].includes(prior.lobby.status) ||
                    prior.participant.departedAt !== null
                  ) {
                    return {
                      ok: false,
                      error: {
                        code: "LOBBY_NOT_FOUND",
                        message: "The active lobby was not found.",
                      },
                    } as const;
                  }
                  const entry = fromPersistedLobbyEntry(intent["entry"], input.commandId);
                  if (
                    entry.lobbyId !== prior.lobby.id ||
                    entry.participantId !== prior.participant.id
                  ) {
                    throw new Error("Create-lobby command entry scope is inconsistent.");
                  }
                  return { ok: true, entry } as const;
                }

                const activeLobbyCount = await transaction.lobby.count({
                  where: { status: { in: ["WAITING", "ACTIVE"] } },
                });
                if (activeLobbyCount >= input.maxActiveLobbies) {
                  return {
                    ok: false,
                    error: {
                      code: "ACTIVE_LOBBY_LIMIT_REACHED",
                      message: "The active lobby limit has been reached.",
                    },
                  } as const;
                }
                const collision = await transaction.lobby.findFirst({
                  where: { code, status: { in: ["WAITING", "ACTIVE"] } },
                  select: { id: true },
                });
                if (collision !== null) return "collision" as const;

                const entry: LobbyEntryRecord = {
                  commandId: input.commandId,
                  idempotentReplay: false,
                  lobbyId: input.lobbyId,
                  lobbyCode: code,
                  themeId: input.themeId,
                  participantId: input.participantId,
                  username: normalized.username,
                  role: "host",
                  roundEligibility: "playing",
                  sessionId: input.sessionId,
                  issuedAt: input.issuedAt,
                };
                await this.insert(transaction, {
                  lobby: {
                    id: input.lobbyId,
                    code,
                    status: "waiting",
                    themeId: input.themeId,
                    createdAt: input.issuedAt,
                    lastActivityAt: input.issuedAt,
                    endedAt: null,
                    lastEventSequence: 0n,
                  },
                  participants: [
                    {
                      id: input.participantId,
                      username: normalized.username,
                      normalizedUsername: normalized.normalizedUsername,
                      role: "host",
                      roundEligibility: "playing",
                      joinedAt: input.issuedAt,
                      departedAt: null,
                    },
                  ],
                  sessions: [
                    {
                      id: input.sessionId,
                      participantId: input.participantId,
                      tokenHash: input.tokenHash,
                      status: "active",
                      issuedAt: input.issuedAt,
                      disconnectedAt: null,
                      rejoinUntil: null,
                      departedAt: null,
                    },
                  ],
                  presenceGenerations: [
                    {
                      participantId: input.participantId,
                      generation: 1n,
                      status: "absent",
                      connectionCount: 0,
                      changedAt: input.issuedAt,
                      graceEndsAt: null,
                      absentSince: input.issuedAt,
                      departedAt: null,
                      overridden: false,
                      endedAt: null,
                    },
                  ],
                  round: null,
                  events: [],
                  commandResults: [
                    {
                      participantId: input.participantId,
                      commandId: input.commandId,
                      roundId: null,
                      commandType: "create-lobby",
                      deliveryScope: "participant-private",
                      eventSequence: null,
                      result: {
                        normalizedUsername: normalized.normalizedUsername,
                        themeId: input.themeId,
                        entry: toPersistedLobbyEntry(entry),
                      },
                      createdAt: input.issuedAt,
                    },
                  ],
                });
                return { ok: true, entry } as const;
              },
              {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                maxWait: 5_000,
                timeout: 10_000,
              },
            ),
          this.retryOptions,
        );
        if (result === "collision") continue;
        return result;
      } catch (error) {
        if (isParticipantSessionTokenHashCollision(error)) {
          return {
            ok: false,
            error: {
              code: "TOKEN_HASH_COLLISION",
              message: "The participant session credential collided.",
            },
          };
        }
        throw error;
      }
    }
    throw new Error("Unable to generate a unique active lobby code.");
  }

  async joinLobbyWithSession(input: JoinLobbyWithSessionInput): Promise<LobbyEntryMutationResult> {
    if (
      !Number.isSafeInteger(input.maxPlayersPerLobby) ||
      input.maxPlayersPerLobby < 1 ||
      input.maxPlayersPerLobby > 25
    ) {
      throw new RangeError("The participant limit must be a safe integer between 1 and 25.");
    }
    if (input.tokenHash.length !== 32) {
      throw new RangeError("Participant session token hashes must contain exactly 32 bytes.");
    }
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(input.lobbyCode)) {
      throw new RangeError("Lobby codes must use the canonical six-character alphabet.");
    }
    assertValidDate(input.issuedAt, "The participant session issuance timestamp");
    const normalized = normalizeUsername(input.username);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error };
    }

    try {
      return await runTransactionWithRetry(
        async () =>
          this.prisma.$transaction(
            async (transaction) => {
              const lobbies = await transaction.$queryRaw<
                readonly { id: string; code: string; themeId: string }[]
              >`
                UPDATE "lobbies"
                   SET "last_event_sequence" = "last_event_sequence"
                 WHERE "id" = ${input.lobbyId}
                   AND "code" = ${input.lobbyCode}
                   AND "status" IN ('WAITING', 'ACTIVE')
                 RETURNING "id", "code", "theme_id" AS "themeId"
              `;
              const lobby = lobbies[0];
              if (lobby === undefined) {
                return {
                  ok: false,
                  error: {
                    code: "LOBBY_NOT_FOUND",
                    message: "The active lobby was not found.",
                  },
                } as const;
              }

              await this.expireDueParticipantSessions(
                transaction,
                input.lobbyId,
                this.currentLifecycleTime(),
              );
              const prior = await transaction.commandResult.findFirst({
                where: {
                  lobbyId: input.lobbyId,
                  commandId: input.commandId,
                  commandType: "join-lobby",
                },
                select: {
                  result: true,
                  participant: {
                    select: {
                      id: true,
                      username: true,
                      role: true,
                      roundEligibility: true,
                      departedAt: true,
                    },
                  },
                },
              });
              if (prior !== null) {
                const intent = toJsonObject(prior.result);
                if (intent["normalizedUsername"] !== normalized.normalizedUsername) {
                  return {
                    ok: false,
                    error: {
                      code: "COMMAND_REPLAY_MISMATCH",
                      message: "The command ID was already used for different lobby entry intent.",
                    },
                  } as const;
                }
                if (prior.participant.departedAt !== null) {
                  return {
                    ok: false,
                    error: {
                      code: "LOBBY_NOT_FOUND",
                      message: "The active lobby was not found.",
                    },
                  } as const;
                }
                const entry = fromPersistedLobbyEntry(intent["entry"], input.commandId);
                if (
                  entry.lobbyId !== input.lobbyId ||
                  entry.participantId !== prior.participant.id
                ) {
                  throw new Error("Join-lobby command entry scope is inconsistent.");
                }
                return { ok: true, entry } as const;
              }
              const existing = await transaction.participant.findUnique({
                where: {
                  lobbyId_normalizedUsername: {
                    lobbyId: input.lobbyId,
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
                where: { lobbyId: input.lobbyId, departedAt: null },
              });
              if (participantCount >= input.maxPlayersPerLobby) {
                return {
                  ok: false,
                  error: { code: "LOBBY_FULL", message: "The lobby is full." },
                } as const;
              }
              const currentRound = await transaction.round.findUnique({
                where: { lobbyId: input.lobbyId },
                select: { stage: true },
              });
              const roundEligibility = currentRound === null ? "playing" : "waiting";
              const entry: LobbyEntryRecord = {
                commandId: input.commandId,
                idempotentReplay: false,
                lobbyId: input.lobbyId,
                lobbyCode: lobby.code,
                themeId: lobby.themeId,
                participantId: input.participantId,
                username: normalized.username,
                role: "player",
                roundEligibility,
                sessionId: input.sessionId,
                issuedAt: input.issuedAt,
              };

              await transaction.participant.create({
                data: {
                  id: input.participantId,
                  lobbyId: input.lobbyId,
                  username: normalized.username,
                  normalizedUsername: normalized.normalizedUsername,
                  role: "PLAYER",
                  roundEligibility: roundEligibilities.toDatabase(roundEligibility),
                  joinedAt: input.issuedAt,
                  departedAt: null,
                },
              });
              await transaction.presenceGeneration.create({
                data: {
                  lobbyId: input.lobbyId,
                  participantId: input.participantId,
                  generation: 1n,
                  status: "ABSENT",
                  connectionCount: 0,
                  changedAt: input.issuedAt,
                  graceEndsAt: null,
                  absentSince: input.issuedAt,
                  departedAt: null,
                  overridden: false,
                  endedAt: null,
                },
              });
              await transaction.participantSession.create({
                data: {
                  id: input.sessionId,
                  lobbyId: input.lobbyId,
                  participantId: input.participantId,
                  tokenHash: new Uint8Array(input.tokenHash),
                  status: "ACTIVE",
                  issuedAt: input.issuedAt,
                  disconnectedAt: null,
                  rejoinUntil: null,
                  departedAt: null,
                },
              });
              await transaction.commandResult.create({
                data: {
                  lobbyId: input.lobbyId,
                  participantId: input.participantId,
                  commandId: input.commandId,
                  roundId: null,
                  commandType: "join-lobby",
                  deliveryScope: "PARTICIPANT_PRIVATE",
                  eventSequence: null,
                  result: toInputJson({
                    normalizedUsername: normalized.normalizedUsername,
                    entry: toPersistedLobbyEntry(entry),
                  }),
                  createdAt: input.issuedAt,
                },
              });

              return { ok: true, entry } as const;
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
        return {
          ok: false,
          error: {
            code: "TOKEN_HASH_COLLISION",
            message: "The participant session credential collided.",
          },
        };
      }
      throw error;
    }
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

            await this.expireDueParticipantSessions(
              transaction,
              participant.lobbyId,
              this.currentLifecycleTime(),
            );

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
              where: { lobbyId: participant.lobbyId, departedAt: null },
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

            const currentRound = await transaction.round.findUnique({
              where: { lobbyId: participant.lobbyId },
              select: { stage: true },
            });
            const roundEligibility =
              currentRound !== null &&
              currentRound.stage !== "WAITING" &&
              currentRound.stage !== "ENDED"
                ? "WAITING"
                : "PLAYING";

            await transaction.participant.create({
              data: {
                id: participant.id,
                lobbyId: participant.lobbyId,
                username: normalized.username,
                normalizedUsername: normalized.normalizedUsername,
                role: "PLAYER",
                roundEligibility,
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
              const lobbies = await transaction.$queryRaw<readonly { id: string }[]>`
                UPDATE "lobbies"
                   SET "last_event_sequence" = "last_event_sequence"
                 WHERE "id" = ${session.lobbyId}
                   AND "status" IN ('WAITING', 'ACTIVE')
                 RETURNING "id"
              `;
              if (lobbies.length !== 1) {
                return "scope-not-found" as const;
              }
              await this.expireDueParticipantSessions(
                transaction,
                session.lobbyId,
                this.currentLifecycleTime(),
              );

              const participant = await transaction.participant.findFirst({
                where: {
                  id: session.participantId,
                  lobbyId: session.lobbyId,
                  departedAt: null,
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

  async issueRealtimeTicket(input: IssueRealtimeTicketInput): Promise<IssueRealtimeTicketResult> {
    if (input.sessionTokenHash.length !== 32 || input.ticketHash.length !== 32) {
      throw new RangeError(
        "Realtime ticket and session token hashes must contain exactly 32 bytes.",
      );
    }
    if (
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds < 1 ||
      input.ttlSeconds > 3_600
    ) {
      throw new RangeError(
        "The realtime ticket TTL must be a safe integer between 1 and 3600 seconds.",
      );
    }

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
            if (fenced.length !== 1) {
              return { ok: false, error: { code: "UNAUTHORIZED" } } as const;
            }

            const issuedAt = this.currentLifecycleTime();
            await this.expireDueParticipantSessions(transaction, input.lobbyId, issuedAt);
            await transaction.realtimeTicket.deleteMany({
              where: { expiresAt: { lte: issuedAt } },
            });
            const session = await transaction.participantSession.findFirst({
              where: {
                lobbyId: input.lobbyId,
                tokenHash: new Uint8Array(input.sessionTokenHash),
                status: "ACTIVE",
                participant: { departedAt: null },
              },
              select: { id: true, participantId: true },
            });
            if (session === null) {
              return { ok: false, error: { code: "UNAUTHORIZED" } } as const;
            }

            const expiresAt = new Date(issuedAt.getTime() + input.ttlSeconds * 1_000);
            const inserted = await transaction.$queryRaw<readonly { expiresAt: Date }[]>`
              INSERT INTO "realtime_tickets" (
                "token_hash",
                "lobby_id",
                "participant_id",
                "participant_session_id",
                "issued_at",
                "expires_at"
              ) VALUES (
                ${new Uint8Array(input.ticketHash)},
                ${input.lobbyId},
                ${session.participantId},
                ${session.id},
                ${issuedAt},
                ${expiresAt}
              )
              ON CONFLICT ("token_hash") DO NOTHING
              RETURNING "expires_at" AS "expiresAt"
            `;
            return inserted.length === 1
              ? ({ ok: true, expiresAt: inserted[0]!.expiresAt } as const)
              : ({ ok: false, error: { code: "TICKET_HASH_COLLISION" } } as const);
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

  async consumeRealtimeTicket(input: {
    readonly ticketHash: Uint8Array;
  }): Promise<ConsumedRealtimeTicket | null> {
    if (input.ticketHash.length !== 32) {
      throw new RangeError("Realtime ticket hashes must contain exactly 32 bytes.");
    }

    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const now = this.currentLifecycleTime();
            const consumed = await transaction.$queryRaw<
              readonly {
                lobbyId: string;
                participantId: string;
                participantSessionId: string;
              }[]
            >`
              WITH consumed AS (
                DELETE FROM "realtime_tickets"
                      WHERE "token_hash" = ${new Uint8Array(input.ticketHash)}
                  RETURNING "lobby_id",
                            "participant_id",
                            "participant_session_id",
                            "expires_at"
              )
              SELECT consumed."lobby_id" AS "lobbyId",
                     consumed."participant_id" AS "participantId",
                     consumed."participant_session_id" AS "participantSessionId"
                FROM consumed
                JOIN "lobbies" lobby
                  ON lobby."id" = consumed."lobby_id"
                JOIN "participants" participant
                  ON participant."lobby_id" = consumed."lobby_id"
                 AND participant."id" = consumed."participant_id"
                JOIN "participant_sessions" session
                  ON session."lobby_id" = consumed."lobby_id"
                 AND session."participant_id" = consumed."participant_id"
                 AND session."id" = consumed."participant_session_id"
               WHERE consumed."expires_at" > ${now}
                 AND lobby."status" IN ('WAITING', 'ACTIVE')
                 AND participant."departed_at" IS NULL
                 AND session."status" = 'ACTIVE'
            `;
            return consumed[0] ?? null;
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

  async expireParticipantRejoinWindows(lobbyId: string): Promise<number> {
    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const lobbies = await transaction.$queryRaw<readonly { id: string }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence"
               WHERE "id" = ${lobbyId}
                 AND "status" IN ('WAITING', 'ACTIVE')
               RETURNING "id"
            `;
            return lobbies.length === 1
              ? this.expireDueParticipantSessions(transaction, lobbyId, this.currentLifecycleTime())
              : 0;
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

  async markParticipantSessionDisconnected(input: {
    readonly lobbyId: string;
    readonly sessionId: string;
    readonly reconnectWindowSeconds: number;
  }): Promise<Extract<RecognizedParticipantSession, { readonly status: "disconnected" }> | null> {
    if (
      !Number.isSafeInteger(input.reconnectWindowSeconds) ||
      input.reconnectWindowSeconds < 1 ||
      input.reconnectWindowSeconds > 3_600
    ) {
      throw new RangeError(
        "The reconnect window must be a safe integer between 1 and 3600 seconds.",
      );
    }

    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const lobbies = await transaction.$queryRaw<readonly { id: string }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence"
               WHERE "id" = ${input.lobbyId}
                 AND "status" IN ('WAITING', 'ACTIVE')
               RETURNING "id"
            `;
            if (lobbies.length !== 1) {
              return null;
            }

            const disconnectedAt = this.currentLifecycleTime();
            await this.expireDueParticipantSessions(transaction, input.lobbyId, disconnectedAt);

            const session = await transaction.participantSession.findFirst({
              where: {
                id: input.sessionId,
                lobbyId: input.lobbyId,
                status: { in: ["ACTIVE", "DISCONNECTED"] },
                participant: { departedAt: null },
              },
              select: {
                id: true,
                lobbyId: true,
                participantId: true,
                status: true,
                disconnectedAt: true,
                rejoinUntil: true,
                participant: { select: { username: true, role: true } },
              },
            });
            if (session === null) {
              return null;
            }

            if (session.status === "ACTIVE") {
              await transaction.realtimeTicket.deleteMany({
                where: { participantSessionId: session.id },
              });
            }

            const disconnected =
              session.status === "ACTIVE"
                ? await transaction.participantSession.update({
                    where: { id: session.id },
                    data: {
                      status: "DISCONNECTED",
                      disconnectedAt,
                      rejoinUntil: new Date(
                        disconnectedAt.getTime() + input.reconnectWindowSeconds * 1_000,
                      ),
                      departedAt: null,
                    },
                    select: { disconnectedAt: true, rejoinUntil: true },
                  })
                : session;
            if (disconnected.disconnectedAt === null || disconnected.rejoinUntil === null) {
              throw new Error("Disconnected participant sessions require lifecycle timestamps.");
            }

            return {
              sessionId: session.id,
              lobbyId: session.lobbyId,
              participantId: session.participantId,
              username: session.participant.username,
              role: participantRoles.fromDatabase(session.participant.role),
              status: "disconnected",
              disconnectedAt: disconnected.disconnectedAt,
              rejoinUntil: disconnected.rejoinUntil,
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

  async rejoinLobbyWithSession(
    input: RejoinLobbyWithSessionInput,
  ): Promise<LobbyEntryMutationResult | null> {
    if (input.tokenHash.length !== 32) {
      throw new RangeError("Participant session token hashes must contain exactly 32 bytes.");
    }
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
            if (fenced.length !== 1) return null;
            const now = this.currentLifecycleTime();
            await this.expireDueParticipantSessions(transaction, input.lobbyId, now);
            const session = await transaction.participantSession.findFirst({
              where: {
                lobbyId: input.lobbyId,
                tokenHash: new Uint8Array(input.tokenHash),
                status: { in: ["ACTIVE", "DISCONNECTED"] },
                participant: { departedAt: null },
              },
              select: {
                id: true,
                status: true,
                issuedAt: true,
                lobby: { select: { id: true, code: true, themeId: true } },
                participant: {
                  select: { id: true, username: true, role: true, roundEligibility: true },
                },
              },
            });
            if (session === null) return null;
            const entry: LobbyEntryRecord = {
              commandId: input.commandId,
              idempotentReplay: false,
              lobbyId: session.lobby.id,
              lobbyCode: session.lobby.code,
              themeId: session.lobby.themeId,
              participantId: session.participant.id,
              username: session.participant.username,
              role: participantRoles.fromDatabase(session.participant.role),
              roundEligibility: roundEligibilities.fromDatabase(
                session.participant.roundEligibility,
              ),
              sessionId: session.id,
              issuedAt: session.issuedAt,
            };
            const prior = await transaction.commandResult.findUnique({
              where: {
                lobbyId_participantId_commandId: {
                  lobbyId: input.lobbyId,
                  participantId: session.participant.id,
                  commandId: input.commandId,
                },
              },
              select: { commandType: true, result: true },
            });
            if (prior !== null) {
              const result = toJsonObject(prior.result);
              if (prior.commandType !== "rejoin-lobby" || result["sessionId"] !== session.id) {
                return {
                  ok: false,
                  error: {
                    code: "COMMAND_REPLAY_MISMATCH",
                    message: "The command ID was already used for different lobby entry intent.",
                  },
                } as const;
              }
              const replay = fromPersistedLobbyEntry(result["entry"], input.commandId);
              if (
                replay.lobbyId !== session.lobby.id ||
                replay.participantId !== session.participant.id ||
                replay.sessionId !== session.id
              ) {
                throw new Error("Rejoin-lobby command entry scope is inconsistent.");
              }
              return { ok: true, entry: replay } as const;
            }
            await transaction.commandResult.create({
              data: {
                lobbyId: input.lobbyId,
                participantId: session.participant.id,
                commandId: input.commandId,
                roundId: null,
                commandType: "rejoin-lobby",
                deliveryScope: "PARTICIPANT_PRIVATE",
                eventSequence: null,
                result: toInputJson({
                  sessionId: session.id,
                  entry: toPersistedLobbyEntry(entry),
                }),
                createdAt: now,
              },
            });
            if (session.status === "DISCONNECTED") {
              await transaction.participantSession.update({
                where: { id: session.id },
                data: {
                  status: "ACTIVE",
                  disconnectedAt: null,
                  rejoinUntil: null,
                  departedAt: null,
                },
              });
            }
            await transaction.participantSession.updateMany({
              where: {
                lobbyId: session.lobby.id,
                participantId: session.participant.id,
                id: { not: session.id },
                status: { not: "DEPARTED" },
              },
              data: { status: "DEPARTED", departedAt: now },
            });
            return { ok: true, entry } as const;
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

  async findAuthorizedSnapshot(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<Snapshot | null> {
    if (input.tokenHash.length !== 32) {
      throw new RangeError("Participant session token hashes must contain exactly 32 bytes.");
    }

    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const fenced = await transaction.$queryRaw<readonly { id: string; status: string }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence"
               WHERE "id" = ${input.lobbyId}
                 AND "status" IN ('WAITING', 'ACTIVE')
               RETURNING "id", "status"
            `;
            if (fenced.length !== 1) {
              return null;
            }
            const generatedAt = this.currentLifecycleTime();
            await this.expireDueParticipantSessions(transaction, input.lobbyId, generatedAt);

            const session = await transaction.participantSession.findFirst({
              where: {
                lobbyId: input.lobbyId,
                tokenHash: new Uint8Array(input.tokenHash),
                status: "ACTIVE",
                participant: { departedAt: null },
              },
              select: {
                id: true,
                participantId: true,
                issuedAt: true,
                participant: { select: { roundEligibility: true } },
              },
            });
            if (session === null) {
              return null;
            }
            const currentRoundParticipantCount = await transaction.card.count({
              where: { lobbyId: input.lobbyId },
            });
            const visibleParticipantLimit =
              fenced[0]?.status === "ACTIVE" &&
              session.participant.roundEligibility === "WAITING" &&
              currentRoundParticipantCount === 25
                ? 26
                : 25;

            const visibleParticipantRows = await transaction.$queryRaw<readonly { id: string }[]>`
              SELECT p."id"
                FROM "participants" p
               WHERE p."lobby_id" = ${input.lobbyId}
                 AND (
                   p."id" = ${session.participantId}
                   OR p."role" = 'HOST'
                   OR p."departed_at" IS NULL
                   OR EXISTS (
                     SELECT 1
                       FROM "co_winners" required_winner
                      WHERE required_winner."lobby_id" = ${input.lobbyId}
                        AND required_winner."participant_id" = p."id"
                   )
                   OR EXISTS (
                     SELECT 1
                       FROM "cards" current_card
                      WHERE current_card."lobby_id" = ${input.lobbyId}
                        AND current_card."participant_id" = p."id"
                   )
                 )
               ORDER BY CASE
                          WHEN p."id" = ${session.participantId} THEN 0
                          WHEN p."role" = 'HOST' THEN 1
                          WHEN EXISTS (
                            SELECT 1
                              FROM "co_winners" cw
                             WHERE cw."lobby_id" = ${input.lobbyId}
                               AND cw."participant_id" = p."id"
                          ) THEN 2
                          WHEN EXISTS (
                            SELECT 1
                              FROM "cards" required_card
                             WHERE required_card."lobby_id" = ${input.lobbyId}
                               AND required_card."participant_id" = p."id"
                          ) THEN 3
                          ELSE 4
                        END,
                        p."departed_at" DESC NULLS LAST,
                        p."joined_at" ASC,
                        p."id" ASC
               LIMIT ${visibleParticipantLimit}
            `;
            const visibleParticipantIds = visibleParticipantRows.map(({ id }) => id);

            const lobby = await transaction.lobby.findUnique({
              where: { id: input.lobbyId },
              select: {
                id: true,
                code: true,
                status: true,
                themeId: true,
                createdAt: true,
                lastEventSequence: true,
                participants: {
                  where: { id: { in: visibleParticipantIds } },
                  orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
                  select: {
                    id: true,
                    username: true,
                    role: true,
                    roundEligibility: true,
                    joinedAt: true,
                    departedAt: true,
                    presenceGenerations: {
                      orderBy: { generation: "desc" },
                      take: 1,
                      select: {
                        generation: true,
                        status: true,
                        changedAt: true,
                        graceEndsAt: true,
                        absentSince: true,
                        departedAt: true,
                        overridden: true,
                      },
                    },
                  },
                },
                currentRound: {
                  select: {
                    id: true,
                    currentPatternId: true,
                    stage: true,
                    callMode: true,
                    callIntervalSeconds: true,
                    createdAt: true,
                    startedAt: true,
                    pausedAt: true,
                    pauseReason: true,
                    nextCallAt: true,
                    coWinnerTriggeringCallId: true,
                    coWinnerOpenedAt: true,
                    coWinnerClosesAt: true,
                    resultSettledAt: true,
                    endedAt: true,
                    cards: {
                      where: { participantId: session.participantId },
                      take: 1,
                      select: {
                        id: true,
                        participantId: true,
                        cells: true,
                        marks: {
                          orderBy: { markedAt: "asc" },
                          select: { id: true, ball: true, markedAt: true },
                        },
                      },
                    },
                    calls: {
                      orderBy: { position: "asc" },
                      select: { id: true, position: true, ball: true, calledAt: true },
                    },
                    coWinners: {
                      orderBy: { participantId: "asc" },
                      select: { participantId: true },
                    },
                  },
                },
              },
            });
            if (lobby === null) {
              return null;
            }

            const host = lobby.participants.find((participant) => participant.role === "HOST");
            if (host === undefined) {
              throw new Error("An active lobby requires one host participant.");
            }
            const prioritizedParticipants = [...lobby.participants].sort((left, right) => {
              const priority = (participant: (typeof lobby.participants)[number]): number => {
                if (participant.id === session.participantId) return 0;
                if (participant.role === "HOST") return 1;
                if (participant.departedAt === null) return 2;
                return 3;
              };
              const difference = priority(left) - priority(right);
              if (difference !== 0) return difference;
              if (left.departedAt !== null && right.departedAt !== null) {
                return right.departedAt.getTime() - left.departedAt.getTime();
              }
              return left.joinedAt.getTime() - right.joinedAt.getTime();
            });
            const visibleParticipants = prioritizedParticipants.slice(0, 26);

            const participants = visibleParticipants.map((participant) => {
              const latestPresence = participant.presenceGenerations[0];
              const generation = Number(latestPresence?.generation ?? 1n);
              if (!Number.isSafeInteger(generation) || generation < 1) {
                throw new Error("Presence generations must be positive safe integers.");
              }

              let presence: Record<string, unknown>;
              if (participant.departedAt !== null) {
                presence = {
                  participantId: participant.id,
                  generation,
                  status: "departed",
                  changedAt: participant.departedAt.toISOString(),
                  departedAt: participant.departedAt.toISOString(),
                };
              } else if (latestPresence === undefined) {
                presence = {
                  participantId: participant.id,
                  generation,
                  status: "absent",
                  changedAt: participant.joinedAt.toISOString(),
                  absentSince: participant.joinedAt.toISOString(),
                  overridden: false,
                };
              } else {
                const base = {
                  participantId: participant.id,
                  generation,
                  changedAt: latestPresence.changedAt.toISOString(),
                };
                switch (latestPresence.status) {
                  case "CONNECTED":
                    presence = { ...base, status: "connected" };
                    break;
                  case "GRACE":
                    if (latestPresence.graceEndsAt === null) {
                      throw new Error("Grace presence requires a deadline.");
                    }
                    presence = {
                      ...base,
                      status: "grace",
                      graceEndsAt: latestPresence.graceEndsAt.toISOString(),
                    };
                    break;
                  case "ABSENT":
                    if (latestPresence.absentSince === null) {
                      throw new Error("Absent presence requires a start timestamp.");
                    }
                    presence = {
                      ...base,
                      status: "absent",
                      absentSince: latestPresence.absentSince.toISOString(),
                      overridden: latestPresence.overridden,
                    };
                    break;
                  case "DEPARTED":
                    if (latestPresence.departedAt === null) {
                      throw new Error("Departed presence requires a departure timestamp.");
                    }
                    presence = {
                      ...base,
                      status: "departed",
                      departedAt: latestPresence.departedAt.toISOString(),
                    };
                    break;
                }
              }
              return {
                id: participant.id,
                username: participant.username,
                role: participantRoles.fromDatabase(participant.role),
                roundEligibility: roundEligibilities.fromDatabase(participant.roundEligibility),
                presence,
              };
            });
            const self = participants.find(
              (participant) => participant.id === session.participantId,
            );
            if (self === undefined) {
              return null;
            }

            const round = lobby.currentRound;
            const requireDate = (value: Date | null, name: string): Date => {
              if (value === null)
                throw new Error(`${name} is required by the persisted round stage.`);
              return value;
            };
            const requireString = (value: string | null, name: string): string => {
              if (value === null)
                throw new Error(`${name} is required by the persisted round stage.`);
              return value;
            };
            const callConfiguration =
              round?.callMode === "AUTOMATIC"
                ? { mode: "automatic" as const, intervalSeconds: round.callIntervalSeconds }
                : { mode: "manual" as const };
            const baseRound =
              round === null
                ? null
                : {
                    id: round.id,
                    lobbyId: lobby.id,
                    patternId: round.currentPatternId,
                    callConfiguration,
                  };
            const winnerResult =
              round === null ||
              (round.stage !== "RESULT" && round.stage !== "ENDED") ||
              round.coWinners.length === 0
                ? null
                : {
                    triggeringCallId: requireString(
                      round.coWinnerTriggeringCallId,
                      "The result triggering call",
                    ),
                    openedAt: requireDate(
                      round.coWinnerOpenedAt,
                      "The result opening timestamp",
                    ).toISOString(),
                    closesAt: requireDate(
                      round.coWinnerClosesAt,
                      "The result closing timestamp",
                    ).toISOString(),
                    settledAt: requireDate(
                      round.resultSettledAt,
                      "The result settlement timestamp",
                    ).toISOString(),
                    winnerParticipantIds: round.coWinners.map((winner) => winner.participantId),
                  };

            let roundState: unknown = null;
            if (round !== null && baseRound !== null) {
              const startedAt =
                round.stage === "WAITING"
                  ? null
                  : requireDate(round.startedAt, "The round start timestamp").toISOString();
              switch (round.stage) {
                case "WAITING":
                  roundState = {
                    ...baseRound,
                    stage: "waiting",
                    createdAt: round.createdAt.toISOString(),
                  };
                  break;
                case "ACTIVE":
                  roundState = { ...baseRound, stage: "active", startedAt };
                  break;
                case "PAUSED":
                  if (round.pauseReason === null) {
                    throw new Error("Paused rounds require a pause reason.");
                  }
                  roundState = {
                    ...baseRound,
                    stage: "paused",
                    startedAt,
                    pauseReason: pauseReasons.fromDatabase(round.pauseReason),
                    pausedAt: requireDate(round.pausedAt, "The pause timestamp").toISOString(),
                  };
                  break;
                case "CO_WINNER_WINDOW":
                  roundState = {
                    ...baseRound,
                    stage: "co-winner-window",
                    startedAt,
                    window: {
                      triggeringCallId: requireString(
                        round.coWinnerTriggeringCallId,
                        "The co-winner triggering call",
                      ),
                      openedAt: requireDate(
                        round.coWinnerOpenedAt,
                        "The co-winner opening timestamp",
                      ).toISOString(),
                      closesAt: requireDate(
                        round.coWinnerClosesAt,
                        "The co-winner closing timestamp",
                      ).toISOString(),
                    },
                  };
                  break;
                case "RESULT":
                  if (winnerResult === null) throw new Error("Result rounds require winners.");
                  roundState = { ...baseRound, stage: "result", startedAt, result: winnerResult };
                  break;
                case "ENDED":
                  roundState = {
                    ...baseRound,
                    stage: "ended",
                    startedAt,
                    endedAt: requireDate(round.endedAt, "The round end timestamp").toISOString(),
                    result: winnerResult,
                  };
                  break;
              }
            }

            const ownCard = round?.cards[0];
            const calls =
              round?.calls.map((call) => ({
                id: call.id,
                roundId: round.id,
                position: call.position,
                ball: call.ball,
                calledAt: call.calledAt.toISOString(),
              })) ?? [];
            const card =
              ownCard === undefined || round === null
                ? null
                : {
                    id: ownCard.id,
                    roundId: round.id,
                    participantId: ownCard.participantId,
                    cells: ownCard.cells.map((cell, index) =>
                      index === 12 && cell === 0 ? "FREE" : cell,
                    ),
                  };
            const marks =
              ownCard?.marks.map((mark) => ({
                id: mark.id,
                cardId: ownCard.id,
                ball: mark.ball,
                markedAt: mark.markedAt.toISOString(),
              })) ?? [];

            let timer: Record<string, unknown> | null = null;
            if (round?.stage === "CO_WINNER_WINDOW") {
              timer = {
                kind: "co-winner",
                triggeringCallId: requireString(
                  round.coWinnerTriggeringCallId,
                  "The co-winner triggering call",
                ),
                deadline: requireDate(
                  round.coWinnerClosesAt,
                  "The co-winner closing timestamp",
                ).toISOString(),
              };
            } else if (
              round?.stage === "ACTIVE" &&
              round.callMode === "AUTOMATIC" &&
              round.nextCallAt !== null
            ) {
              timer = { kind: "automatic-call", deadline: round.nextCallAt.toISOString() };
            } else {
              const graceParticipant = participants.find(
                (participant) => participant.presence["status"] === "grace",
              );
              if (graceParticipant !== undefined) {
                timer = {
                  kind: "disconnect-grace",
                  participantId: graceParticipant.id,
                  generation: graceParticipant.presence["generation"],
                  deadline: graceParticipant.presence["graceEndsAt"],
                };
              }
            }

            const lastEventSequence = Number(lobby.lastEventSequence);
            if (!Number.isSafeInteger(lastEventSequence) || lastEventSequence < 0) {
              throw new Error("Active lobby event sequences must fit in a safe integer.");
            }
            return SnapshotSchema.parse({
              schemaVersion: 1,
              generatedAt: generatedAt.toISOString(),
              lastEventSequence: lastEventSequence === 0 ? null : lastEventSequence,
              lobby:
                lobby.status === "WAITING"
                  ? {
                      id: lobby.id,
                      code: lobby.code,
                      hostParticipantId: host.id,
                      themeId: lobby.themeId,
                      status: "waiting",
                      createdAt: lobby.createdAt.toISOString(),
                    }
                  : {
                      id: lobby.id,
                      code: lobby.code,
                      hostParticipantId: host.id,
                      themeId: lobby.themeId,
                      status: "active",
                      createdAt: lobby.createdAt.toISOString(),
                      roundId: requireString(round?.id ?? null, "The active lobby round"),
                    },
              session: {
                id: session.id,
                lobbyId: lobby.id,
                participantId: session.participantId,
                status: "active",
                issuedAt: session.issuedAt.toISOString(),
              },
              self,
              participants,
              round: roundState,
              ownCard: card,
              ownMarks: marks,
              calls,
              timer,
            });
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

  async resolveParticipantSessionByTokenHash(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<RecognizedParticipantSession | null> {
    return this.accessParticipantSessionByTokenHash(input, false);
  }

  async rejoinParticipantSessionByTokenHash(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<Extract<RecognizedParticipantSession, { readonly status: "active" }> | null> {
    const session = await this.accessParticipantSessionByTokenHash(input, true);
    return session?.status === "active" ? session : null;
  }

  private async accessParticipantSessionByTokenHash(
    input: {
      readonly lobbyId: string;
      readonly tokenHash: Uint8Array;
    },
    activate: boolean,
  ): Promise<RecognizedParticipantSession | null> {
    if (input.tokenHash.length !== 32) {
      throw new RangeError("Participant session token hashes must contain exactly 32 bytes.");
    }

    return runTransactionWithRetry(
      async () =>
        this.prisma.$transaction(
          async (transaction) => {
            const lobbies = await transaction.$queryRaw<readonly { id: string }[]>`
              UPDATE "lobbies"
                 SET "last_event_sequence" = "last_event_sequence"
               WHERE "id" = ${input.lobbyId}
                 AND "status" IN ('WAITING', 'ACTIVE')
               RETURNING "id"
            `;
            if (lobbies.length !== 1) {
              return null;
            }

            const now = this.currentLifecycleTime();
            await this.expireDueParticipantSessions(transaction, input.lobbyId, now);

            const session = await transaction.participantSession.findFirst({
              where: {
                lobbyId: input.lobbyId,
                tokenHash: new Uint8Array(input.tokenHash),
                status: { in: ["ACTIVE", "DISCONNECTED"] },
                participant: { departedAt: null },
              },
              select: {
                id: true,
                lobbyId: true,
                participantId: true,
                status: true,
                disconnectedAt: true,
                rejoinUntil: true,
                participant: { select: { username: true, role: true } },
              },
            });
            if (session === null) {
              return null;
            }

            const identity = {
              sessionId: session.id,
              lobbyId: session.lobbyId,
              participantId: session.participantId,
              username: session.participant.username,
              role: participantRoles.fromDatabase(session.participant.role),
            };
            if (session.status === "ACTIVE") {
              if (activate) {
                await transaction.participantSession.updateMany({
                  where: {
                    lobbyId: session.lobbyId,
                    participantId: session.participantId,
                    id: { not: session.id },
                    status: { not: "DEPARTED" },
                  },
                  data: { status: "DEPARTED", departedAt: now },
                });
              }
              return { ...identity, status: "active" } as const;
            }
            if (session.disconnectedAt === null || session.rejoinUntil === null) {
              throw new Error("Disconnected participant sessions require lifecycle timestamps.");
            }

            if (activate) {
              await transaction.participantSession.update({
                where: { id: session.id },
                data: {
                  status: "ACTIVE",
                  disconnectedAt: null,
                  rejoinUntil: null,
                  departedAt: null,
                },
              });
              await transaction.participantSession.updateMany({
                where: {
                  lobbyId: session.lobbyId,
                  participantId: session.participantId,
                  id: { not: session.id },
                  status: { not: "DEPARTED" },
                },
                data: { status: "DEPARTED", departedAt: now },
              });
              return { ...identity, status: "active" } as const;
            }

            return {
              ...identity,
              status: "disconnected",
              disconnectedAt: session.disconnectedAt,
              rejoinUntil: session.rejoinUntil,
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
    lobbyStates: new PrismaLobbyStateRepository(
      prisma,
      options.transactionRetry ?? {},
      options.lifecycleClock ?? (() => new Date()),
    ),
    commandTransactions: new PrismaCommandTransactionRepository(
      prisma,
      options.transactionRetry ?? {},
    ),
    async disconnect() {
      await prisma.$disconnect();
    },
  };
}
