import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { createWebHealthHandler } from "./health.js";

describe("web operational health", () => {
  test("does not initialize the lobby handler while probing an unavailable database", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const result = spawnSync(
      "bun",
      [
        "--eval",
        `
          let unhandled = false;
          process.on("unhandledRejection", () => { unhandled = true; });
          const runtime = await import("./apps/web/src/lobby-entry-runtime.ts?first");
          const firstLogger = globalThis.webOperationalLogger;
          await import("./apps/web/src/lobby-entry-runtime.ts?second");
          await Bun.sleep(100);
          const unhandledBeforeRequest = unhandled;
          const response = await runtime.handleWebHealthRequest(
            new Request("http://localhost/readyz"),
          );
          await Bun.sleep(0);
          console.log(JSON.stringify({
            handlerInitialized: globalThis.lobbyEntryHandler !== undefined,
            loggerInitialized: firstLogger !== undefined,
            loggerReused: globalThis.webOperationalLogger === firstLogger,
            status: response.status,
            unhandled,
            unhandledBeforeRequest,
          }));
        `,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      handlerInitialized: false,
      loggerInitialized: true,
      loggerReused: true,
      status: 503,
      unhandled: false,
      unhandledBeforeRequest: false,
    });
  });

  test("serves liveness without querying PostgreSQL", async () => {
    const readinessCheck = vi.fn<() => Promise<boolean>>();
    const handler = createWebHealthHandler(readinessCheck);

    const response = await handler(new Request("https://bingo.example/healthz"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", service: "web" });
    expect(readinessCheck).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test.each([
    [true, 200, "ready", "up"],
    [false, 503, "not_ready", "down"],
  ] as const)(
    "reports bounded PostgreSQL readiness without dependency details",
    async (ready, status, expectedStatus, postgresql) => {
      const handler = createWebHealthHandler(async () => ready);

      const response = await handler(new Request("https://bingo.example/readyz"));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        status: expectedStatus,
        service: "web",
        dependencies: { postgresql },
      });
    },
  );

  test("redacts rejected PostgreSQL readiness details", async () => {
    const privateMarker = "postgresql://user:password@private.example/bingo";
    const handler = createWebHealthHandler(async () => Promise.reject(new Error(privateMarker)));

    const response = await handler(new Request("https://bingo.example/readyz"));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      status: "not_ready",
      service: "web",
      dependencies: { postgresql: "down" },
    });
    expect(body).not.toContain(privateMarker);
  });

  test("supports HEAD and rejects unsupported methods and query strings", async () => {
    const handler = createWebHealthHandler(async () => true);

    const head = await handler(new Request("https://bingo.example/readyz", { method: "HEAD" }));
    const method = await handler(new Request("https://bingo.example/healthz", { method: "POST" }));
    const query = await handler(new Request("https://bingo.example/healthz?detail=1"));

    expect(head.status).toBe(200);
    await expect(head.text()).resolves.toBe("");
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, HEAD");
    expect(query.status).toBe(404);
  });
});
