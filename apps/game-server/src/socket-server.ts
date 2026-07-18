import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  ActiveLobbyEvent,
  CommandAck,
  ContractError,
  MutationCommand,
  ParticipantPrivateEvent,
  Snapshot,
} from "@gamenight-bingo/contracts";
import {
  CONTRACT_SCHEMA_VERSION,
  ActiveLobbyEventSchema,
  CommandAckSchema,
  CommandIdSchema,
  ErrorSchema,
  ParticipantPrivateEventSchema,
  RealtimeCommandSchema,
  RealtimeHandshakeAuthSchema,
  RealtimeTicketSchema,
  SnapshotMessageSchema,
  type ErrorCode,
} from "@gamenight-bingo/contracts";
import { Server } from "socket.io";

import type { AutomaticCallExecutionResult, AutomaticCallLease } from "@gamenight-bingo/database";

import { consumeRealtimeTicketCredential, type RealtimeTicketConsumer } from "./realtime-ticket.js";

export interface AuthenticatedRealtimeIdentity {
  readonly lobbyId: string;
  readonly participantId: string;
  readonly participantSessionId: string;
}

export interface RealtimePresenceGracePeriod {
  readonly lobbyId: string;
  readonly participantId: string;
  readonly presenceGeneration: number;
  readonly graceEndsAt: Date;
}

export type RealtimePresenceGraceExpiryResult = "expired" | "stale" | "too-early";

export type RealtimeCommandExecutionResult =
  | {
      readonly ok: true;
      readonly acknowledgement: CommandAck;
      readonly activeLobbyEvent: ActiveLobbyEvent | null;
      readonly participantPrivateEvent: ParticipantPrivateEvent | null;
    }
  | {
      readonly ok: false;
      readonly error: Pick<ContractError, "code">;
    };

export interface GameServerOptions {
  readonly allowedOrigin: string;
  readonly clock: () => Date;
  readonly ticketConsumer: RealtimeTicketConsumer;
  readonly commandExecutor: {
    execute(input: {
      readonly identity: AuthenticatedRealtimeIdentity;
      readonly command: MutationCommand;
    }): Promise<RealtimeCommandExecutionResult>;
  };
  readonly snapshotProvider: {
    findAuthorizedSnapshot(identity: AuthenticatedRealtimeIdentity): Promise<Snapshot | null>;
  };
  readonly identityAuthorizer: {
    isIdentityActive(identity: AuthenticatedRealtimeIdentity): Promise<boolean>;
  };
  readonly presenceLifecycle: {
    registerConnection(identity: AuthenticatedRealtimeIdentity): Promise<number | null>;
    recordHeartbeat(identity: AuthenticatedRealtimeIdentity): Promise<boolean>;
    unregisterConnection(
      identity: AuthenticatedRealtimeIdentity,
      presenceGeneration: number,
    ): Promise<RealtimePresenceGracePeriod | null>;
    expireGracePeriod(
      grace: RealtimePresenceGracePeriod,
    ): Promise<RealtimePresenceGraceExpiryResult>;
  };
  readonly initialPresenceGracePeriods?: readonly RealtimePresenceGracePeriod[];
  readonly automaticCallLifecycle: {
    findAutomaticCallLeases(): Promise<readonly AutomaticCallLease[]>;
    findAutomaticCallLease(lobbyId: string): Promise<AutomaticCallLease | null>;
    executeAutomaticCall(lease: AutomaticCallLease): Promise<AutomaticCallExecutionResult>;
  };
  readonly limits?: {
    readonly connectionsPerMinute?: number;
    readonly commandsPerMinute?: number;
    readonly maximumConnections?: number;
    readonly connectionsPerSession?: number;
    readonly maximumQueuedAutomaticCalls?: number;
  };
}

export interface GameServer {
  readonly failure: Promise<never>;
  listen(options: {
    readonly host: string;
    readonly port: number;
  }): Promise<{ readonly host: string; readonly port: number }>;
  close(): Promise<void>;
  publishLobbyEvent(lobbyId: string, event: ActiveLobbyEvent): Promise<void>;
  publishLobbyEventFromSource(
    lobbyId: string,
    sequence: number,
    loadEvent: () => Promise<ActiveLobbyEvent>,
  ): Promise<void>;
  publishParticipantEvent(participantId: string, event: ParticipantPrivateEvent): Promise<void>;
}

interface ClientToServerEvents {
  readonly "v1:command": (payload: unknown) => void;
}

interface ServerToClientEvents {
  readonly "v1:snapshot": (message: ReturnType<typeof SnapshotMessageSchema.parse>) => void;
  readonly "v1:lobby-event": (event: ActiveLobbyEvent) => void;
  readonly "v1:private-event": (event: ParticipantPrivateEvent) => void;
  readonly "v1:ack": (acknowledgement: CommandAck) => void;
  readonly "v1:error": (error: ContractError) => void;
}

interface SocketData {
  identity: AuthenticatedRealtimeIdentity;
  synchronization?:
    | {
        readonly status: "pending";
        readonly lobbyEvents: ActiveLobbyEvent[];
        readonly participantEvents: ParticipantPrivateEvent[];
        reservedDeliveries: number;
      }
    | { readonly status: "ready"; readonly baseline: number };
}

