import { createServer, type Server } from "node:net";

export interface PerformanceMetricSummary {
  readonly sampleCount: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly p99Milliseconds: number;
  readonly maximumMilliseconds: number;
}

export interface CleanupStep {
  readonly label: string;
  readonly run: () => Promise<void>;
}

export function performanceBrowserLaunchOptions(channel: string | undefined): {
  readonly channel?: string;
  readonly headless: true;
} {
  return channel === undefined ? { headless: true } : { channel, headless: true };
}

async function runWithTimeout(
  operation: Promise<void>,
  label: string,
  timeoutMilliseconds: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for cleanup phase: ${label}.`)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runBoundedCleanupSteps(
  steps: readonly CleanupStep[],
  timeoutMilliseconds: number,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new RangeError("Cleanup timeout must be a positive safe integer.");
  }

  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await runWithTimeout(step.run(), step.label, timeoutMilliseconds);
    } catch (error) {
      failures.push(new Error(`Cleanup phase failed: ${step.label}.`, { cause: error }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more cleanup phases failed.");
  }
}

export async function runWithBoundedCleanup<Value>(
  operation: () => Promise<Value>,
  steps: readonly CleanupStep[],
  timeoutMilliseconds: number,
): Promise<Value> {
  let operationFailed = false;
  let operationFailure: unknown;
  let value: Value | undefined;
  try {
    value = await operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  try {
    await runBoundedCleanupSteps(steps, timeoutMilliseconds);
  } catch (cleanupFailure) {
    if (operationFailed) {
      throw new AggregateError(
        [operationFailure, cleanupFailure],
        "The operation and its cleanup both failed.",
        { cause: cleanupFailure },
      );
    }
    throw new Error("Cleanup failed.", { cause: cleanupFailure });
  }

  if (operationFailed) throw operationFailure;
  return value as Value;
}

function listenOnAvailableLoopbackPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to allocate a loopback TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

export async function findAvailableLoopbackPorts(count: number): Promise<readonly number[]> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("Port count must be a positive safe integer.");
  }

  const servers = Array.from({ length: count }, () => createServer());
  try {
    return await Promise.all(servers.map(listenOnAvailableLoopbackPort));
  } finally {
    await Promise.all(servers.map(closeServer));
  }
}

function nearestRank(sortedSamples: readonly number[], percentile: number): number {
  return sortedSamples[Math.ceil((percentile / 100) * sortedSamples.length) - 1]!;
}

export function summarizePerformanceSamples(samples: readonly number[]): PerformanceMetricSummary {
  if (samples.length === 0) throw new RangeError("At least one latency sample is required.");
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new RangeError("Latency samples must be finite nonnegative numbers.");
  }

  const sortedSamples = [...samples].sort((left, right) => left - right);
  return {
    sampleCount: sortedSamples.length,
    p50Milliseconds: nearestRank(sortedSamples, 50),
    p95Milliseconds: nearestRank(sortedSamples, 95),
    p99Milliseconds: nearestRank(sortedSamples, 99),
    maximumMilliseconds: sortedSamples.at(-1)!,
  };
}
