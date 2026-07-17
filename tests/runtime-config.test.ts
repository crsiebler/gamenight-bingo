import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RUNTIME_CONFIG_DEFAULTS,
  RuntimeConfigurationError,
  parseRuntimeConfig,
} from "../packages/contracts/src/index.js";
import type { RuntimeConfig } from "../packages/contracts/src/index.js";

const EXPECTED_DEFAULTS = {
  maxPlayersPerLobby: 25,
  maxActiveLobbies: 100,
  lobbyIdleTtlSeconds: 1_800,
  playerReconnectWindowSeconds: 120,
  disconnectPauseGraceSeconds: 10,
  realtimeTicketTtlSeconds: 60,
  coWinnerWindowMs: 2_000,
} satisfies RuntimeConfig;

const ENVIRONMENT_KEYS = [
  "MAX_PLAYERS_PER_LOBBY",
  "MAX_ACTIVE_LOBBIES",
  "LOBBY_IDLE_TTL_SECONDS",
  "PLAYER_RECONNECT_WINDOW_SECONDS",
  "DISCONNECT_PAUSE_GRACE_SECONDS",
  "REALTIME_TICKET_TTL_SECONDS",
  "CO_WINNER_WINDOW_MS",
] as const;

function captureConfigurationError(environment: Readonly<Record<string, string | undefined>>) {
  let thrown: unknown;

  try {
    parseRuntimeConfig(environment);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(RuntimeConfigurationError);

  return thrown as RuntimeConfigurationError;
}

describe("runtime configuration", () => {
  it("uses the seven confirmed defaults", () => {
    expect(RUNTIME_CONFIG_DEFAULTS).toEqual(EXPECTED_DEFAULTS);
    expect(parseRuntimeConfig({})).toEqual(EXPECTED_DEFAULTS);
  });

  it("parses all environment overrides as integers", () => {
    expect(
      parseRuntimeConfig({
        MAX_PLAYERS_PER_LOBBY: "12",
        MAX_ACTIVE_LOBBIES: "50",
        LOBBY_IDLE_TTL_SECONDS: "3600",
        PLAYER_RECONNECT_WINDOW_SECONDS: "300",
        DISCONNECT_PAUSE_GRACE_SECONDS: "20",
        REALTIME_TICKET_TTL_SECONDS: "120",
        CO_WINNER_WINDOW_MS: "3500",
      }),
    ).toEqual({
      maxPlayersPerLobby: 12,
      maxActiveLobbies: 50,
      lobbyIdleTtlSeconds: 3_600,
      playerReconnectWindowSeconds: 300,
      disconnectPauseGraceSeconds: 20,
      realtimeTicketTtlSeconds: 120,
      coWinnerWindowMs: 3_500,
    });
  });

  it("accepts inclusive limits when timing constraints also hold", () => {
    expect(
      parseRuntimeConfig({
        MAX_PLAYERS_PER_LOBBY: "1",
        MAX_ACTIVE_LOBBIES: "1",
        LOBBY_IDLE_TTL_SECONDS: "86400",
        PLAYER_RECONNECT_WINDOW_SECONDS: "3600",
        DISCONNECT_PAUSE_GRACE_SECONDS: "300",
        REALTIME_TICKET_TTL_SECONDS: "300",
        CO_WINNER_WINDOW_MS: "1",
      }),
    ).toEqual({
      maxPlayersPerLobby: 1,
      maxActiveLobbies: 1,
      lobbyIdleTtlSeconds: 86_400,
      playerReconnectWindowSeconds: 3_600,
      disconnectPauseGraceSeconds: 300,
      realtimeTicketTtlSeconds: 300,
      coWinnerWindowMs: 1,
    });

    expect(
      parseRuntimeConfig({
        MAX_PLAYERS_PER_LOBBY: "25",
        MAX_ACTIVE_LOBBIES: "100",
        LOBBY_IDLE_TTL_SECONDS: "3",
        PLAYER_RECONNECT_WINDOW_SECONDS: "2",
        DISCONNECT_PAUSE_GRACE_SECONDS: "1",
        REALTIME_TICKET_TTL_SECONDS: "1",
        CO_WINNER_WINDOW_MS: "10000",
      }),
    ).toEqual({
      maxPlayersPerLobby: 25,
      maxActiveLobbies: 100,
      lobbyIdleTtlSeconds: 3,
      playerReconnectWindowSeconds: 2,
      disconnectPauseGraceSeconds: 1,
      realtimeTicketTtlSeconds: 1,
      coWinnerWindowMs: 10_000,
    });
  });

  it("uses defaults for omitted values and ignores unrelated variables", () => {
    expect(
      parseRuntimeConfig({
        MAX_ACTIVE_LOBBIES: "40",
        UNRELATED_SECRET: "must-not-be-read",
      }),
    ).toEqual({
      ...EXPECTED_DEFAULTS,
      maxActiveLobbies: 40,
    });
  });

  it("parses web connection and trusted-proxy settings without exposing their values", () => {
    const databaseUrl = "postgresql://runtime-private-marker";
    const trustedProxySecret = "trusted-proxy-private-marker-value";

    expect(
      parseRuntimeConfig({
        DATABASE_URL: databaseUrl,
        TRUSTED_PROXY_SECRET: trustedProxySecret,
      }),
    ).toEqual({
      ...EXPECTED_DEFAULTS,
      databaseUrl,
      trustedProxySecret,
    });

    const error = captureConfigurationError({
      DATABASE_URL: "",
      TRUSTED_PROXY_SECRET: "short-private-marker",
    });
    expect(error.issues).toEqual([
      "DATABASE_URL must be nonempty when configured.",
      "TRUSTED_PROXY_SECRET must contain at least 32 characters when configured.",
    ]);
    expect(error.message).not.toContain("short-private-marker");
  });

  it.each(ENVIRONMENT_KEYS)("rejects a noninteger %s override", (key) => {
    const error = captureConfigurationError({ [key]: "1.5" });

    expect(error.message).toContain(key);
  });

  it.each(["", " ", "1e2", "0x10", "+1", "NaN", "Infinity"])(
    "rejects the malformed integer %j",
    (value) => {
      const error = captureConfigurationError({
        MAX_PLAYERS_PER_LOBBY: value,
      });

      expect(error.message).toContain("MAX_PLAYERS_PER_LOBBY");
    },
  );

  it.each([
    ["MAX_PLAYERS_PER_LOBBY", "0"],
    ["MAX_PLAYERS_PER_LOBBY", "26"],
    ["MAX_ACTIVE_LOBBIES", "0"],
    ["MAX_ACTIVE_LOBBIES", "101"],
    ["LOBBY_IDLE_TTL_SECONDS", "0"],
    ["LOBBY_IDLE_TTL_SECONDS", "86401"],
    ["PLAYER_RECONNECT_WINDOW_SECONDS", "0"],
    ["PLAYER_RECONNECT_WINDOW_SECONDS", "3601"],
    ["DISCONNECT_PAUSE_GRACE_SECONDS", "0"],
    ["DISCONNECT_PAUSE_GRACE_SECONDS", "301"],
    ["REALTIME_TICKET_TTL_SECONDS", "0"],
    ["REALTIME_TICKET_TTL_SECONDS", "301"],
    ["CO_WINNER_WINDOW_MS", "0"],
    ["CO_WINNER_WINDOW_MS", "10001"],
    ["CO_WINNER_WINDOW_MS", "9007199254740992"],
  ])("rejects unsafe range %s=%s", (key, value) => {
    const error = captureConfigurationError({ [key]: value });

    expect(error.message).toContain(key);
  });

  it("requires disconnect grace to be shorter than the reconnect window", () => {
    const error = captureConfigurationError({
      DISCONNECT_PAUSE_GRACE_SECONDS: "120",
      PLAYER_RECONNECT_WINDOW_SECONDS: "120",
    });

    expect(error.message).toContain("DISCONNECT_PAUSE_GRACE_SECONDS");
    expect(error.message).toContain("PLAYER_RECONNECT_WINDOW_SECONDS");
  });

  it("does not let realtime tickets outlive the reconnect window", () => {
    const error = captureConfigurationError({
      REALTIME_TICKET_TTL_SECONDS: "121",
      PLAYER_RECONNECT_WINDOW_SECONDS: "120",
    });

    expect(error.message).toContain("REALTIME_TICKET_TTL_SECONDS");
    expect(error.message).toContain("PLAYER_RECONNECT_WINDOW_SECONDS");
  });

  it("requires the reconnect window to be shorter than lobby retention", () => {
    const error = captureConfigurationError({
      LOBBY_IDLE_TTL_SECONDS: "1800",
      PLAYER_RECONNECT_WINDOW_SECONDS: "1800",
    });

    expect(error.message).toContain("PLAYER_RECONNECT_WINDOW_SECONDS");
    expect(error.message).toContain("LOBBY_IDLE_TTL_SECONDS");
  });

  it("aggregates deterministic issues without exposing supplied values", () => {
    const error = captureConfigurationError({
      MAX_PLAYERS_PER_LOBBY: "private-input-marker",
      MAX_ACTIVE_LOBBIES: "another-private-marker",
    });

    expect(error.code).toBe("RUNTIME_CONFIG_INVALID");
    expect(error.issues).toEqual([
      "MAX_PLAYERS_PER_LOBBY must be a decimal integer between 1 and 25.",
      "MAX_ACTIVE_LOBBIES must be a decimal integer between 1 and 100.",
    ]);
    expect(error.message).not.toContain("private-input-marker");
    expect(error.message).not.toContain("another-private-marker");
  });

  it("returns immutable defaults and parsed configuration", () => {
    const parsed = parseRuntimeConfig({});

    expect(Object.isFrozen(RUNTIME_CONFIG_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});

describe.each([
  ["web", "apps/web/src/index.ts"],
  ["game server", "apps/game-server/src/index.ts"],
])("%s startup", (_, entryPoint) => {
  it("fails before serving when runtime configuration is invalid", () => {
    const root = resolve(import.meta.dirname, "..");
    const environment = { ...process.env };

    for (const key of ENVIRONMENT_KEYS) {
      delete environment[key];
    }
    environment["MAX_PLAYERS_PER_LOBBY"] = "startup-private-marker";

    const result = spawnSync("bun", [join(root, entryPoint)], {
      cwd: root,
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).not.toBeNull();
    expect(result.status, output).not.toBe(0);
    expect(output).toContain("MAX_PLAYERS_PER_LOBBY");
    expect(output).not.toContain("startup-private-marker");
  });
});
