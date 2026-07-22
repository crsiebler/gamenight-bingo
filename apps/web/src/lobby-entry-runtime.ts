import { env } from "node:process";
import { randomBytes, randomUUID } from "node:crypto";

import {
  CONTRACT_SCHEMA_VERSION,
  ErrorSchema,
  parseRuntimeConfig,
} from "@gamenight-bingo/contracts";
import {
  connectDatabase,
  createOperationalLogger,
  createReadinessProbe,
  type DatabaseConnection,
  type OperationalLogger,
} from "@gamenight-bingo/database";
import { generateLobbyCode } from "@gamenight-bingo/domain";
import { patternCatalog } from "@gamenight-bingo/patterns";
import { themeCatalog } from "@gamenight-bingo/themes";

import {
  createInMemoryRateLimiter,
  createLobbyEntryHttpHandler,
  requesterKeyFromTrustedProxy,
} from "./lobby-entry-http.js";
import { createWebHealthHandler } from "./health.js";

const runtimeConfig = parseRuntimeConfig(env);
const databaseUrl = runtimeConfig.databaseUrl;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required to start the web application.");
}

const rateLimiter = createInMemoryRateLimiter(
  { create: 10, join: 30, rejoin: 30, ticket: 30, status: 60, snapshot: 60, command: 120 },
  60_000,
);
const trustedProxySecret = runtimeConfig.trustedProxySecret;
const allowedOrigin = runtimeConfig.webOrigin ?? "http://localhost:3000";

type LobbyEntryHandler = ReturnType<typeof createLobbyEntryHttpHandler>;
const runtimeGlobal = globalThis as typeof globalThis & {
  webDatabase?: Promise<DatabaseConnection>;
  lobbyEntryHandler?: Promise<LobbyEntryHandler>;
  webOperationalLogger?: OperationalLogger;
  webReadinessCheck?: () => Promise<boolean>;
};
const operationalLogger =
  runtimeGlobal.webOperationalLogger ?? createOperationalLogger({ service: "web" });
runtimeGlobal.webOperationalLogger = operationalLogger;
const database =
  runtimeGlobal.webDatabase ??
  connectDatabase(databaseUrl, {
    transactionRetry: { observer: (event) => operationalLogger.transactionRetry(event) },
    roundCommands: {
      patterns: patternCatalog,
      nearWinFeedbackEnabled: true,
      coWinnerWindowMs: runtimeConfig.coWinnerWindowMs,
      clock: () => new Date(),
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      nextId: (prefix) => `${prefix}-${randomUUID()}`,
    },
  });
runtimeGlobal.webDatabase = database;
// Readiness and API requests still observe the rejection; this prevents an idle startup rejection.
void database.catch(() => undefined);
function getLobbyEntryHandler(): Promise<LobbyEntryHandler> {
  const existing = runtimeGlobal.lobbyEntryHandler;
  if (existing !== undefined) return existing;

  const created = database.then((databaseConnection) =>
    createLobbyEntryHttpHandler({
      store: databaseConnection.lobbyStates,
      roundCommandExecutor: databaseConnection.roundCommands,
      patterns: patternCatalog,
      rateLimiter,
      requesterKey: (request) => requesterKeyFromTrustedProxy(request, trustedProxySecret),
      clock: () => new Date(),
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      nextId: (prefix) => `${prefix}-${randomUUID()}`,
      nextLobbyCode: () => generateLobbyCode((length) => new Uint8Array(randomBytes(length))),
      maxPlayersPerLobby: runtimeConfig.maxPlayersPerLobby,
      maxActiveLobbies: runtimeConfig.maxActiveLobbies,
      realtimeTicketTtlSeconds: runtimeConfig.realtimeTicketTtlSeconds,
      allowedOrigin,
      allowedThemeIds: new Set(themeCatalog.map(({ id }) => id)),
      operationalLogger,
    }),
  );
  runtimeGlobal.lobbyEntryHandler = created;
  return created;
}
const readinessCheck =
  runtimeGlobal.webReadinessCheck ??
  createReadinessProbe(async () => (await database).checkReadiness());
runtimeGlobal.webReadinessCheck = readinessCheck;
export const handleWebHealthRequest = createWebHealthHandler(readinessCheck);

export async function handleLobbyEntryRequest(request: Request): Promise<Response> {
  try {
    return await (
      await getLobbyEntryHandler()
    )(request);
  } catch {
    const occurredAt = new Date().toISOString();
    return Response.json(
      ErrorSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "error",
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        commandId: null,
        occurredAt,
        retryable: true,
        issues: [],
      }),
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
