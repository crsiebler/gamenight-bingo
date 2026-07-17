import { describe, expect, test } from "vitest";

import {
  TransactionRetryExhaustedError,
  runTransactionWithRetry,
  type TransactionRetryEvent,
} from "./transaction-retry.js";

describe("transaction retry policy", () => {
  test("retries classified conflicts with observable bounded delays", async () => {
    const observations: TransactionRetryEvent[] = [];
    const delays: number[] = [];
    let attempts = 0;

    const result = await runTransactionWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("serialization conflict"), { code: "P2034" });
        }
        return "committed";
      },
      {
        maxAttempts: 4,
        observer: (event) => observations.push(event),
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    expect(result).toBe("committed");
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
    expect(observations).toEqual([
      {
        kind: "retry",
        attempt: 1,
        maxAttempts: 4,
        reason: "serialization-conflict",
        delayMs: 10,
      },
      {
        kind: "retry",
        attempt: 2,
        maxAttempts: 4,
        reason: "serialization-conflict",
        delayMs: 20,
      },
    ]);
  });

  test("stops after the configured attempt limit and reports exhaustion", async () => {
    const observations: TransactionRetryEvent[] = [];
    const conflict = Object.assign(new Error("deadlock"), { code: "40P01" });
    let attempts = 0;

    const result = runTransactionWithRetry(
      async () => {
        attempts += 1;
        throw conflict;
      },
      {
        maxAttempts: 3,
        observer: (event) => observations.push(event),
        sleep: async () => undefined,
      },
    );

    await expect(result).rejects.toMatchObject({
      name: TransactionRetryExhaustedError.name,
      attempts: 3,
      cause: conflict,
    });
    expect(attempts).toBe(3);
    expect(observations.at(-1)).toEqual({
      kind: "exhausted",
      attempt: 3,
      maxAttempts: 3,
      reason: "deadlock",
      delayMs: 0,
    });
  });

  test("does not retry unclassified failures", async () => {
    const failure = new Error("constraint violation");
    let attempts = 0;

    const result = runTransactionWithRetry(async () => {
      attempts += 1;
      throw failure;
    });

    await expect(result).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  test("recognizes PostgreSQL serialization codes wrapped in Prisma metadata", async () => {
    let attempts = 0;

    const result = await runTransactionWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("raw query failed"), {
            code: "P2010",
            meta: { code: "40001" },
          });
        }
        return "committed";
      },
      { sleep: async () => undefined },
    );

    expect(result).toBe("committed");
    expect(attempts).toBe(2);
  });

  test("classifies PostgreSQL deadlocks wrapped in adapter metadata", async () => {
    const observations: TransactionRetryEvent[] = [];
    let attempts = 0;

    const result = await runTransactionWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("raw query failed"), {
            code: "P2010",
            meta: { originalCode: "40P01" },
          });
        }
        return "committed";
      },
      {
        observer: (event) => observations.push(event),
        sleep: async () => undefined,
      },
    );

    expect(result).toBe("committed");
    expect(observations[0]).toMatchObject({
      kind: "retry",
      reason: "deadlock",
    });
  });

  test("prefers a nested PostgreSQL deadlock over a generic Prisma conflict", async () => {
    const observations: TransactionRetryEvent[] = [];
    let attempts = 0;

    const result = await runTransactionWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("transaction failed"), {
            code: "P2034",
            meta: { originalCode: "40P01" },
          });
        }
        return "committed";
      },
      {
        observer: (event) => observations.push(event),
        sleep: async () => undefined,
      },
    );

    expect(result).toBe("committed");
    expect(observations[0]).toMatchObject({
      kind: "retry",
      reason: "deadlock",
    });
  });
});
