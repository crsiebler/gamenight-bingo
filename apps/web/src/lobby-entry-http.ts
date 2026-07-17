import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  CallNextCommandSchema,
  CommandAckSchema,
  CONTRACT_SCHEMA_VERSION,
  ConfigureCommandSchema,
  ContinueRoundCommandSchema,
  CreateLobbyRequestSchema,
  CreateRoundCommandSchema,
  EndRoundCommandSchema,
  ErrorSchema,
  JoinLobbyRequestSchema,
  LobbyCodeSchema,
  LobbyEntryResponseSchema,
  MarkCardCommandSchema,
  PauseRoundCommandSchema,
  PatternCatalogResponseSchema,
  RealtimeTicketRequestSchema,
  RealtimeTicketResponseSchema,
  RejoinLobbyRequestSchema,
  ResumeRoundCommandSchema,
  SameDeviceSessionStatusResponseSchema,
  SnapshotMessageSchema,
  StartRoundCommandSchema,
  type ContractError,
  type ErrorCode,
  type LobbyEntryResponse,
  type MutationCommand,
  type Snapshot,
} from "@gamenight-bingo/contracts";
import { normalizeLobbyCodeEntry } from "@gamenight-bingo/domain";

import {
  hashCanonicalParticipantSessionToken,
  PARTICIPANT_SESSION_COOKIE_NAME,
  resolveSameDeviceSession,
  type ParticipantSessionStore,
} from "./participant-session.js";

const MAX_BODY_BYTES = 4_096;
const SESSION_ENTROPY_BYTES = 32;
const MAX_CREDENTIAL_ATTEMPTS = 3;
const PRIVATE_HEADERS = { "cache-control": "no-store" } as const;

export type EntryRateLimitScope =
  "create" | "join" | "rejoin" | "ticket" | "status" | "snapshot" | "command";

export interface EntryRateLimiter {
  consume(input: {
    readonly scope: EntryRateLimitScope;
    readonly key: string;
    readonly now: Date;
  }): { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };
}

export interface LobbyEntryRecord {
  readonly commandId: string;
  readonly idempotentReplay: boolean;
  readonly lobbyId: string;
  readonly lobbyCode: string;
  readonly themeId: string;
  readonly participantId: string;
  readonly username: string;
  readonly role: "host" | "player";
  readonly roundEligibility: "playing" | "waiting";
  readonly sessionId: string;
  readonly issuedAt: Date;
}

interface NewEntrySession {
  readonly commandId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly tokenHash: Uint8Array;
  readonly issuedAt: Date;
}

export interface CreateLobbyWithHostInput extends NewEntrySession {
  readonly lobbyId: string;
  readonly themeId: string;
  readonly maxActiveLobbies: number;
  readonly nextCode: () => string;
}

export interface JoinLobbyWithSessionInput extends NewEntrySession {
  readonly lobbyId: string;
  readonly lobbyCode: string;
  readonly maxPlayersPerLobby: number;
}

type EntryStoreErrorCode =
  | "ACTIVE_LOBBY_LIMIT_REACHED"
  | "LOBBY_FULL"
  | "LOBBY_NOT_FOUND"
  | "COMMAND_REPLAY_MISMATCH"
  | "USERNAME_TAKEN"
  | "USERNAME_EMPTY"
  | "USERNAME_CONTROL_CHARACTER"
  | "USERNAME_TOO_LONG";

export type EntryStoreResult =
  | { readonly ok: true; readonly entry: LobbyEntryRecord }
  | {
      readonly ok: false;
      readonly error: { readonly code: EntryStoreErrorCode | "TOKEN_HASH_COLLISION" };
    };

export interface RoundCommandAcknowledgement {
  readonly commandId: string;
  readonly scope: "active-lobby" | "participant-private";
  readonly eventSequence: number | null;
  readonly occurredAt: Date;
  readonly idempotentReplay: boolean;
}

export type RoundCommandExecutionResult =
  | { readonly ok: true; readonly acknowledgement: RoundCommandAcknowledgement }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_COMMAND" | "NOT_FOUND";
      };
    };

