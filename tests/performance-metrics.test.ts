import { createServer } from "node:net";

import { describe, expect, test } from "vitest";

import {
  findAvailableLoopbackPorts,
  performanceBrowserLaunchOptions,
  runBoundedCleanupSteps,
  runWithBoundedCleanup,
  summarizePerformanceSamples,
  type PerformanceMetricSummary,
} from "../packages/test-support/src/index.js";

describe("single-instance performance metrics", () => {
  test("uses managed Chromium by default and permits an explicit browser channel", () => {
    expect(performanceBrowserLaunchOptions(undefined)).toEqual({ headless: true });
    expect(performanceBrowserLaunchOptions("chrome")).toEqual({
      channel: "chrome",
      headless: true,
    });
  });

  test("reports deterministic nearest-rank percentiles without averaging away outliers", () => {
    const summary = summarizePerformanceSamples([100, 1, 5, 2, 3, 4, 10, 8, 9, 7, 6]);

    expect(summary).toEqual({
      sampleCount: 11,
      p50Milliseconds: 6,
      p95Milliseconds: 100,
      p99Milliseconds: 100,
      maximumMilliseconds: 100,
    } satisfies PerformanceMetricSummary);
  });

  test("retains sub-millisecond precision and rejects missing or invalid samples", () => {
    expect(summarizePerformanceSamples([0.25, 0.5, 0.75, 1])).toEqual({
      sampleCount: 4,
      p50Milliseconds: 0.5,
      p95Milliseconds: 1,
      p99Milliseconds: 1,
      maximumMilliseconds: 1,
    });
    expect(() => summarizePerformanceSamples([])).toThrow(
      "At least one latency sample is required",
    );
    expect(() => summarizePerformanceSamples([1, Number.NaN])).toThrow(
      "Latency samples must be finite nonnegative numbers",
    );
    expect(() => summarizePerformanceSamples([-1])).toThrow(
      "Latency samples must be finite nonnegative numbers",
    );
  });

  test("allocates distinct loopback ports for isolated load processes", async () => {
    const ports = await findAvailableLoopbackPorts(2);
    const servers = ports.map(() => createServer());

    try {
      expect(new Set(ports).size).toBe(2);
      await Promise.all(
        servers.map(
          (server, index) =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(ports[index]!, "127.0.0.1", resolve);
            }),
        ),
      );
    } finally {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              if (!server.listening) {
                resolve();
                return;
              }
              server.close((error) => {
                if (error === undefined) resolve();
                else reject(error);
              });
            }),
        ),
      );
    }
  });

  test("bounds each cleanup phase and continues after failures", async () => {
    const attempted: string[] = [];

    const cleanup = runBoundedCleanupSteps(
      [
        {
          label: "stalled authority",
          run: () => {
            attempted.push("authority");
            return new Promise<void>(() => {});
          },
        },
        {
          label: "failed subscription",
          run: async () => {
            attempted.push("subscription");
            throw new Error("subscription close failed");
          },
        },
        {
          label: "database",
          run: async () => {
            attempted.push("database");
          },
        },
      ],
      10,
    );

    await expect(cleanup).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      return /stalled authority.*failed subscription/s.test(error.errors.map(String).join("\n"));
    });
    expect(attempted).toEqual(["authority", "subscription", "database"]);
  });

  test("preserves the workload failure when cleanup also fails", async () => {
    const workloadFailure = new Error("measured reconnect failed");
    const cleanupFailure = new Error("authority close failed");

    await expect(
      runWithBoundedCleanup(
        async () => {
          throw workloadFailure;
        },
        [{ label: "authority", run: async () => Promise.reject(cleanupFailure) }],
        10,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors[0] === workloadFailure &&
        error.errors[1] instanceof AggregateError,
    );
  });
});