const MAXIMUM_PENDING_SYNCHRONIZATION_EVENTS = 256;
const MAXIMUM_CONCURRENT_PRESENCE_GRACE_EXPIRATIONS = 8;
const MAXIMUM_CONCURRENT_AUTOMATIC_CALLS = 8;
const DEFAULT_MAXIMUM_QUEUED_AUTOMATIC_CALLS = 2_500;

const errorMessages = {
  INVALID_PAYLOAD: "The request payload is invalid.",
  INVALID_COMMAND: "The command is not valid in the current state.",
  UNAUTHORIZED: "Authentication is required.",
  FORBIDDEN: "You are not allowed to perform this action.",
  NOT_FOUND: "The requested resource was not found.",
  LOBBY_FULL: "The lobby is full.",
  LOBBY_EXPIRED: "The lobby has expired.",
  ACTIVE_LOBBY_LIMIT_REACHED: "The active lobby limit has been reached.",
  USERNAME_TAKEN: "That username is already in use.",
  RATE_LIMITED: "Too many requests. Try again later.",
  INTERNAL_ERROR: "An unexpected error occurred.",
} as const satisfies Record<ErrorCode, string>;

function room(kind: "lobby" | "participant", id: string): string {
  return `${kind}:${id}`;
}

function createContractError(
  code: ErrorCode,
  clock: () => Date,
  commandId: string | null = null,
): ContractError {
  return ErrorSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    type: "error",
    code,
    message: errorMessages[code],
    commandId,
    occurredAt: clock().toISOString(),
    retryable: code === "INTERNAL_ERROR" || code === "RATE_LIMITED",
    issues: [],
  });
}

function commandIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("commandId" in payload)) return null;
  const parsed = CommandIdSchema.safeParse(payload.commandId);
  return parsed.success ? parsed.data : null;
}

export class BoundedFixedWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; startedAt: number }>();

  constructor(private readonly maximumBuckets: number) {}

  consume(key: string, limit: number, now: number): boolean {
    const existing = this.buckets.get(key);
    if (existing !== undefined && now - existing.startedAt < 60_000) {
      if (existing.count >= limit) return false;
      existing.count += 1;
      return true;
    }

    if (existing !== undefined) this.buckets.delete(key);
    while (this.buckets.size >= this.maximumBuckets) {
      const oldest = this.buckets.entries().next().value;
      if (oldest === undefined || now - oldest[1].startedAt < 60_000) return false;
      this.buckets.delete(oldest[0]);
    }
    this.buckets.set(key, { count: 1, startedAt: now });
    return true;
  }
}

type ConnectionReservation =
  | { readonly status: "closed" }
  | { readonly status: "full" }
  | { readonly status: "reserved"; readonly release: () => void };

export class AuthenticatedConnectionCapacity {
  private readonly connectionsBySession = new Map<string, number>();
  private activeConnections = 0;

  constructor(
    private readonly maximumConnections: number,
    private readonly connectionsPerSession: number,
  ) {}

  reserve(participantSessionId: string, isTransportOpen: () => boolean): ConnectionReservation {
    if (!isTransportOpen()) return { status: "closed" };
    const sessionConnections = this.connectionsBySession.get(participantSessionId) ?? 0;
    if (
      this.activeConnections >= this.maximumConnections ||
      sessionConnections >= this.connectionsPerSession
    ) {
      return { status: "full" };
    }

    this.activeConnections += 1;
    this.connectionsBySession.set(participantSessionId, sessionConnections + 1);
    let released = false;
    return {
      status: "reserved",
      release: () => {
        if (released) return;
        released = true;
        this.activeConnections -= 1;
        const remaining = (this.connectionsBySession.get(participantSessionId) ?? 1) - 1;
        if (remaining === 0) this.connectionsBySession.delete(participantSessionId);
        else this.connectionsBySession.set(participantSessionId, remaining);
      },
    };
  }
}

function listen(httpServer: HttpServer, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      const address = httpServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The game server did not bind a TCP address."));
        return;
      }
      resolve(address);
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });
}

