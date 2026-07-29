import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import {
  createOperationalLogger,
  createReadinessProbe,
  type OperationalLogger,
} from "./operational-observability.js";

describe("operational observability", () => {
  test("drops diagnostics after an asynchronous stdout failure", () => {
    const writes: string[] = [];
    const output = new EventEmitter() as EventEmitter & {
      write(line: string): boolean;
    };
    output.write = (line) => {
      writes.push(line);
      return true;
    };
    const logger = createOperationalLogger({ service: "game-server", output });
    const command = {
      commandId: "command-output-failure",
      commandType: "call-next",
      outcome: "committed" as const,
    };

    logger.command(command);
    expect(() => output.emit("error", new Error("EPIPE"))).not.toThrow();
    logger.command(command);

    expect(writes).toHaveLength(1);
  });

  test("shares a hashed command correlation with transaction retries in the same operation", async () => {
    const lines: string[] = [];
    const logger = createOperationalLogger({
      service: "web",
      clock: () => new Date("2026-07-21T18:30:00.000Z"),
      sink: (line) => lines.push(line),
    });
    const withCommandCorrelation = (
      logger as OperationalLogger & {
        withCommandCorrelation<Result>(
          commandId: string,
          operation: () => Promise<Result>,
        ): Promise<Result>;
      }
    ).withCommandCorrelation;

    expect(withCommandCorrelation).toBeTypeOf("function");
    await withCommandCorrelation("command-private", async () => {
      logger.transactionRetry({
        kind: "retry",
        attempt: 1,
        maxAttempts: 5,
        reason: "serialization-conflict",
        delayMs: 10,
      });
      logger.command({
        commandId: "command-private",
        commandType: "start-round",
        outcome: "committed",
      });
    });

    const [retry, command] = lines.map((line) => JSON.parse(line));
    expect(retry.commandCorrelation).toMatch(/^[a-f0-9]{16}$/);
    expect(retry.commandCorrelation).toBe(command.commandCorrelation);
    expect(lines.join("\n")).not.toContain("command-private");
  });

  test("emits allowlisted structured correlation records without private input", () => {
    const lines: string[] = [];
    const logger = createOperationalLogger({
      service: "game-server",
      clock: () => new Date("2026-07-21T18:30:00.000Z"),
      sink: (line) => lines.push(line),
    });
    const privateMarker = Buffer.alloc(32, 7).toString("base64url");

    logger.command({
      commandId: privateMarker,
      commandType: "call-next",
      outcome: "committed",
      idempotentReplay: false,
      eventSequence: 12,
      privateMarker,
    } as Parameters<typeof logger.command>[0] & { readonly privateMarker: string });
    logger.lobbyEvent({
      lobbyId: "lobby-1",
      eventType: "call",
      eventSequence: 12,
      source: "command",
    });
    logger.transactionRetry({
      kind: "retry",
      attempt: 2,
      maxAttempts: 5,
      reason: "serialization-conflict",
      delayMs: 20,
    });
    logger.disconnectPause({
      lobbyId: "lobby-1",
      participantId: "participant-1",
      presenceGeneration: 3,
      outcome: "scheduled",
    });
    logger.restartRestoration({ kind: "presence-grace", count: 2, outcome: "completed" });

    expect(lines).toHaveLength(5);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        timestamp: "2026-07-21T18:30:00.000Z",
        level: "info",
        service: "game-server",
        event: "command",
        commandCorrelation: expect.stringMatching(/^[a-f0-9]{16}$/),
        commandType: "call-next",
        outcome: "committed",
        idempotentReplay: false,
        eventSequence: 12,
      },
      {
        timestamp: "2026-07-21T18:30:00.000Z",
        level: "info",
        service: "game-server",
        event: "lobby-event",
        lobbyCorrelation: expect.stringMatching(/^[a-f0-9]{16}$/),
        eventType: "call",
        eventSequence: 12,
        source: "command",
      },
      {
        timestamp: "2026-07-21T18:30:00.000Z",
        level: "warn",
        service: "game-server",
        event: "transaction-retry",
        kind: "retry",
        attempt: 2,
        maxAttempts: 5,
        reason: "serialization-conflict",
        delayMs: 20,
      },
      {
        timestamp: "2026-07-21T18:30:00.000Z",
        level: "info",
        service: "game-server",
        event: "disconnect-pause",
        lobbyCorrelation: expect.stringMatching(/^[a-f0-9]{16}$/),
        participantCorrelation: expect.stringMatching(/^[a-f0-9]{16}$/),
        presenceGeneration: 3,
        outcome: "scheduled",
      },
      {
        timestamp: "2026-07-21T18:30:00.000Z",
        level: "info",
        service: "game-server",
        event: "restart-restoration",
        kind: "presence-grace",
        count: 2,
        outcome: "completed",
      },
    ]);
    expect(lines.join("\n")).not.toContain(privateMarker);
    expect(lines.join("\n")).not.toContain("lobby-1");
    expect(lines.join("\n")).not.toContain("participant-1");
  });

  test("coalesces readiness work, caches its result, and fails closed on timeout", async () => {
    vi.useFakeTimers();
    const releases: Array<(value: boolean) => void> = [];
    try {
      let checks = 0;
      const probe = createReadinessProbe(
        () => {
          checks += 1;
          return new Promise<boolean>((resolve) => {
            releases.push(resolve);
          });
        },
        { timeoutMs: 100, cacheMs: 1_000, clock: () => Date.now() },
      );

      const first = probe();
      const second = probe();
      expect(checks).toBe(1);
      releases[0]!(true);
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      await expect(probe()).resolves.toBe(true);
      expect(checks).toBe(1);

      await vi.advanceTimersByTimeAsync(1_001);
      const timedOut = probe();
      expect(checks).toBe(2);
      await vi.advanceTimersByTimeAsync(100);
      await expect(timedOut).resolves.toBe(false);

      await vi.advanceTimersByTimeAsync(1_001);
      await expect(probe()).resolves.toBe(false);
      expect(checks).toBe(2);
      releases[1]!(true);
      await vi.advanceTimersByTimeAsync(0);
      await expect(probe()).resolves.toBe(false);

      await vi.advanceTimersByTimeAsync(1_001);
      const recovered = probe();
      expect(checks).toBe(3);
      releases[2]!(true);
      await expect(recovered).resolves.toBe(true);
    } finally {
      releases.forEach((release) => release(false));
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });
});
