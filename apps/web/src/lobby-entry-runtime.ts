import { env } from "node:process";
import { randomBytes, randomUUID } from "node:crypto";

import {
  CONTRACT_SCHEMA_VERSION,
  ErrorSchema,
  parseRuntimeConfig,
} from "@gamenight-bingo/contracts";
import { connectDatabase } from "@gamenight-bingo/database";
import { generateLobbyCode } from "@gamenight-bingo/domain";
import { patternCatalog } from "@gamenight-bingo/patterns";

import {
  createInMemoryRateLimiter,
  createLobbyEntryHttpHandler,
  requesterKeyFromTrustedProxy,
} from "./lobby-entry-http.js";

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

type LobbyEntryHandler = ReturnType<typeof createLobbyEntryHttpHandler>;
const runtimeGlobal = globalThis as typeof globalThis & {
  lobbyEntryHandler?: Promise<LobbyEntryHandler>;
};
const handler =
  runtimeGlobal.lobbyEntryHandler ??
  connectDatabase(databaseUrl, {
    roundCommands: {
      patterns: patternCatalog,
      clock: () => new Date(),
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      nextId: (prefix) => `${prefix}-${randomUUID()}`,
    },
  }).then((database) =>
    createLobbyEntryHttpHandler({
      store: database.lobbyStates,
      roundCommandExecutor: database.roundCommands,
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
    }),
  );
runtimeGlobal.lobbyEntryHandler = handler;

export async function handleLobbyEntryRequest(request: Request): Promise<Response> {
  try {
    return await (
      await handler
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
