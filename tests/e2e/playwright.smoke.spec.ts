import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

test("loads the Playwright test configuration", () => {
  expect(true).toBe(true);
});

test("keeps the result marker clear of result details at the desktop breakpoint", async ({
  page,
}) => {
  const globalStyles = await readFile(
    resolve(process.cwd(), "apps/web/src/app/globals.css"),
    "utf8",
  );
  await page.setViewportSize({ height: 812, width: 848 });
  await page.setContent(`
    <style>${globalStyles}</style>
    <main class="private-lobby-shell">
      <div class="private-lobby-grid">
        <section class="lobby-panel outcome-panel">
          <div class="outcome-lockup">
            <div class="result-mark">RESULT</div>
            <div data-testid="result-details">
              <p class="eyebrow">Confirmed result</p>
              <h2>Another player won this round</h2>
            </div>
          </div>
        </section>
      </div>
    </main>
  `);

  const markerBounds = await page.locator(".result-mark").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { contentRight: box.x + element.scrollWidth };
  });
  const detailsBox = await page.getByTestId("result-details").boundingBox();

  expect(detailsBox).not.toBeNull();
  expect(markerBounds.contentRight + 16).toBeLessThanOrEqual(detailsBox!.x);
});

test.describe("versioned private API routing", () => {
  test.skip(
    process.env["TEST_DATABASE_URL"] === undefined,
    "A migrated TEST_DATABASE_URL is required for the live Next route test.",
  );

  test("marks private lobby documents no-store and noindex", async ({ request }) => {
    const response = await request.get("/lobbies/ABC234");
    const contentSecurityPolicy = response.headers()["content-security-policy"];
    const scriptPolicy = contentSecurityPolicy
      ?.split(";")
      .find((directive) => directive.trim().startsWith("script-src"));
    const webOrigin = new URL(response.url());
    const webSocketOrigin = `${webOrigin.protocol === "https:" ? "wss:" : "ws:"}//${webOrigin.host}`;

    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy).toContain(`connect-src 'self' ${webSocketOrigin}`);
    expect(contentSecurityPolicy).toContain("http://localhost:4100 ws://localhost:4100");
    expect(scriptPolicy).toMatch(/'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
    expect(response.headers()["permissions-policy"]).toContain("camera=()");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(await response.text()).toContain(
      '<meta name="robots" content="noindex, nofollow, noarchive"',
    );
  });

  test("keeps private lobby browser traffic first-party and analytics-free", async ({ page }) => {
    const requestUrls: string[] = [];
    page.on("request", (request) => requestUrls.push(request.url()));
    await page.route("**/api/v1/lobbies/ABC234/snapshot", async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          schemaVersion: 1,
          type: "error",
          code: "NOT_FOUND",
          message: "The requested resource was not found.",
          commandId: null,
          occurredAt: "2026-07-21T00:00:00.000Z",
          retryable: false,
          issues: [],
        }),
        contentType: "application/json",
        status: 404,
      });
    });

    await page.goto("/lobbies/ABC234");
    await expect(page.getByRole("heading", { name: "This lobby has expired" })).toBeFocused();

    const pageOrigin = new URL(page.url()).origin;
    expect([...new Set(requestUrls.map((url) => new URL(url).origin))]).toEqual([pageOrigin]);
    expect(requestUrls).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/analytics|beacon|collect|pixel|telemetry/i)]),
    );
    expect(
      await page
        .locator("script[src], iframe")
        .evaluateAll(
          (elements, origin) =>
            elements
              .map((element) =>
                element instanceof HTMLIFrameElement
                  ? element.src
                  : (element as HTMLScriptElement).src,
              )
              .filter((url) => url.length > 0 && new URL(url).origin !== origin),
          pageOrigin,
        ),
    ).toEqual([]);
  });

  test("preserves stable no-store errors across the Next routing boundary", async ({ request }) => {
    for (const requestCase of [
      { method: "get", path: "/api/v1/lobbies/ABC234" },
      { method: "get", path: "/api/v1/lobbies/ABC234/unknown" },
      { method: "put", path: "/api/v1/lobbies/ABC234/snapshot" },
    ] as const) {
      const response = await request[requestCase.method](requestCase.path);

      expect(response.status()).toBe(404);
      expect(response.headers()["cache-control"]).toBe("no-store");
      expect(response.headers()["referrer-policy"]).toBe("no-referrer");
      expect(response.headers()["x-content-type-options"]).toBe("nosniff");
      expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
      await expect(response.json()).resolves.toMatchObject({
        schemaVersion: 1,
        type: "error",
        code: "NOT_FOUND",
      });
    }
  });
});
