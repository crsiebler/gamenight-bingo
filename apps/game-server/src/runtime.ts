import { randomBytes, randomUUID } from "node:crypto";

import {
  ActiveLobbyEventSchema,
  CONTRACT_SCHEMA_VERSION,
  CommandAckSchema,
  parseRuntimeConfig,
} from "@gamenight-bingo/contracts";
import {
  connectDatabase,
  type ActiveLobbyEventSubscriber,
  type ActiveLobbyEventSubscription,
} from "@gamenight-bingo/database";
import { patternCatalog } from "@gamenight-bingo/patterns";

import { createGameServer, type GameServer } from "./socket-server.js";

export interface GameServerConfiguration {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly allowedOrigin: string;
}

export class GameServerConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid game-server configuration:\n- ${issues.join("\n- ")}`);
    this.name = "GameServerConfigurationError";
    this.issues = Object.freeze([...issues]);
  }
}

export function parseGameServerConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): GameServerConfiguration {
  const issues: string[] = [];
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    issues.push("DATABASE_URL is required.");
  }

  const host = environment["GAME_SERVER_HOST"] ?? "127.0.0.1";
  if (host.length === 0 || /\s/.test(host)) {
    issues.push("GAME_SERVER_HOST must be nonempty and contain no whitespace.");
  }

  const rawPort = environment["GAME_SERVER_PORT"] ?? "3001";
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    issues.push("GAME_SERVER_PORT must be a decimal integer between 1 and 65535.");
  }

  const allowedOrigin = environment["WEB_ORIGIN"] ?? "http://localhost:3000";
  try {
    const parsedOrigin = new URL(allowedOrigin);
    if (
      (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") ||
      parsedOrigin.origin !== allowedOrigin ||
      parsedOrigin.username.length > 0 ||
      parsedOrigin.password.length > 0 ||
      parsedOrigin.pathname !== "/" ||
      parsedOrigin.search.length > 0 ||
      parsedOrigin.hash.length > 0
    ) {
      throw new Error("invalid origin");
    }
  } catch {
    issues.push(
      "WEB_ORIGIN must be an HTTP or HTTPS origin without credentials, path, query, or fragment.",
    );
  }

  if (issues.length > 0) throw new GameServerConfigurationError(issues);
  return Object.freeze({ databaseUrl: databaseUrl!, host, port, allowedOrigin });
}

export interface RunningGameServer {
  readonly address: { readonly host: string; readonly port: number };
  readonly completion: Promise<void>;
  close(): Promise<void>;
}

interface SupervisedGameServerResources {
  readonly address: { readonly host: string; readonly port: number };
  readonly eventSubscription: ActiveLobbyEventSubscription;
  readonly server: Pick<GameServer, "close" | "failure">;
  readonly disconnectDatabase: () => Promise<void>;
}

export function superviseGameServerResources(
  resources: SupervisedGameServerResources,
): RunningGameServer {
  let shutdownPromise: Promise<void> | null = null;
  let fatalRuntimeFailure = false;
  let completionSettled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (reason: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const rejectSafeShutdown = () => {
    if (!completionSettled) {
      completionSettled = true;
      rejectCompletion(new Error("The game server failed to shut down safely."));
    }
  };
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      try {
        await resources.server.close();
      } finally {
        try {
          await resources.eventSubscription.close();
        } finally {
          await resources.disconnectDatabase();
        }
      }
    })();
    return shutdownPromise;
  };
  void resources.eventSubscription.completion.catch(() => {
    fatalRuntimeFailure = true;
    void shutdown().then(
      () => {
        if (!completionSettled) {
          completionSettled = true;
          rejectCompletion(new Error("Active-lobby event subscription failed."));
        }
      },
      () => {
        rejectSafeShutdown();
      },
    );
  });
  void resources.server.failure.catch(() => {
    fatalRuntimeFailure = true;
    void shutdown().then(
      () => {
        if (!completionSettled) {
          completionSettled = true;
          rejectCompletion(new Error("Game server authority failed."));
        }
      },
      () => {
        rejectSafeShutdown();
      },
    );
  });

  return {
    address: resources.address,
    completion,
    async close() {
      try {
        await shutdown();
      } catch {
        rejectSafeShutdown();
        throw new Error("The game server failed to shut down safely.");
      }
      if (!fatalRuntimeFailure && !completionSettled) {
        completionSettled = true;
        resolveCompletion();
      }
    },
  };
}

export function subscribeGameServerToActiveLobbyEvents(
  subscriber: ActiveLobbyEventSubscriber,
  publisher: Pick<GameServer, "publishLobbyEventFromSource">,
): Promise<ActiveLobbyEventSubscription> {
  return subscriber.subscribe(async ({ lobbyId, sequence, loadEvent }) => {
    await publisher.publishLobbyEventFromSource(lobbyId, Number(sequence), async () => {
      const event = await loadEvent();
      return ActiveLobbyEventSchema.parse({
        ...event.payload,
        schemaVersion: event.schemaVersion,
        type: event.eventType,
        eventSequence: Number(event.sequence),
        occurredAt: event.createdAt.toISOString(),
      });
    });
  });
}

interface GameServerRuntimeDependencies {
  readonly connectDatabase: typeof connectDatabase;
  readonly createGameServer: typeof createGameServer;
}

const defaultGameServerRuntimeDependencies: GameServerRuntimeDependencies = {
  connectDatabase,
  createGameServer,
};

export async function startGameServerRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: GameServerRuntimeDependencies = defaultGameServerRuntimeDependencies,
): Promise<RunningGameServer> {
  const runtimeConfiguration = parseRuntimeConfig(environment);
  const configuration = parseGameServerConfiguration(environment);
  const database = await dependencies.connectDatabase(configuration.databaseUrl, {
    roundCommands: {
      patterns: patternCatalog,
      clock: () => new Date(),
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      nextId: (prefix) => `${prefix}-${randomUUID()}`,
    },
  });
  let initialPresenceGracePeriods;
  try {
    initialPresenceGracePeriods = await database.lobbyStates.findRealtimePresenceGracePeriods();
  } catch (error) {
    await database.disconnect();
    throw error;
  }
  const server = dependencies.createGameServer({
    allowedOrigin: configuration.allowedOrigin,
    clock: () => new Date(),
    initialPresenceGracePeriods,
    ticketConsumer: database.lobbyStates,
    commandExecutor: {
      execute: async ({ identity, command }) => {
        const result = await database.roundCommands.executeAuthenticated({
          ...identity,
          command,
        });
        if (!result.ok) return result;
        return {
          ...result,
          acknowledgement: CommandAckSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "ack",
            ...result.acknowledgement,
            occurredAt: result.acknowledgement.occurredAt.toISOString(),
          }),
        };
      },
    },
    snapshotProvider: {
      findAuthorizedSnapshot: (identity) =>
        database.lobbyStates.findAuthorizedSnapshotByIdentity({ ...identity }),
    },
    identityAuthorizer: {
      isIdentityActive: (identity) =>
        database.lobbyStates.isParticipantSessionIdentityActive({ ...identity }),
    },
    presenceLifecycle: {
      registerConnection: (identity) =>
        database.lobbyStates.registerRealtimeConnection({ ...identity }),
      recordHeartbeat: (identity) => database.lobbyStates.recordRealtimeHeartbeat({ ...identity }),
      unregisterConnection: (identity, presenceGeneration) =>
        database.lobbyStates.unregisterRealtimeConnection({
          ...identity,
          presenceGeneration,
          reconnectWindowSeconds: runtimeConfiguration.playerReconnectWindowSeconds,
          disconnectPauseGraceSeconds: runtimeConfiguration.disconnectPauseGraceSeconds,
        }),
      expireGracePeriod: (grace) => database.lobbyStates.expireRealtimePresenceGrace(grace),
    },
    automaticCallLifecycle: {
      findAutomaticCallLeases: () => database.roundCommands.findAutomaticCallLeases(),
      findAutomaticCallLease: (lobbyId) => database.roundCommands.findAutomaticCallLease(lobbyId),
      executeAutomaticCall: (lease) => database.roundCommands.executeAutomaticCall(lease),
    },
  });

  let eventSubscription: ActiveLobbyEventSubscription | null = null;
  try {
    eventSubscription = await subscribeGameServerToActiveLobbyEvents(
      database.activeLobbyEvents,
      server,
    );
    const address = await Promise.race([
      server.listen({
        host: configuration.host,
        port: configuration.port,
      }),
      server.failure.then(
        () => Promise.reject(new Error("Game server authority ended unexpectedly.")),
        () => Promise.reject(new Error("Game server authority failed.")),
      ),
      eventSubscription.completion.then(
        () => Promise.reject(new Error("Active-lobby event subscription ended unexpectedly.")),
        () => Promise.reject(new Error("Active-lobby event subscription failed.")),
      ),
    ]);
    return superviseGameServerResources({
      address,
      eventSubscription,
      server,
      disconnectDatabase: () => database.disconnect(),
    });
  } catch (error) {
    try {
      await server.close();
    } finally {
      try {
        await eventSubscription?.close();
      } finally {
        await database.disconnect();
      }
    }
    throw error;
  }
}
