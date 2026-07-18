import { expect, test } from "@playwright/test";

test("loads the Playwright test configuration", () => {
  expect(true).toBe(true);
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
