import { describe, expect, test } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  MarkCardCommandSchema,
  StartRoundCommandSchema,
} from "@gamenight-bingo/contracts";

import {
  isRoundCommandAuthorized,
  resolveRoundPatternMode,
  roundCommandIntentsMatch,
} from "./round-command-executor.js";

const startCommand = StartRoundCommandSchema.parse({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  type: "start-round",
  commandId: "command-start",
});

const markCommand = MarkCardCommandSchema.parse({
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  type: "mark-card",
  commandId: "command-mark",
  ball: 42,
});

describe("round command execution rules", () => {
  test("allows only a host to execute lobby-visible round commands", () => {
    expect(isRoundCommandAuthorized("host", startCommand)).toBe(true);
    expect(isRoundCommandAuthorized("player", startCommand)).toBe(false);
  });

  test("allows either participant role to mark only through the private mark command", () => {
    expect(isRoundCommandAuthorized("host", markCommand)).toBe(true);
    expect(isRoundCommandAuthorized("player", markCommand)).toBe(true);
  });

  test("resolves only canonical pattern IDs and modes", () => {
    const patterns = [
      { id: "standard-one-line", mode: "one-line" },
      { id: "shape-heart", mode: "exact" },
    ] as const;

    expect(resolveRoundPatternMode(patterns, "standard-one-line")).toBe("one-line");
    expect(resolveRoundPatternMode(patterns, "shape-heart")).toBe("exact");
    expect(resolveRoundPatternMode(patterns, "missing-pattern")).toBeNull();
  });

  test("matches a replay intent independent of PostgreSQL JSON object key order", () => {
    const persisted = {
      callConfiguration: { mode: "automatic", intervalSeconds: 30 },
      patternId: "standard-one-line",
      commandId: "command-configure",
      type: "configure",
      schemaVersion: 1,
    };
    const replay = {
      schemaVersion: 1,
      type: "configure",
      commandId: "command-configure",
      patternId: "standard-one-line",
      callConfiguration: { intervalSeconds: 30, mode: "automatic" },
    };

    expect(roundCommandIntentsMatch(persisted, replay)).toBe(true);
  });
});
