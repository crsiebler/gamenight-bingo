import { expect, test, type Page } from "@playwright/test";

async function reloadAndRecover(page: Page, code: string, username: string) {
  await page.reload();
  const lobbyHeading = page.getByRole("heading", { name: `Lobby ${code}` });
  const rejoinLink = page.getByRole("link", { name: "Join or rejoin" });
  await expect
    .poll(async () => (await lobbyHeading.isVisible()) || (await rejoinLink.isVisible()))
    .toBe(true);
  if (await rejoinLink.isVisible()) {
    await rejoinLink.click();
    await page.getByRole("button", { name: "Find lobby" }).click();
    await page.getByRole("button", { name: `Rejoin as ${username}` }).click();
    await page.getByRole("link", { name: "Open lobby" }).click();
  }
  await expect(lobbyHeading).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Live game status" }).locator(".connection-state"),
  ).toHaveText(/^(Connected|Recovered)$/);
}

test.describe("host and player gameplay journey", () => {
  test.skip(
    process.env["TEST_DATABASE_URL"] === undefined,
    "A migrated TEST_DATABASE_URL is required for the full-stack gameplay journey.",
  );

  test("creates, joins, plays, and restores authorized views", async ({ browser }, testInfo) => {
    test.skip(
      testInfo.project.name === "webkit" || testInfo.project.name === "ios-webkit",
      "The HTTP harness cannot carry the required Secure participant cookie in WebKit; run the documented native Safari journey over HTTPS.",
    );
    test.setTimeout(60_000);
    const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`;
    const hostName = `Host ${suffix}`;
    const playerName = `Player ${suffix}`;
    const hostContext = await browser.newContext();
    const playerContext = await browser.newContext();

    try {
      const hostPage = await hostContext.newPage();
      await hostPage.goto("/");
      await hostPage.getByLabel("Host name").fill(hostName);
      await hostPage.getByLabel("Theme").selectOption("animals");
      await hostPage.getByLabel("Call mode").selectOption("manual");
      const createResponsePromise = hostPage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/lobbies",
      );
      await hostPage.getByRole("button", { name: "Create lobby" }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status(), await createResponse.text()).toBe(201);

      const created = hostPage.getByRole("region", { name: "Lobby created" });
      await expect(created).toBeVisible();
      const code = (await created.locator("strong").textContent())?.trim();
      if (code === undefined) throw new Error("The created lobby code was unavailable.");
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      await created.getByRole("link", { name: "Open lobby" }).click();
      await expect(hostPage.getByRole("heading", { name: `Lobby ${code}` })).toBeVisible();
      await expect(
        hostPage.getByRole("region", { name: "Live game status" }).locator(".connection-state"),
      ).toHaveText("Connected");

      const playerPage = await playerContext.newPage();
      await playerPage.goto(`/?code=${code}#join-lobby`);
      await playerPage.getByRole("button", { name: "Find lobby" }).click();
      await playerPage.getByLabel("Player name").fill(playerName);
      await playerPage.getByRole("button", { name: "Join lobby" }).click();
      await playerPage.getByRole("link", { name: "Open lobby" }).click();
      await expect(playerPage.getByRole("heading", { name: `Lobby ${code}` })).toBeVisible();
      await expect(
        playerPage.getByRole("region", { name: "Live game status" }).locator(".connection-state"),
      ).toHaveText("Connected");

      const hostRoster = hostPage.getByRole("list", { name: "Participants" });
      const playerRoster = playerPage.getByRole("list", { name: "Participants" });
      await expect(hostRoster.getByRole("listitem")).toHaveCount(2);
      await expect(hostRoster.getByRole("listitem").filter({ hasText: playerName })).toHaveCount(1);
      await expect(playerRoster.getByRole("listitem")).toHaveCount(2);
      await expect(playerPage.getByRole("button", { name: "Start round" })).toHaveCount(0);
      await hostPage.getByRole("button", { name: "Start round" }).click();
      await expect(hostPage.getByRole("button", { name: "Call Next" })).toBeVisible();
      await playerPage.getByRole("button", { name: "Refresh lobby" }).click();
      await expect(playerPage.getByText(/queued for the next round/i)).toBeVisible();
      await expect(playerPage.getByRole("button", { name: "Call Next" })).toHaveCount(0);

      const availableMark = hostPage.getByRole("button", {
        name: /called - mark available to mark/i,
      });
      for (
        let callCount = 0;
        callCount < 52 && (await availableMark.count()) === 0;
        callCount += 1
      ) {
        await hostPage.getByRole("button", { name: "Call Next" }).click();
        await playerPage.getByRole("button", { name: "Refresh lobby" }).click();
      }

      await expect(availableMark.first()).toBeVisible();
      await availableMark.first().click();
      const markedCell = hostPage.locator('.bingo-card-cell[data-state="marked"]').first();
      await expect(markedCell).toBeVisible();
      const markedValue = (await markedCell.locator(".bingo-card-value").textContent())?.trim();
      if (markedValue === undefined) throw new Error("The marked card value was unavailable.");
      expect(markedValue).toMatch(/^\d+$/);

      await reloadAndRecover(hostPage, code, hostName);
      await expect(
        hostPage.locator('.bingo-card-cell[data-state="marked"]', { hasText: markedValue }),
      ).toHaveCount(1);
      const restoredHostRoster = hostPage.getByRole("list", { name: "Participants" });
      const restoredHost = restoredHostRoster.getByRole("listitem").filter({ hasText: hostName });
      await expect(restoredHostRoster.getByRole("listitem")).toHaveCount(2);
      await expect(restoredHost.getByText("Host", { exact: true })).toBeVisible();
      await expect(restoredHost.getByText("Connected", { exact: true })).toBeVisible();
      await expect(hostPage.getByRole("button", { name: "Call Next" })).toBeVisible();
      await reloadAndRecover(playerPage, code, playerName);
      const restoredRoster = playerPage.getByRole("list", { name: "Participants" });
      await expect(restoredRoster.getByRole("listitem")).toHaveCount(2);
      await expect(restoredRoster.getByRole("listitem").filter({ hasText: hostName })).toHaveCount(
        1,
      );
      await expect(
        restoredRoster.getByRole("listitem").filter({ hasText: playerName }),
      ).toHaveCount(1);
      await expect(playerPage.getByRole("button", { name: "Call Next" })).toHaveCount(0);
      await expect(playerPage.getByRole("region", { name: "Your card" })).toContainText(
        /unavailable while you wait/i,
      );
      await expect(playerPage.locator('.bingo-card-cell[data-state="marked"]')).toHaveCount(0);
    } finally {
      await Promise.allSettled([hostContext.close(), playerContext.close()]);
    }
  });
});
