import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { TransactionRetryEvent } from "./transaction-retry.js";

export interface OperationalLogger {
  withCommandCorrelation<Result>(
    commandId: string,
    operation: () => Promise<Result>,
  ): Promise<Result>;
  command(input: {
    readonly commandId: string;
    readonly commandType: string;
    readonly outcome: "committed" | "rejected" | "failed";
    readonly idempotentReplay?: boolean;
    readonly eventSequence?: number | null;
    readonly errorCode?: string;
  }): void;
  lobbyEvent(input: {
    readonly lobbyId: string;
    readonly eventType: string;
    readonly eventSequence: number;
    readonly source: "command" | "subscription" | "authority";
  }): void;
  transactionRetry(event: TransactionRetryEvent): void;
  disconnectPause(input: {
    readonly lobbyId: string;
    readonly participantId: string;
    readonly presenceGeneration: number;
    readonly outcome: "scheduled" | "expired" | "stale" | "too-early" | "failed";
  }): void;
  restartRestoration(input: {
    readonly kind: "presence-grace" | "automatic-call" | "co-winner-settlement";
    readonly count: number;
    readonly outcome: "completed" | "failed";
  }): void;
}

export function createOperationalLogger(options: {
  readonly service: "web" | "game-server";
  readonly clock?: () => Date;
  readonly sink?: (line: string) => void;
  readonly output?: {
    write(line: string): boolean;
    once(event: "drain", listener: () => void): unknown;
    on(event: "error", listener: (error: unknown) => void): unknown;
  };
}): OperationalLogger {
  const clock = options.clock ?? (() => new Date());
  let stdoutBlocked = false;
  let outputUnavailable = false;
  const output = options.output ?? process.stdout;
  if (options.sink === undefined) {
    output.on("error", () => {
      outputUnavailable = true;
      stdoutBlocked = true;
    });
  }
  const sink =
    options.sink ??
    ((line: string) => {
      if (stdoutBlocked || outputUnavailable) return;
      stdoutBlocked = !output.write(`${line}\n`);
      if (stdoutBlocked) output.once("drain", () => (stdoutBlocked = false));
    });
  const correlation = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  const commandContext = new AsyncLocalStorage<string>();
  const write = (record: Readonly<Record<string, unknown>>) => {
    try {
      sink(
        JSON.stringify({
          timestamp: clock().toISOString(),
          ...record,
          service: options.service,
        }),
      );
    } catch {
      // Diagnostics must never change authoritative application behavior.
    }
  };

  return {
    withCommandCorrelation(commandId, operation) {
      return commandContext.run(correlation(commandId), operation);
    },
    command(input) {
      write({
        level: input.outcome === "failed" ? "error" : "info",
        event: "command",
        commandCorrelation: correlation(input.commandId),
        commandType: input.commandType,
        outcome: input.outcome,
        ...(input.idempotentReplay === undefined
          ? {}
          : { idempotentReplay: input.idempotentReplay }),
        ...(input.eventSequence === undefined ? {} : { eventSequence: input.eventSequence }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      });
    },
    lobbyEvent(input) {
      write({
        level: "info",
        event: "lobby-event",
        lobbyCorrelation: correlation(input.lobbyId),
        eventType: input.eventType,
        eventSequence: input.eventSequence,
        source: input.source,
      });
    },
    transactionRetry(event) {
      const commandCorrelation = commandContext.getStore();
      write({
        level: "warn",
        event: "transaction-retry",
        ...(commandCorrelation === undefined ? {} : { commandCorrelation }),
        kind: event.kind,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        reason: event.reason,
        delayMs: event.delayMs,
      });
    },
    disconnectPause(input) {
      write({
        level: "info",
        event: "disconnect-pause",
        lobbyCorrelation: correlation(input.lobbyId),
        participantCorrelation: correlation(input.participantId),
        presenceGeneration: input.presenceGeneration,
        outcome: input.outcome,
      });
    },
    restartRestoration(input) {
      write({
        level: input.outcome === "failed" ? "error" : "info",
        event: "restart-restoration",
        kind: input.kind,
        count: input.count,
        outcome: input.outcome,
      });
    },
  };
}

export function createReadinessProbe(
  check: () => Promise<boolean>,
  options: {
    readonly timeoutMs?: number;
    readonly cacheMs?: number;
    readonly clock?: () => number;
  } = {},
): () => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const cacheMs = options.cacheMs ?? 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("Readiness timeout must be an integer from 1 through 60000 milliseconds.");
  }
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 60_000) {
    throw new RangeError("Readiness cache must be an integer from 0 through 60000 milliseconds.");
  }
  const clock = options.clock ?? Date.now;
  let cached: { readonly value: boolean; readonly expiresAt: number } | null = null;
  let inFlight: Promise<boolean> | null = null;
  let activeCheck: Promise<void> | null = null;

  return () => {
    const now = clock();
    if (cached !== null && now < cached.expiresAt) return Promise.resolve(cached.value);
    if (inFlight !== null) return inFlight;
    if (activeCheck !== null) {
      cached = { value: false, expiresAt: now + cacheMs };
      return Promise.resolve(false);
    }

    const current = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      let pending: Promise<boolean>;
      try {
        pending = check();
      } catch {
        finish(false);
        return;
      }
      const active = pending.then(
        (value) => finish(value === true),
        () => finish(false),
      );
      const tracked = active.finally(() => {
        if (activeCheck === tracked) activeCheck = null;
      });
      activeCheck = tracked;
    }).then((value) => {
      cached = { value, expiresAt: clock() + cacheMs };
      if (inFlight === current) inFlight = null;
      return value;
    });
    inFlight = current;
    return current;
  };
}