export function createGameServer(options: GameServerOptions): GameServer {
  const connectionLimit = options.limits?.connectionsPerMinute ?? 60;
  const commandLimit = options.limits?.commandsPerMinute ?? 120;
  const maximumConnections = options.limits?.maximumConnections ?? 10_000;
  const connectionsPerSession = options.limits?.connectionsPerSession ?? 8;
  const maximumQueuedAutomaticCalls =
    options.limits?.maximumQueuedAutomaticCalls ?? DEFAULT_MAXIMUM_QUEUED_AUTOMATIC_CALLS;
  if (!Number.isSafeInteger(connectionLimit) || connectionLimit < 1) {
    throw new RangeError("The connection rate limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(commandLimit) || commandLimit < 1) {
    throw new RangeError("The command rate limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(maximumConnections) || maximumConnections < 1) {
    throw new RangeError("The connection limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(connectionsPerSession) || connectionsPerSession < 1) {
    throw new RangeError("The per-session connection limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(maximumQueuedAutomaticCalls) || maximumQueuedAutomaticCalls < 1) {
    throw new RangeError("The automatic call queue limit must be a positive integer.");
  }
  const connectionRateLimiter = new BoundedFixedWindowRateLimiter(10_000);
  const authenticationRateLimiter = new BoundedFixedWindowRateLimiter(10_000);
  const rejectedAuthenticationTransports = new WeakSet<object>();
  const commandRateLimiter = new BoundedFixedWindowRateLimiter(10_000);
  const connectionCapacity = new AuthenticatedConnectionCapacity(
    maximumConnections,
    connectionsPerSession,
  );
  const httpServer = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  });
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    serveClient: false,
    maxHttpBufferSize: 16 * 1024,
    cors: { origin: options.allowedOrigin, credentials: true },
    allowRequest: (request, callback) => {
      const accepted =
        request.headers.origin === options.allowedOrigin &&
        connectionRateLimiter.consume(
          request.socket.remoteAddress ?? "unidentified",
          connectionLimit,
          options.clock().getTime(),
        );
      callback(null, accepted);
    },
  });
  const pendingAuthorityTasks = new Set<Promise<void>>();
  const presenceGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const queuedPresenceGraceExpirations: RealtimePresenceGracePeriod[] = [];
  const automaticCallTimers = new Map<
    string,
    { readonly lease: AutomaticCallLease; readonly timer: ReturnType<typeof setTimeout> }
  >();
  const queuedAutomaticCalls = new Map<string, AutomaticCallLease>();
  const activeAutomaticCallLeases = new Map<string, AutomaticCallLease>();
  const automaticCallReconciliations = new Map<string, object>();
  let activePresenceGraceExpirations = 0;
  let activeAutomaticCalls = 0;
  let presenceGraceExpiryFailed = false;
  let automaticCallFailed = false;
  let authorityFailed = false;
  let automaticCallRecoveryInProgress = false;
  const automaticCallRecoveryDirtyLobbies = new Set<string>();
  let fatalPresenceClose: Promise<void> | null = null;
  let closed = false;
  let failureReported = false;
  let rejectFailure!: (reason: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => {});
  const stopAuthorityWork = () => {
    for (const timer of presenceGraceTimers.values()) clearTimeout(timer);
    presenceGraceTimers.clear();
    queuedPresenceGraceExpirations.length = 0;
    for (const { timer } of automaticCallTimers.values()) clearTimeout(timer);
    automaticCallTimers.clear();
    queuedAutomaticCalls.clear();
    automaticCallReconciliations.clear();
  };
  const reportAuthorityFailure = () => {
    authorityFailed = true;
    stopAuthorityWork();
    if (!failureReported) {
      failureReported = true;
      rejectFailure(new Error("Game server authority failed."));
    }
    fatalPresenceClose ??= new Promise<void>((resolve) => io.close(() => resolve()));
  };
  const trackAuthorityTask = (task: Promise<void>) => {
    const observed = task.catch(() => {
      reportAuthorityFailure();
    });
    pendingAuthorityTasks.add(observed);
    void observed.finally(() => pendingAuthorityTasks.delete(observed));
  };
  const drainPresenceGraceExpirations = () => {
    while (
      !closed &&
      !authorityFailed &&
      !presenceGraceExpiryFailed &&
      activePresenceGraceExpirations < MAXIMUM_CONCURRENT_PRESENCE_GRACE_EXPIRATIONS
    ) {
      const grace = queuedPresenceGraceExpirations.shift();
      if (grace === undefined) return;
      activePresenceGraceExpirations += 1;
      trackAuthorityTask(
        options.presenceLifecycle
          .expireGracePeriod(grace)
          .catch((error: unknown) => {
            presenceGraceExpiryFailed = true;
            reportAuthorityFailure();
            throw error;
          })
          .then((result) => {
            if (result === "too-early" && !closed) schedulePresenceGrace(grace);
          })
          .catch((error: unknown) => {
            presenceGraceExpiryFailed = true;
            reportAuthorityFailure();
            throw error;
          })
          .finally(() => {
            activePresenceGraceExpirations -= 1;
            drainPresenceGraceExpirations();
          }),
      );
    }
  };
  const schedulePresenceGrace = (grace: RealtimePresenceGracePeriod) => {
    if (closed || authorityFailed) return;
    if (
      !Number.isSafeInteger(grace.presenceGeneration) ||
      grace.presenceGeneration < 1 ||
      !Number.isFinite(grace.graceEndsAt.getTime())
    ) {
      trackAuthorityTask(Promise.reject(new Error("Invalid persisted presence grace period.")));
      return;
    }
    const key = JSON.stringify([grace.lobbyId, grace.participantId, grace.presenceGeneration]);
    const existing = presenceGraceTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(
      () => {
        presenceGraceTimers.delete(key);
        queuedPresenceGraceExpirations.push(grace);
        drainPresenceGraceExpirations();
      },
      Math.max(0, grace.graceEndsAt.getTime() - options.clock().getTime()),
    );
    presenceGraceTimers.set(key, timer);
  };
  options.initialPresenceGracePeriods?.forEach(schedulePresenceGrace);

  const automaticCallKey = (lease: AutomaticCallLease) =>
    JSON.stringify([lease.roundId, lease.deadline.toISOString()]);
  const clearAutomaticCall = (lobbyId: string) => {
    const existing = automaticCallTimers.get(lobbyId);
    if (existing !== undefined) clearTimeout(existing.timer);
    automaticCallTimers.delete(lobbyId);
    queuedAutomaticCalls.delete(lobbyId);
  };
  const drainAutomaticCalls = () => {
    while (
      !closed &&
      !authorityFailed &&
      !automaticCallFailed &&
      activeAutomaticCalls < MAXIMUM_CONCURRENT_AUTOMATIC_CALLS
    ) {
      const queued = [...queuedAutomaticCalls.entries()].find(
        ([lobbyId]) => !activeAutomaticCallLeases.has(lobbyId),
      );
      if (queued === undefined) return;
      const [lobbyId, lease] = queued;
      queuedAutomaticCalls.delete(lobbyId);
      activeAutomaticCallLeases.set(lobbyId, lease);
      activeAutomaticCalls += 1;
      trackAuthorityTask(
        options.automaticCallLifecycle
          .executeAutomaticCall(lease)
          .catch((error: unknown) => {
            automaticCallFailed = true;
            reportAuthorityFailure();
            throw error;
          })
          .then(async (result) => {
            if (closed || authorityFailed) return;
            if (activeAutomaticCallLeases.get(lobbyId) === lease) {
              activeAutomaticCallLeases.delete(lobbyId);
            }
            if (result === "too-early") {
              await reconcileAutomaticCall(lease.lobbyId);
            } else if (result === "called" || result === "stale") {
              await reconcileAutomaticCall(lease.lobbyId);
            }
          })
          .catch((error: unknown) => {
            automaticCallFailed = true;
            reportAuthorityFailure();
            throw error;
          })
          .finally(() => {
            if (activeAutomaticCallLeases.get(lobbyId) === lease) {
              activeAutomaticCallLeases.delete(lobbyId);
            }
            activeAutomaticCalls -= 1;
            drainAutomaticCalls();
          }),
      );
    }
  };
  const scheduleAutomaticCall = (lease: AutomaticCallLease) => {
    if (closed || authorityFailed) return;
    if (
      lease.lobbyId.length === 0 ||
      lease.roundId.length === 0 ||
      !Number.isFinite(lease.deadline.getTime())
    ) {
      trackAuthorityTask(Promise.reject(new Error("Invalid persisted automatic call lease.")));
      return;
    }
    const existing = automaticCallTimers.get(lease.lobbyId);
    if (existing !== undefined) {
      if (automaticCallKey(existing.lease) === automaticCallKey(lease)) return;
      clearTimeout(existing.timer);
    }
    const queued = queuedAutomaticCalls.get(lease.lobbyId);
    if (queued !== undefined) {
      if (automaticCallKey(queued) === automaticCallKey(lease)) return;
      queuedAutomaticCalls.delete(lease.lobbyId);
    }
    const timer = setTimeout(
      () => {
        const current = automaticCallTimers.get(lease.lobbyId);
        if (current === undefined || automaticCallKey(current.lease) !== automaticCallKey(lease)) {
          return;
        }
        automaticCallTimers.delete(lease.lobbyId);
        if (
          !queuedAutomaticCalls.has(lease.lobbyId) &&
          queuedAutomaticCalls.size >= maximumQueuedAutomaticCalls
        ) {
          trackAuthorityTask(
            Promise.reject(new Error("The automatic call queue limit was exceeded.")),
          );
          return;
        }
        queuedAutomaticCalls.set(lease.lobbyId, lease);
        drainAutomaticCalls();
      },
      Math.max(0, lease.deadline.getTime() - options.clock().getTime()),
    );
    automaticCallTimers.set(lease.lobbyId, { lease, timer });
  };
  const reconcileAutomaticCall = async (lobbyId: string): Promise<void> => {
    if (closed || authorityFailed) return;
    if (automaticCallRecoveryInProgress) {
      automaticCallRecoveryDirtyLobbies.add(lobbyId);
      return;
    }
    const reconciliation = {};
    automaticCallReconciliations.set(lobbyId, reconciliation);
    try {
      const lease = await options.automaticCallLifecycle.findAutomaticCallLease(lobbyId);
      if (closed || automaticCallReconciliations.get(lobbyId) !== reconciliation) return;
      if (lease === null) clearAutomaticCall(lobbyId);
      else scheduleAutomaticCall(lease);
    } catch (error) {
      reportAuthorityFailure();
      throw error;
    } finally {
      if (automaticCallReconciliations.get(lobbyId) === reconciliation) {
        automaticCallReconciliations.delete(lobbyId);
      }
    }
  };
  const recoverAutomaticCalls = async (): Promise<void> => {
    automaticCallRecoveryInProgress = true;
    try {
      const leases = await options.automaticCallLifecycle.findAutomaticCallLeases();
      for (const lease of leases) {
        if (!automaticCallRecoveryDirtyLobbies.has(lease.lobbyId)) scheduleAutomaticCall(lease);
      }
    } finally {
      automaticCallRecoveryInProgress = false;
    }
    const dirtyLobbies = [...automaticCallRecoveryDirtyLobbies];
    automaticCallRecoveryDirtyLobbies.clear();
    await Promise.all(dirtyLobbies.map(reconcileAutomaticCall));
  };

  io.use(async (socket, next) => {
    let transportClosed = socket.conn.readyState !== "open";
    let releaseConnection = () => {};
    socket.conn.once("close", () => {
      transportClosed = true;
      releaseConnection();
    });
    const isTransportTerminal = () =>
      transportClosed ||
      socket.conn.readyState !== "open" ||
      rejectedAuthenticationTransports.has(socket.conn);
    const rejectAuthentication = (code: "INTERNAL_ERROR" | "RATE_LIMITED" | "UNAUTHORIZED") => {
      rejectedAuthenticationTransports.add(socket.conn);
      const contractError = createContractError(code, options.clock);
      const error = Object.assign(new Error(contractError.message), { data: contractError });
      next(error);
      setImmediate(() => socket.conn.close());
    };
    const handshakeAuth = socket.handshake.auth;
    const authentication = RealtimeHandshakeAuthSchema.safeParse(handshakeAuth);
    const presentedTicket = RealtimeTicketSchema.safeParse(
      typeof handshakeAuth === "object" && handshakeAuth !== null
        ? (handshakeAuth as Record<string, unknown>)["ticket"]
        : undefined,
    );

    try {
      if (rejectedAuthenticationTransports.has(socket.conn)) {
        socket.conn.close();
        return;
      }
      if (
        !authenticationRateLimiter.consume(
          socket.handshake.address || "unidentified",
          connectionLimit,
          options.clock().getTime(),
        )
      ) {
        rejectAuthentication("RATE_LIMITED");
        if (presentedTicket.success) {
          try {
            await consumeRealtimeTicketCredential(presentedTicket.data, options.ticketConsumer);
          } catch {
            // The transport is already terminal and receives only the safe rate-limit error.
          }
        }
        return;
      }
      if (!authentication.success) {
        rejectAuthentication("UNAUTHORIZED");
        if (presentedTicket.success) {
          await consumeRealtimeTicketCredential(presentedTicket.data, options.ticketConsumer);
        }
        return;
      }
      const consumed = await consumeRealtimeTicketCredential(
        authentication.data.ticket,
        options.ticketConsumer,
      );
      if (isTransportTerminal()) return;
      if (consumed === null) {
        rejectAuthentication("UNAUTHORIZED");
        return;
      }
      const reservation = connectionCapacity.reserve(
        consumed.participantSessionId,
        () => !isTransportTerminal(),
      );
      if (reservation.status === "closed") return;
      if (reservation.status === "full") {
        rejectAuthentication("RATE_LIMITED");
        return;
      }
      releaseConnection = reservation.release;
      socket.once("disconnect", releaseConnection);
      socket.data.identity = Object.freeze({ ...consumed });
      next();
    } catch {
      if (!isTransportTerminal()) rejectAuthentication("INTERNAL_ERROR");
    } finally {
      socket.handshake.auth = {};
    }
  });

  const isIdentityActive = async (identity: AuthenticatedRealtimeIdentity): Promise<boolean> => {
    try {
      return await options.identityAuthorizer.isIdentityActive(identity);
    } catch {
      return false;
    }
  };

  const authorizeIdentityOnce = (
    authorizations: Map<string, Promise<boolean>>,
    identity: AuthenticatedRealtimeIdentity,
  ): Promise<boolean> => {
    const key = JSON.stringify([
      identity.lobbyId,
      identity.participantId,
      identity.participantSessionId,
    ]);
    const existing = authorizations.get(key);
    if (existing !== undefined) return existing;
    const authorization = isIdentityActive(identity);
    authorizations.set(key, authorization);
    return authorization;
  };

  interface PendingLobbyDelivery {
    readonly sequence: number;
    readonly loadEvent: () => Promise<ActiveLobbyEvent>;
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
  }
  interface LobbyDeliveryQueue {
    readonly pending: PendingLobbyDelivery[];
    draining: boolean;
    lastDelivered: { readonly sequence: number; readonly fingerprint: string } | null;
    scheduled: boolean;
  }
  const lastDeliveredLobbyEvents = new Map<
    string,
    { readonly sequence: number; readonly fingerprint: string }
  >();
  const deliveredLobbyEventFingerprints = new Map<string, string>();
  const deliveredLobbyEventKey = (lobbyId: string, sequence: number) =>
    JSON.stringify([lobbyId, sequence]);
  const rememberDeliveredLobbyEventFingerprint = (
    lobbyId: string,
    sequence: number,
    fingerprint: string,
  ) => {
    const key = deliveredLobbyEventKey(lobbyId, sequence);
    deliveredLobbyEventFingerprints.delete(key);
    deliveredLobbyEventFingerprints.set(key, fingerprint);
    if (deliveredLobbyEventFingerprints.size > 10_000) {
      const oldestKey = deliveredLobbyEventFingerprints.keys().next().value;
      if (oldestKey !== undefined) deliveredLobbyEventFingerprints.delete(oldestKey);
    }
  };
  const rememberDeliveredLobbyEvent = (
    lobbyId: string,
    delivered: { readonly sequence: number; readonly fingerprint: string },
  ) => {
    lastDeliveredLobbyEvents.delete(lobbyId);
    lastDeliveredLobbyEvents.set(lobbyId, delivered);
    if (lastDeliveredLobbyEvents.size > 10_000) {
      const oldestLobbyId = lastDeliveredLobbyEvents.keys().next().value;
      if (oldestLobbyId !== undefined) lastDeliveredLobbyEvents.delete(oldestLobbyId);
    }
  };
  const lobbyDeliveryQueues = new Map<string, LobbyDeliveryQueue>();
  const drainLobbyDeliveries = async (
    lobbyId: string,
    queue: LobbyDeliveryQueue,
  ): Promise<void> => {
    queue.scheduled = false;
    queue.draining = true;
    try {
      while (queue.pending.length > 0) {
        queue.pending.sort((left, right) => left.sequence - right.sequence);
        const delivery = queue.pending.shift()!;
        try {
          const event = ActiveLobbyEventSchema.parse(await delivery.loadEvent());
          if (event.eventSequence !== delivery.sequence) {
            throw new RangeError("Loaded lobby event sequence does not match its reservation.");
          }
          const fingerprint = JSON.stringify(event);
          if (queue.lastDelivered !== null && delivery.sequence <= queue.lastDelivered.sequence) {
            const deliveredFingerprint = deliveredLobbyEventFingerprints.get(
              deliveredLobbyEventKey(lobbyId, delivery.sequence),
            );
            if (deliveredFingerprint === fingerprint) {
              rememberDeliveredLobbyEventFingerprint(lobbyId, delivery.sequence, fingerprint);
              delivery.resolve();
            } else if (deliveredFingerprint !== undefined) {
              delivery.reject(new RangeError("Lobby event sequence conflicts."));
            } else {
              delivery.reject(new RangeError("Lobby event sequence is stale."));
            }
            continue;
          }
          const sockets = await io.in(room("lobby", lobbyId)).fetchSockets();
          const authorizations = new Map<string, Promise<boolean>>();
          await Promise.all(
            sockets.map(async (socket) => {
              const synchronizationAtStart = socket.data.synchronization;
              const reserved = synchronizationAtStart?.status === "pending";
              if (reserved) {
                if (
                  synchronizationAtStart.lobbyEvents.length +
                    synchronizationAtStart.participantEvents.length +
                    synchronizationAtStart.reservedDeliveries >=
                  MAXIMUM_PENDING_SYNCHRONIZATION_EVENTS
                ) {
                  socket.emit("v1:error", createContractError("INTERNAL_ERROR", options.clock));
                  socket.disconnect(true);
                  return;
                }
                synchronizationAtStart.reservedDeliveries += 1;
              }
              try {
                if (await authorizeIdentityOnce(authorizations, socket.data.identity)) {
                  const synchronization = socket.data.synchronization;
                  if (synchronization?.status === "pending") {
                    synchronization.lobbyEvents.push(event);
                  } else if (
                    synchronization?.status === "ready" &&
                    event.eventSequence <= synchronization.baseline
                  ) {
                    return;
                  } else {
                    socket.emit("v1:lobby-event", event);
                  }
                } else {
                  socket.disconnect(true);
                }
              } finally {
                if (reserved) synchronizationAtStart.reservedDeliveries -= 1;
              }
            }),
          );
          queue.lastDelivered = {
            sequence: delivery.sequence,
            fingerprint,
          };
          rememberDeliveredLobbyEvent(lobbyId, queue.lastDelivered);
          rememberDeliveredLobbyEventFingerprint(lobbyId, delivery.sequence, fingerprint);
          delivery.resolve();
        } catch (error) {
          delivery.reject(error);
        }
      }
    } finally {
      queue.draining = false;
      if (queue.pending.length === 0) {
        if (lobbyDeliveryQueues.get(lobbyId) === queue) lobbyDeliveryQueues.delete(lobbyId);
      } else if (!queue.scheduled) {
        queue.scheduled = true;
        setImmediate(() => void drainLobbyDeliveries(lobbyId, queue));
      }
    }
  };
  const enqueueLobbyDelivery = (
    lobbyId: string,
    sequence: number,
    loadEvent: () => Promise<ActiveLobbyEvent>,
  ): Promise<void> => {
    let queue = lobbyDeliveryQueues.get(lobbyId);
    if (queue === undefined) {
      queue = {
        pending: [],
        draining: false,
        lastDelivered: lastDeliveredLobbyEvents.get(lobbyId) ?? null,
        scheduled: false,
      };
      lobbyDeliveryQueues.set(lobbyId, queue);
    }
    const delivery = new Promise<void>((resolve, reject) => {
      queue.pending.push({ sequence, loadEvent, resolve, reject });
    });
    if (!queue.draining && !queue.scheduled) {
      queue.scheduled = true;
      setImmediate(() => void drainLobbyDeliveries(lobbyId, queue));
    }
    return delivery;
  };

  const emitLobbyEvent = async (lobbyId: string, event: ActiveLobbyEvent): Promise<void> => {
    const parsed = ActiveLobbyEventSchema.parse(event);
    await enqueueLobbyDelivery(lobbyId, parsed.eventSequence, async () => parsed);
    await reconcileAutomaticCall(lobbyId);
  };

  const emitParticipantEvent = async (
    participantId: string,
    event: ParticipantPrivateEvent,
  ): Promise<void> => {
    const parsed = ParticipantPrivateEventSchema.parse(event);
    const sockets = await io.in(room("participant", participantId)).fetchSockets();
    const authorizations = new Map<string, Promise<boolean>>();
    await Promise.all(
      sockets.map(async (socket) => {
        const synchronizationAtStart = socket.data.synchronization;
        const reserved = synchronizationAtStart?.status === "pending";
        if (reserved) {
          if (
            synchronizationAtStart.lobbyEvents.length +
              synchronizationAtStart.participantEvents.length +
              synchronizationAtStart.reservedDeliveries >=
            MAXIMUM_PENDING_SYNCHRONIZATION_EVENTS
          ) {
            socket.emit("v1:error", createContractError("INTERNAL_ERROR", options.clock));
            socket.disconnect(true);
            return;
          }
          synchronizationAtStart.reservedDeliveries += 1;
        }
        try {
          if (await authorizeIdentityOnce(authorizations, socket.data.identity)) {
            const synchronization = socket.data.synchronization;
            if (synchronization?.status === "pending") {
              synchronization.participantEvents.push(parsed);
            } else {
              socket.emit("v1:private-event", parsed);
            }
          } else {
            socket.disconnect(true);
          }
        } finally {
          if (reserved) synchronizationAtStart.reservedDeliveries -= 1;
        }
      }),
    );
  };

  io.on("connection", (socket) => {
    const identity = socket.data.identity;
    const establishSnapshotBaseline = async (joinRooms: boolean): Promise<boolean> => {
      const previousSynchronization = socket.data.synchronization;
      const synchronization = {
        status: "pending" as const,
        lobbyEvents: [] as ActiveLobbyEvent[],
        participantEvents: [] as ParticipantPrivateEvent[],
        reservedDeliveries: 0,
      };
      socket.data.synchronization = synchronization;
      try {
        if (joinRooms) {
          await socket.join([
            room("lobby", identity.lobbyId),
            room("participant", identity.participantId),
          ]);
        }
        const snapshot = await options.snapshotProvider.findAuthorizedSnapshot(identity);
        if (!socket.connected) return false;
        if (snapshot === null) {
          socket.emit("v1:error", createContractError("UNAUTHORIZED", options.clock));
          socket.disconnect(true);
          return false;
        }
        const message = SnapshotMessageSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "snapshot",
          snapshot,
        });
        socket.emit("v1:snapshot", message);

        const baseline = message.snapshot.lastEventSequence ?? 0;
        synchronization.lobbyEvents
          .filter((event) => event.eventSequence > baseline)
          .sort((left, right) => left.eventSequence - right.eventSequence)
          .forEach((event) => socket.emit("v1:lobby-event", event));
        synchronization.participantEvents.forEach((event) =>
          socket.emit("v1:private-event", event),
        );
        socket.data.synchronization = { status: "ready", baseline };
        return true;
      } catch {
        if (socket.connected) {
          socket.emit("v1:error", createContractError("INTERNAL_ERROR", options.clock));
          if (previousSynchronization?.status === "ready") {
            synchronization.lobbyEvents
              .filter((event) => event.eventSequence > previousSynchronization.baseline)
              .sort((left, right) => left.eventSequence - right.eventSequence)
              .forEach((event) => socket.emit("v1:lobby-event", event));
            synchronization.participantEvents.forEach((event) =>
              socket.emit("v1:private-event", event),
            );
            socket.data.synchronization = previousSynchronization;
          } else {
            socket.disconnect(true);
          }
        }
        return false;
      }
    };
    let releaseRequested = false;
    let presenceReleased = false;
    const registration = options.presenceLifecycle.registerConnection(identity);
    const releasePresence = async () => {
      releaseRequested = true;
      const presenceGeneration = await registration;
      if (presenceGeneration === null || presenceReleased) return;
      presenceReleased = true;
      let unregisterConnection: ReturnType<
        GameServerOptions["presenceLifecycle"]["unregisterConnection"]
      >;
      try {
        unregisterConnection = options.presenceLifecycle.unregisterConnection(
          identity,
          presenceGeneration,
        );
      } catch (error) {
        reportAuthorityFailure();
        throw error;
      }
      const grace = await unregisterConnection.catch((error: unknown) => {
        reportAuthorityFailure();
        throw error;
      });
      if (grace !== null) schedulePresenceGrace(grace);
    };
    socket.once("disconnect", () => trackAuthorityTask(releasePresence()));
    const initialization = (async () => {
      try {
        const presenceGeneration = await registration;
        if (presenceGeneration === null) {
          if (socket.connected) {
            socket.emit("v1:error", createContractError("UNAUTHORIZED", options.clock));
            socket.disconnect(true);
          }
          return false;
        }
        if (!socket.connected || releaseRequested) return false;
        return establishSnapshotBaseline(true);
      } catch {
        if (socket.connected) {
          socket.emit("v1:error", createContractError("INTERNAL_ERROR", options.clock));
          socket.disconnect(true);
        }
        return false;
      }
    })();

    let commandInFlight = false;
    socket.on("v1:command", async (payload) => {
      const commandId = commandIdFromPayload(payload);
      const withinCommandLimit = commandRateLimiter.consume(
        identity.participantSessionId,
        commandLimit,
        options.clock().getTime(),
      );
      if (!withinCommandLimit || commandInFlight) {
        socket.emit("v1:error", createContractError("RATE_LIMITED", options.clock, commandId));
        return;
      }
      commandInFlight = true;
      try {
        if (!(await initialization)) return;
        const parsed = RealtimeCommandSchema.safeParse(payload);
        if (!parsed.success) {
          socket.emit(
            "v1:error",
            createContractError("INVALID_PAYLOAD", options.clock, commandIdFromPayload(payload)),
          );
          return;
        }

        if (parsed.data.type === "heartbeat") {
          try {
            if (!(await options.presenceLifecycle.recordHeartbeat(identity))) {
              socket.emit("v1:error", createContractError("UNAUTHORIZED", options.clock));
              socket.disconnect(true);
            }
          } catch {
            socket.emit("v1:error", createContractError("INTERNAL_ERROR", options.clock));
            socket.disconnect(true);
          }
          return;
        }

        if (parsed.data.type === "resync") {
          await establishSnapshotBaseline(false);
          return;
        }

        try {
          const result = await options.commandExecutor.execute({
            identity,
            command: parsed.data,
          });
          if (!result.ok) {
            socket.emit(
              "v1:error",
              createContractError(result.error.code, options.clock, parsed.data.commandId),
            );
            if (
              result.error.code === "UNAUTHORIZED" ||
              result.error.code === "NOT_FOUND" ||
              result.error.code === "LOBBY_EXPIRED"
            ) {
              socket.disconnect(true);
            }
            return;
          }

          const acknowledgement = CommandAckSchema.parse(result.acknowledgement);
          if (acknowledgement.commandId !== parsed.data.commandId) {
            throw new Error("Committed acknowledgement does not match the incoming command.");
          }
          if (result.activeLobbyEvent !== null) {
            const event = ActiveLobbyEventSchema.parse(result.activeLobbyEvent);
            if (
              acknowledgement.scope !== "active-lobby" ||
              acknowledgement.eventSequence !== event.eventSequence ||
              result.participantPrivateEvent !== null ||
              acknowledgement.idempotentReplay
            ) {
              throw new Error("Committed lobby event delivery metadata is inconsistent.");
            }
            await emitLobbyEvent(identity.lobbyId, event);
          } else if (result.participantPrivateEvent !== null) {
            const event = ParticipantPrivateEventSchema.parse(result.participantPrivateEvent);
            if (
              acknowledgement.scope !== "participant-private" ||
              (event.type === "mark-result" && event.commandId !== acknowledgement.commandId)
            ) {
              throw new Error("Committed private event delivery metadata is inconsistent.");
            }
            if (acknowledgement.idempotentReplay) {
              socket.emit("v1:private-event", event);
            } else {
              await emitParticipantEvent(identity.participantId, event);
            }
          } else if (!acknowledgement.idempotentReplay) {
            throw new Error("Committed replay delivery metadata is inconsistent.");
          }
          socket.emit("v1:ack", acknowledgement);
        } catch {
          socket.emit(
            "v1:error",
            createContractError("INTERNAL_ERROR", options.clock, parsed.data.commandId),
          );
        }
      } finally {
        commandInFlight = false;
      }
    });
  });

  return {
    failure,
    async listen({ host, port }) {
      await recoverAutomaticCalls();
      if (closed || authorityFailed) throw new Error("Game server authority is closed.");
      const address = await listen(httpServer, host, port);
      return { host: address.address, port: address.port };
    },
    async close() {
      if (closed) return Promise.resolve();
      closed = true;
      stopAuthorityWork();
      fatalPresenceClose ??= new Promise<void>((resolve) => io.close(() => resolve()));
      await fatalPresenceClose;
      await Promise.all([...pendingAuthorityTasks]);
    },
    publishLobbyEvent(lobbyId, event) {
      return emitLobbyEvent(lobbyId, event);
    },
    async publishLobbyEventFromSource(lobbyId, sequence, loadEvent) {
      await enqueueLobbyDelivery(lobbyId, sequence, loadEvent);
      await reconcileAutomaticCall(lobbyId);
    },
    publishParticipantEvent(participantId, event) {
      return emitParticipantEvent(participantId, event);
    },
  };
}