export interface LobbyEntryStore extends ParticipantSessionStore {
  createLobbyWithHost(input: CreateLobbyWithHostInput): Promise<EntryStoreResult>;
  joinLobbyWithSession(input: JoinLobbyWithSessionInput): Promise<EntryStoreResult>;
  rejoinLobbyWithSession(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
    readonly commandId: string;
  }): Promise<EntryStoreResult | null>;
  findActiveLobbyIdByCode(code: string): Promise<string | null>;
  findAuthorizedSnapshot(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<Snapshot | null>;
  issueRealtimeTicket(input: {
    readonly lobbyId: string;
    readonly sessionTokenHash: Uint8Array;
    readonly ticketHash: Uint8Array;
    readonly ttlSeconds: number;
  }): Promise<
    | { readonly ok: true; readonly expiresAt: Date }
    | {
        readonly ok: false;
        readonly error: { readonly code: "TICKET_HASH_COLLISION" | "UNAUTHORIZED" };
      }
  >;
}

export interface RoundCommandExecutor {
  execute(input: {
    readonly lobbyId: string;
    readonly sessionTokenHash: Uint8Array;
    readonly command: MutationCommand;
  }): Promise<RoundCommandExecutionResult>;
}

export interface LobbyEntryHttpDependencies {
  readonly store: LobbyEntryStore;
  readonly roundCommandExecutor: RoundCommandExecutor;
  readonly patterns: readonly unknown[];
  readonly rateLimiter: EntryRateLimiter;
  readonly requesterKey: (request: Request) => string;
  readonly clock: () => Date;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly nextId: (prefix: "lobby" | "participant" | "session") => string;
  readonly nextLobbyCode: () => string;
  readonly maxPlayersPerLobby: number;
  readonly maxActiveLobbies: number;
  readonly realtimeTicketTtlSeconds: number;
}

interface Credential {
  readonly token: string;
  readonly tokenHash: Uint8Array;
}

interface ParsedBody {
  readonly ok: true;
  readonly value: unknown;
}

interface BodyError {
  readonly ok: false;
  readonly status: 413 | 415;
}

function createCredential(randomBytes: (length: number) => Uint8Array): Credential {
  const entropy = randomBytes(SESSION_ENTROPY_BYTES);
  if (entropy.length !== SESSION_ENTROPY_BYTES) {
    throw new RangeError("The random byte source must return the requested number of bytes.");
  }
  const token = Buffer.from(entropy).toString("base64url");
  return {
    token,
    tokenHash: createHash("sha256").update(token, "ascii").digest(),
  };
}

function parseCookie(request: Request): string | undefined {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(`${PARTICIPANT_SESSION_COOKIE_NAME}=`))
    .map((cookie) => cookie.slice(PARTICIPANT_SESSION_COOKIE_NAME.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

function serializeCookie(token: string, lobbyCode: string): string {
  return `${PARTICIPANT_SESSION_COOKIE_NAME}=${token}; Path=/api/v1/lobbies/${lobbyCode}; HttpOnly; Secure; SameSite=Strict`;
}

function entryResponse(entry: LobbyEntryRecord): LobbyEntryResponse {
  return LobbyEntryResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    type: "lobby-entry",
    commandId: entry.commandId,
    idempotentReplay: entry.idempotentReplay,
    lobby: {
      id: entry.lobbyId,
      code: entry.lobbyCode,
      themeId: entry.themeId,
    },
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
  });
}

function errorResponse(
  code: ErrorCode,
  status: number,
  now: Date,
  commandId: string | null = null,
  retryAfterSeconds?: number,
): Response {
  const messageByCode = {
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
  } as const satisfies Record<ErrorCode, ContractError["message"]>;
  const body = ErrorSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    type: "error",
    code,
    message: messageByCode[code],
    commandId,
    occurredAt: now.toISOString(),
    retryable: code === "RATE_LIMITED" || code === "INTERNAL_ERROR",
    issues: [],
  });
  const headers = new Headers(PRIVATE_HEADERS);
  if (retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(retryAfterSeconds));
  }
  return Response.json(body, { status, headers });
}

async function parseBody(request: Request): Promise<ParsedBody | BodyError> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return { ok: false, status: 415 };
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: true, value: undefined };
  }
}

function hasValidOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}

function normalizeCode(value: string): string | null {
  const parsed = LobbyCodeSchema.safeParse(normalizeLobbyCodeEntry(value));
  return parsed.success ? parsed.data : null;
}

function consumeRateLimit(
  dependencies: LobbyEntryHttpDependencies,
  scope: EntryRateLimitScope,
  request: Request,
  commandId: string | null,
): Response | null {
  const now = dependencies.clock();
  const result = dependencies.rateLimiter.consume({
    scope,
    key: dependencies.requesterKey(request),
    now,
  });
  return result.allowed
    ? null
    : errorResponse("RATE_LIMITED", 429, now, commandId, result.retryAfterSeconds);
}

