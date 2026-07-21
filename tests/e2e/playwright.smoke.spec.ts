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

    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(await response.text()).toContain(
      '<meta name="robots" content="noindex, nofollow, noarchive"',
    );
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
      await expect(response.json()).resolves.toMatchObject({
        schemaVersion: 1,
        type: "error",
        code: "NOT_FOUND",
      });
    }
  });
});
