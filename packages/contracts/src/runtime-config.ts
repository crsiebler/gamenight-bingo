import { z } from "zod";

export type RuntimeConfig = Readonly<{
  maxPlayersPerLobby: number;
  maxActiveLobbies: number;
  lobbyIdleTtlSeconds: number;
  playerReconnectWindowSeconds: number;
  disconnectPauseGraceSeconds: number;
  realtimeTicketTtlSeconds: number;
  coWinnerWindowMs: number;
  databaseUrl?: string;
  publicGameServerUrl?: string;
  trustedProxySecret?: string;
}>;

type RuntimeConfigProperty = Exclude<
  keyof RuntimeConfig,
  "databaseUrl" | "publicGameServerUrl" | "trustedProxySecret"
>;

type RuntimeConfigDefinition = Readonly<{
  environmentKey: string;
  property: RuntimeConfigProperty;
  minimum: number;
  maximum: number;
}>;

export const RUNTIME_CONFIG_DEFAULTS: RuntimeConfig = Object.freeze({
  maxPlayersPerLobby: 25,
  maxActiveLobbies: 100,
  lobbyIdleTtlSeconds: 1_800,
  playerReconnectWindowSeconds: 120,
  disconnectPauseGraceSeconds: 10,
  realtimeTicketTtlSeconds: 60,
  coWinnerWindowMs: 2_000,
});

const CONFIG_DEFINITIONS: readonly RuntimeConfigDefinition[] = [
  {
    environmentKey: "MAX_PLAYERS_PER_LOBBY",
    property: "maxPlayersPerLobby",
    minimum: 1,
    maximum: 25,
  },
  {
    environmentKey: "MAX_ACTIVE_LOBBIES",
    property: "maxActiveLobbies",
    minimum: 1,
    maximum: 100,
  },
  {
    environmentKey: "LOBBY_IDLE_TTL_SECONDS",
    property: "lobbyIdleTtlSeconds",
    minimum: 1,
    maximum: 86_400,
  },
  {
    environmentKey: "PLAYER_RECONNECT_WINDOW_SECONDS",
    property: "playerReconnectWindowSeconds",
    minimum: 1,
    maximum: 3_600,
  },
  {
    environmentKey: "DISCONNECT_PAUSE_GRACE_SECONDS",
    property: "disconnectPauseGraceSeconds",
    minimum: 1,
    maximum: 300,
  },
  {
    environmentKey: "REALTIME_TICKET_TTL_SECONDS",
    property: "realtimeTicketTtlSeconds",
    minimum: 1,
    maximum: 300,
  },
  {
    environmentKey: "CO_WINNER_WINDOW_MS",
    property: "coWinnerWindowMs",
    minimum: 1,
    maximum: 10_000,
  },
];
const PUBLIC_HTTP_ORIGIN =
  /^https?:\/\/(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i;
const PUBLIC_HTTP_URL = z.url({ protocol: /^https?$/ });
export class RuntimeConfigurationError extends Error {
  readonly code = "RUNTIME_CONFIG_INVALID";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid runtime configuration:\n- ${issues.join("\n- ")}`);
    this.name = "RuntimeConfigurationError";
    this.issues = Object.freeze([...issues]);
  }
}

export function parseRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeConfig {
  const configuration: Record<RuntimeConfigProperty, number> & {
    databaseUrl?: string;
    publicGameServerUrl?: string;
    trustedProxySecret?: string;
  } = {
    ...RUNTIME_CONFIG_DEFAULTS,
  };
  const invalidProperties = new Set<RuntimeConfigProperty>();
  const issues: string[] = [];

  for (const definition of CONFIG_DEFINITIONS) {
    const rawValue = environment[definition.environmentKey];

    if (rawValue === undefined) {
      continue;
    }

    const parsedValue = /^\d+$/.test(rawValue) ? Number(rawValue) : Number.NaN;

    if (
      !Number.isSafeInteger(parsedValue) ||
      parsedValue < definition.minimum ||
      parsedValue > definition.maximum
    ) {
      invalidProperties.add(definition.property);
      issues.push(
        `${definition.environmentKey} must be a decimal integer between ${definition.minimum} and ${definition.maximum}.`,
      );
      continue;
    }

    configuration[definition.property] = parsedValue;
  }

  const databaseUrl = environment["DATABASE_URL"];
  if (databaseUrl !== undefined) {
    if (databaseUrl.trim().length === 0) {
      issues.push("DATABASE_URL must be nonempty when configured.");
    } else {
      configuration.databaseUrl = databaseUrl;
    }
  }

  const trustedProxySecret = environment["TRUSTED_PROXY_SECRET"];
  if (trustedProxySecret !== undefined) {
    if (trustedProxySecret.length < 32) {
      issues.push("TRUSTED_PROXY_SECRET must contain at least 32 characters when configured.");
    } else {
      configuration.trustedProxySecret = trustedProxySecret;
    }
  }

  const publicGameServerUrl = environment["NEXT_PUBLIC_GAME_SERVER_URL"];
  if (publicGameServerUrl !== undefined) {
    const match = PUBLIC_HTTP_ORIGIN.exec(publicGameServerUrl);
    const port = match?.[1] === undefined ? null : Number(match[1]);
    if (
      !PUBLIC_HTTP_URL.safeParse(publicGameServerUrl).success ||
      match === null ||
      (port !== null && (port < 1 || port > 65_535))
    ) {
      issues.push(
        "NEXT_PUBLIC_GAME_SERVER_URL must be one HTTP or HTTPS origin without credentials, path, query, or fragment.",
      );
    } else {
      configuration.publicGameServerUrl = publicGameServerUrl;
    }
  }

  if (
    !invalidProperties.has("disconnectPauseGraceSeconds") &&
    !invalidProperties.has("playerReconnectWindowSeconds") &&
    configuration.disconnectPauseGraceSeconds >= configuration.playerReconnectWindowSeconds
  ) {
    issues.push(
      "DISCONNECT_PAUSE_GRACE_SECONDS must be less than PLAYER_RECONNECT_WINDOW_SECONDS.",
    );
  }

  if (
    !invalidProperties.has("realtimeTicketTtlSeconds") &&
    !invalidProperties.has("playerReconnectWindowSeconds") &&
    configuration.realtimeTicketTtlSeconds > configuration.playerReconnectWindowSeconds
  ) {
    issues.push("REALTIME_TICKET_TTL_SECONDS must not exceed PLAYER_RECONNECT_WINDOW_SECONDS.");
  }

  if (
    !invalidProperties.has("playerReconnectWindowSeconds") &&
    !invalidProperties.has("lobbyIdleTtlSeconds") &&
    configuration.playerReconnectWindowSeconds >= configuration.lobbyIdleTtlSeconds
  ) {
    issues.push("PLAYER_RECONNECT_WINDOW_SECONDS must be less than LOBBY_IDLE_TTL_SECONDS.");
  }

  if (issues.length > 0) {
    throw new RuntimeConfigurationError(issues);
  }

  return Object.freeze(configuration);
}