function mapStoreError(
  result: Extract<EntryStoreResult, { readonly ok: false }>,
  now: Date,
  commandId: string,
): Response | null {
  switch (result.error.code) {
    case "TOKEN_HASH_COLLISION":
      return null;
    case "ACTIVE_LOBBY_LIMIT_REACHED":
      return errorResponse("ACTIVE_LOBBY_LIMIT_REACHED", 503, now, commandId);
    case "LOBBY_FULL":
      return errorResponse("LOBBY_FULL", 409, now, commandId);
    case "USERNAME_TAKEN":
      return errorResponse("USERNAME_TAKEN", 409, now, commandId);
    case "LOBBY_NOT_FOUND":
      return errorResponse("NOT_FOUND", 404, now, commandId);
    case "COMMAND_REPLAY_MISMATCH":
      return errorResponse("INVALID_COMMAND", 409, now, commandId);
    case "USERNAME_EMPTY":
    case "USERNAME_CONTROL_CHARACTER":
    case "USERNAME_TOO_LONG":
      return errorResponse("INVALID_PAYLOAD", 400, now, commandId);
  }
}

function privateJson(body: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers(PRIVATE_HEADERS);
  if (cookie !== undefined) {
    headers.set("set-cookie", cookie);
  }
  return Response.json(body, { status, headers });
}

function parseRoundCommand(resource: string, value: unknown): MutationCommand | null {
  const schema =
    resource === "configuration"
      ? ConfigureCommandSchema
      : resource === "rounds"
        ? CreateRoundCommandSchema
        : resource === "rounds/current/start"
          ? StartRoundCommandSchema
          : resource === "rounds/current/pause"
            ? PauseRoundCommandSchema
            : resource === "rounds/current/resume"
              ? ResumeRoundCommandSchema
              : resource === "rounds/current/call-next"
                ? CallNextCommandSchema
                : resource === "rounds/current/continue"
                  ? ContinueRoundCommandSchema
                  : resource === "rounds/current/end"
                    ? EndRoundCommandSchema
                    : resource === "cards/own/marks"
                      ? MarkCardCommandSchema
                      : null;
  if (schema === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createInMemoryRateLimiter(
  limits: Readonly<Record<EntryRateLimitScope, number>>,
  windowMs: number,
  maxBucketsPerScope = 1_024,
): EntryRateLimiter {
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError("The rate-limit window must be a positive safe integer.");
  }
  for (const limit of Object.values(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Rate limits must be positive safe integers.");
    }
  }
  if (!Number.isSafeInteger(maxBucketsPerScope) || maxBucketsPerScope < 1) {
    throw new RangeError("The rate-limiter bucket bound must be a positive safe integer.");
  }
  const buckets = new Map<EntryRateLimitScope, Map<string, { count: number; resetAt: number }>>([
    ["create", new Map()],
    ["join", new Map()],
    ["rejoin", new Map()],
    ["ticket", new Map()],
    ["status", new Map()],
    ["snapshot", new Map()],
    ["command", new Map()],
  ]);
  return {
    consume({ scope, key, now }) {
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) throw new RangeError("Rate-limit timestamps must be valid.");
      if (key.length < 1 || key.length > 128) {
        throw new RangeError("Rate-limit keys must contain between 1 and 128 characters.");
      }
      const scopeBuckets = buckets.get(scope);
      if (scopeBuckets === undefined) throw new RangeError("The rate-limit scope is invalid.");
      for (const [candidateKey, candidate] of scopeBuckets) {
        if (nowMs >= candidate.resetAt) scopeBuckets.delete(candidateKey);
      }
      const current = scopeBuckets.get(key);
      if (current === undefined && scopeBuckets.size >= maxBucketsPerScope) {
        const earliestReset = Math.min(
          ...Array.from(scopeBuckets.values(), ({ resetAt }) => resetAt),
        );
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((earliestReset - nowMs) / 1_000)),
        };
      }
      const bucket = current === undefined ? { count: 0, resetAt: nowMs + windowMs } : current;
      if (bucket.count >= limits[scope]) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1_000)),
        };
      }
      bucket.count += 1;
      scopeBuckets.set(key, bucket);
      return { allowed: true };
    },
  };
}

