export type TransactionRetryReason = "serialization-conflict" | "deadlock";

export type TransactionRetryEvent =
  | {
      readonly kind: "retry";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly reason: TransactionRetryReason;
      readonly delayMs: number;
    }
  | {
      readonly kind: "exhausted";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly reason: TransactionRetryReason;
      readonly delayMs: 0;
    };

export interface TransactionRetryOptions {
  readonly maxAttempts?: number;
  readonly observer?: (event: TransactionRetryEvent) => void;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export class TransactionRetryExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`Serializable transaction failed after ${attempts} attempts.`, { cause });
    this.name = "TransactionRetryExhaustedError";
    this.attempts = attempts;
  }
}

function retryReason(error: unknown): TransactionRetryReason | null {
  const visited = new Set<object>();
  const candidates: unknown[] = [error];
  let hasSerializationConflict = false;

  while (candidates.length > 0) {
    const current = candidates.shift();
    if (typeof current !== "object" || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const candidate = current as {
      readonly code?: unknown;
      readonly originalCode?: unknown;
      readonly sqlState?: unknown;
      readonly cause?: unknown;
      readonly meta?: unknown;
      readonly driverAdapterError?: unknown;
    };
    if (
      candidate.code === "40P01" ||
      candidate.originalCode === "40P01" ||
      candidate.sqlState === "40P01"
    ) {
      return "deadlock";
    }
    if (
      candidate.code === "P2034" ||
      candidate.code === "40001" ||
      candidate.originalCode === "40001" ||
      candidate.sqlState === "40001"
    ) {
      hasSerializationConflict = true;
    }
    candidates.push(candidate.cause, candidate.meta, candidate.driverAdapterError);
  }

  return hasSerializationConflict ? "serialization-conflict" : null;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function runTransactionWithRetry<Result>(
  operation: () => Promise<Result>,
  options: TransactionRetryOptions = {},
): Promise<Result> {
  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("Transaction maxAttempts must be a positive safe integer.");
  }

  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const reason = retryReason(error);
      if (reason === null) {
        throw error;
      }
      if (attempt === maxAttempts) {
        options.observer?.({
          kind: "exhausted",
          attempt,
          maxAttempts,
          reason,
          delayMs: 0,
        });
        throw new TransactionRetryExhaustedError(attempt, error);
      }

      const delayMs = Math.min(10 * 2 ** (attempt - 1), 100);
      options.observer?.({
        kind: "retry",
        attempt,
        maxAttempts,
        reason,
        delayMs,
      });
      await sleep(delayMs);
    }
  }

  throw new Error("Unreachable transaction retry state.");
}