export function requesterKeyFromTrustedProxy(
  request: Request,
  trustedProxySecret: string | undefined,
): string {
  const suppliedSecret = request.headers.get("x-gamenight-trusted-proxy");
  const trusted =
    trustedProxySecret !== undefined &&
    suppliedSecret !== null &&
    timingSafeEqual(
      createHash("sha256").update(suppliedSecret, "utf8").digest(),
      createHash("sha256").update(trustedProxySecret, "utf8").digest(),
    );
  const forwarded = request.headers.get("x-forwarded-for");
  const candidate = trusted ? forwarded?.split(",").at(-1)?.trim() : undefined;
  const addressVersion = candidate === undefined ? 0 : isIP(candidate);
  const normalizedAddress =
    addressVersion === 6 && candidate !== undefined
      ? new URL(`http://[${candidate}]/`).hostname.slice(1, -1)
      : addressVersion === 4 && candidate !== undefined
        ? candidate
        : "unidentified";
  return createHash("sha256").update(normalizedAddress, "utf8").digest("base64url");
}

export function createLobbyEntryHttpHandler(dependencies: LobbyEntryHttpDependencies) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/api/v1/patterns") {
      const body = PatternCatalogResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "pattern-catalog",
        patterns: dependencies.patterns,
      });
      return Response.json(body, {
        headers: { "cache-control": "public, max-age=300" },
      });
    }

    if (request.method === "POST" && pathname === "/api/v1/lobbies") {
      const now = dependencies.clock();
      if (!hasValidOrigin(request)) {
        return errorResponse("FORBIDDEN", 403, now);
      }
      const limited = consumeRateLimit(dependencies, "create", request, null);
      if (limited !== null) return limited;
      const parsedBody = await parseBody(request);
      if (!parsedBody.ok) {
        return errorResponse("INVALID_PAYLOAD", parsedBody.status, now);
      }
      const parsed = CreateLobbyRequestSchema.safeParse(parsedBody.value);
      if (!parsed.success) {
        return errorResponse("INVALID_PAYLOAD", 400, now);
      }
      for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
        const credential = createCredential(dependencies.randomBytes);
        const result = await dependencies.store.createLobbyWithHost({
          lobbyId: dependencies.nextId("lobby"),
          participantId: dependencies.nextId("participant"),
          sessionId: dependencies.nextId("session"),
          commandId: parsed.data.commandId,
          username: parsed.data.username,
          themeId: parsed.data.themeId,
          tokenHash: credential.tokenHash,
          issuedAt: now,
          maxActiveLobbies: dependencies.maxActiveLobbies,
          nextCode: dependencies.nextLobbyCode,
        });
        if (result.ok) {
          const cookie = result.entry.idempotentReplay
            ? undefined
            : serializeCookie(credential.token, result.entry.lobbyCode);
          return privateJson(
            entryResponse(result.entry),
            result.entry.idempotentReplay ? 200 : 201,
            cookie,
          );
        }
        const error = mapStoreError(result, now, parsed.data.commandId);
        if (error !== null) return error;
      }
      return errorResponse("INTERNAL_ERROR", 500, now, parsed.data.commandId);
    }

    const commandMatch =
      /^\/api\/v1\/lobbies\/([^/]+)\/(configuration|rounds|rounds\/current\/(?:start|pause|resume|call-next|continue|end)|cards\/own\/marks)$/.exec(
        pathname,
      );
    if (commandMatch !== null) {
      const now = dependencies.clock();
      if (request.method !== "POST") return errorResponse("NOT_FOUND", 404, now);
      if (!hasValidOrigin(request)) return errorResponse("FORBIDDEN", 403, now);
      const code = normalizeCode(commandMatch[1] ?? "");
      if (code === null) return errorResponse("NOT_FOUND", 404, now);
      const limited = consumeRateLimit(dependencies, "command", request, null);
      if (limited !== null) return limited;
      const parsedBody = await parseBody(request);
      if (!parsedBody.ok) return errorResponse("INVALID_PAYLOAD", parsedBody.status, now);
      const command = parseRoundCommand(commandMatch[2] ?? "", parsedBody.value);
      if (command === null) return errorResponse("INVALID_PAYLOAD", 400, now);
      const cookie = parseCookie(request);
      const sessionTokenHash =
        cookie === undefined ? null : hashCanonicalParticipantSessionToken(cookie);
      if (sessionTokenHash === null) {
        return errorResponse("UNAUTHORIZED", 401, now, command.commandId);
      }
      const lobbyId = await dependencies.store.findActiveLobbyIdByCode(code);
      if (lobbyId === null) return errorResponse("NOT_FOUND", 404, now, command.commandId);
      const result = await dependencies.roundCommandExecutor.execute({
        lobbyId,
        sessionTokenHash,
        command,
      });
      if (!result.ok) {
        const statusByCode = {
          UNAUTHORIZED: 401,
          FORBIDDEN: 403,
          INVALID_COMMAND: 409,
          NOT_FOUND: 404,
        } as const;
        return errorResponse(
          result.error.code,
          statusByCode[result.error.code],
          now,
          command.commandId,
        );
      }
      return privateJson(
        CommandAckSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "ack",
          ...result.acknowledgement,
          occurredAt: result.acknowledgement.occurredAt.toISOString(),
        }),
      );
    }

    const match =
      /^\/api\/v1\/lobbies\/([^/]+)\/(participants|session|session\/rejoin|realtime-ticket|snapshot)$/.exec(
        pathname,
      );
    if (match === null) {
      return errorResponse("NOT_FOUND", 404, dependencies.clock());
    }
    const code = normalizeCode(match[1] ?? "");
    if (code === null) {
      return errorResponse("NOT_FOUND", 404, dependencies.clock());
    }
    const resource = match[2];
    const supportedRoute =
      (request.method === "POST" && resource === "participants") ||
      (request.method === "GET" && resource === "session") ||
      (request.method === "POST" && resource === "session/rejoin") ||
      (request.method === "POST" && resource === "realtime-ticket") ||
      (request.method === "GET" && resource === "snapshot");
    if (!supportedRoute) {
      return errorResponse("NOT_FOUND", 404, dependencies.clock());
    }
    if (
      request.method === "POST" &&
      (resource === "participants" ||
        resource === "session/rejoin" ||
        resource === "realtime-ticket") &&
      !hasValidOrigin(request)
    ) {
      return errorResponse("FORBIDDEN", 403, dependencies.clock());
    }
    if (request.method === "POST" && resource === "participants") {
      const limited = consumeRateLimit(dependencies, "join", request, null);
      if (limited !== null) return limited;
    }
    if (request.method === "POST" && resource === "session/rejoin") {
      const limited = consumeRateLimit(dependencies, "rejoin", request, null);
      if (limited !== null) return limited;
    }
    if (request.method === "POST" && resource === "realtime-ticket") {
      const limited = consumeRateLimit(dependencies, "ticket", request, null);
      if (limited !== null) return limited;
    }
    if (request.method === "GET" && resource === "session") {
      const limited = consumeRateLimit(dependencies, "status", request, null);
      if (limited !== null) return limited;
    }
    if (request.method === "GET" && resource === "snapshot") {
      const limited = consumeRateLimit(dependencies, "snapshot", request, null);
      if (limited !== null) return limited;
    }
    const lobbyId = await dependencies.store.findActiveLobbyIdByCode(code);
    if (lobbyId === null) {
      return errorResponse("NOT_FOUND", 404, dependencies.clock());
    }

    if (request.method === "POST" && resource === "participants") {
      const now = dependencies.clock();
      const parsedBody = await parseBody(request);
      if (!parsedBody.ok) return errorResponse("INVALID_PAYLOAD", parsedBody.status, now);
      const parsed = JoinLobbyRequestSchema.safeParse(parsedBody.value);
      if (!parsed.success) return errorResponse("INVALID_PAYLOAD", 400, now);
      for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
        const credential = createCredential(dependencies.randomBytes);
        const result = await dependencies.store.joinLobbyWithSession({
          lobbyId,
          lobbyCode: code,
          participantId: dependencies.nextId("participant"),
          sessionId: dependencies.nextId("session"),
          commandId: parsed.data.commandId,
          username: parsed.data.username,
          tokenHash: credential.tokenHash,
          issuedAt: now,
          maxPlayersPerLobby: dependencies.maxPlayersPerLobby,
        });
        if (result.ok) {
          const cookie = result.entry.idempotentReplay
            ? undefined
            : serializeCookie(credential.token, code);
          return privateJson(
            entryResponse(result.entry),
            result.entry.idempotentReplay ? 200 : 201,
            cookie,
          );
        }
        const error = mapStoreError(result, now, parsed.data.commandId);
        if (error !== null) return error;
      }
      return errorResponse("INTERNAL_ERROR", 500, now, parsed.data.commandId);
    }

    if (request.method === "POST" && resource === "realtime-ticket") {
      const now = dependencies.clock();
      const parsedBody = await parseBody(request);
      if (!parsedBody.ok) return errorResponse("INVALID_PAYLOAD", parsedBody.status, now);
      const parsed = RealtimeTicketRequestSchema.safeParse(parsedBody.value);
      if (!parsed.success) return errorResponse("INVALID_PAYLOAD", 400, now);
      const cookie = parseCookie(request);
      const sessionTokenHash =
        cookie === undefined ? null : hashCanonicalParticipantSessionToken(cookie);
      if (sessionTokenHash === null) {
        return errorResponse("UNAUTHORIZED", 401, now);
      }
      for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
        const credential = createCredential(dependencies.randomBytes);
        const result = await dependencies.store.issueRealtimeTicket({
          lobbyId,
          sessionTokenHash,
          ticketHash: credential.tokenHash,
          ttlSeconds: dependencies.realtimeTicketTtlSeconds,
        });
        if (result.ok) {
          return privateJson(
            RealtimeTicketResponseSchema.parse({
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              type: "realtime-ticket",
              ticket: credential.token,
              expiresAt: result.expiresAt.toISOString(),
            }),
            201,
          );
        }
        if (result.error.code === "UNAUTHORIZED") {
          return errorResponse("UNAUTHORIZED", 401, now);
        }
      }
      return errorResponse("INTERNAL_ERROR", 500, now);
    }

    if (request.method === "GET" && resource === "session") {
      const resolved = await resolveSameDeviceSession(
        lobbyId,
        parseCookie(request),
        dependencies.store,
      );
      const body =
        resolved.status === "recognized"
          ? {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              type: "same-device-session-status",
              status: "active",
              username: resolved.session.username,
              role: resolved.session.role,
            }
          : resolved.status === "rejoin-available"
            ? {
                schemaVersion: CONTRACT_SCHEMA_VERSION,
                type: "same-device-session-status",
                status: "rejoin-available",
                username: resolved.session.username,
                rejoinUntil: resolved.session.rejoinUntil.toISOString(),
              }
            : {
                schemaVersion: CONTRACT_SCHEMA_VERSION,
                type: "same-device-session-status",
                status: "new-participant-required",
              };
      return privateJson(SameDeviceSessionStatusResponseSchema.parse(body));
    }

    if (request.method === "POST" && resource === "session/rejoin") {
      const now = dependencies.clock();
      const parsedBody = await parseBody(request);
      if (!parsedBody.ok) return errorResponse("INVALID_PAYLOAD", parsedBody.status, now);
      const parsed = RejoinLobbyRequestSchema.safeParse(parsedBody.value);
      if (!parsed.success) return errorResponse("INVALID_PAYLOAD", 400, now);
      const cookie = parseCookie(request);
      const tokenHash = cookie === undefined ? null : hashCanonicalParticipantSessionToken(cookie);
      if (tokenHash === null) {
        await dependencies.store.expireParticipantRejoinWindows(lobbyId);
        return errorResponse("UNAUTHORIZED", 401, now, parsed.data.commandId);
      }
      const result = await dependencies.store.rejoinLobbyWithSession({
        lobbyId,
        tokenHash,
        commandId: parsed.data.commandId,
      });
      if (result === null) {
        return errorResponse("UNAUTHORIZED", 401, now, parsed.data.commandId);
      }
      if (!result.ok) {
        return (
          mapStoreError(result, now, parsed.data.commandId) ??
          errorResponse("INTERNAL_ERROR", 500, now, parsed.data.commandId)
        );
      }
      return privateJson(entryResponse(result.entry));
    }

    if (request.method === "GET" && resource === "snapshot") {
      const now = dependencies.clock();
      const cookie = parseCookie(request);
      const tokenHash = cookie === undefined ? null : hashCanonicalParticipantSessionToken(cookie);
      if (tokenHash === null) {
        return errorResponse("UNAUTHORIZED", 401, now);
      }
      const snapshot = await dependencies.store.findAuthorizedSnapshot({
        lobbyId,
        tokenHash,
      });
      return snapshot === null
        ? errorResponse("UNAUTHORIZED", 401, now)
        : privateJson(
            SnapshotMessageSchema.parse({
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              type: "snapshot",
              snapshot,
            }),
          );
    }

    return errorResponse("NOT_FOUND", 404, dependencies.clock());
  };
}
