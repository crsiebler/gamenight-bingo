import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let attempts = 0; attempts < 120; attempts += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) {
      return;
    }
    await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
  }
  throw new Error(`Keyboard focus did not reach ${await target.toString()}.`);
}

async function activate(page: Page, target: Locator, key: "Enter" | "Space" = "Enter") {
  await tabTo(page, target);
  await expect(target).toBeFocused();
  await page.keyboard.press(key);
}

async function focusCardCell(page: Page, target: Locator) {
  const targetIndex = await target.evaluate((element) =>
    Array.from(document.querySelectorAll(".bingo-card-cell")).indexOf(element),
  );
  if (targetIndex < 0) throw new Error("The target card cell was unavailable.");

  const activeCell = page.locator('.bingo-card-cell[tabindex="0"]');
  await tabTo(page, activeCell);
  const activeIndex = await activeCell.evaluate((element) =>
    Array.from(document.querySelectorAll(".bingo-card-cell")).indexOf(element),
  );
  const rowDifference = Math.floor(targetIndex / 5) - Math.floor(activeIndex / 5);
  const columnDifference = (targetIndex % 5) - (activeIndex % 5);
  for (let step = 0; step < Math.abs(rowDifference); step += 1) {
    await page.keyboard.press(rowDifference > 0 ? "ArrowDown" : "ArrowUp");
  }
  for (let step = 0; step < Math.abs(columnDifference); step += 1) {
    await page.keyboard.press(columnDifference > 0 ? "ArrowRight" : "ArrowLeft");
  }
  await expect(target).toBeFocused();
}

async function markFocusedCardCell(page: Page) {
  const markResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/v1\/lobbies\/[A-HJ-NP-Z2-9]{6}\/cards\/own\/marks$/.test(
        new URL(response.url()).pathname,
      ),
  );
  await page.keyboard.press("Space");
  const response = await markResponse;
  expect(response.status(), await response.text()).toBe(200);
}

async function callNextThroughHttp(page: Page, code: string) {
  const result = await page.evaluate(
    async ({ commandId, path }) => {
      const response = await fetch(path, {
        body: JSON.stringify({
          commandId,
          schemaVersion: 1,
          type: "call-next",
        }),
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
        method: "POST",
      });
      return { body: await response.text(), status: response.status };
    },
    {
      commandId: crypto.randomUUID(),
      path: `/api/v1/lobbies/${code}/rounds/current/call-next`,
    },
  );
  expect(result.status, result.body).toBeLessThan(300);
}

async function reloadAndRecover(page: Page, code: string, username: string) {
  await page.reload();
  const lobbyHeading = page.getByRole("heading", { name: `Lobby ${code}` });
  const rejoinLink = page.getByRole("link", { name: "Join or rejoin" });
  await expect
    .poll(async () => (await lobbyHeading.isVisible()) || (await rejoinLink.isVisible()))
    .toBe(true);
  if (await rejoinLink.isVisible()) {
    await activate(page, rejoinLink);
    await activate(page, page.getByRole("button", { name: "Find lobby" }));
    await activate(page, page.getByRole("button", { name: `Rejoin as ${username}` }));
    await activate(page, page.getByRole("link", { name: "Open lobby" }));
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
    test.setTimeout(120_000);
    const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`;
    const hostName = `Host ${suffix}`;
    const playerName = `Player ${suffix}`;
    const hostContext = await browser.newContext();
    const playerContext = await browser.newContext();

    try {
      const hostPage = await hostContext.newPage();
      await hostPage.goto("/");
      const hostNameInput = hostPage.getByLabel("Host name");
      await tabTo(hostPage, hostNameInput);
      await hostPage.keyboard.press("Enter");
      await expect(hostNameInput).toBeFocused();
      await expect(
        hostPage.getByRole("alert").filter({ hasText: "Enter a host name" }),
      ).toBeVisible();
      await expectNoAccessibilityViolations(hostPage);
      await hostNameInput.fill(hostName);
      await hostPage.getByLabel("Theme").selectOption("animals");
      await hostPage.getByLabel("Call mode").selectOption("manual");
      const createResponsePromise = hostPage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/lobbies",
      );
      const createLobby = hostPage.getByRole("button", { name: "Create lobby" });
      await activate(hostPage, createLobby);
      const createResponse = await createResponsePromise;
      expect(createResponse.status(), await createResponse.text()).toBe(201);

      const created = hostPage.getByRole("region", { name: "Lobby created" });
      await expect(created).toBeVisible();
      const code = (await created.locator("strong").textContent())?.trim();
      if (code === undefined) throw new Error("The created lobby code was unavailable.");
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      await activate(hostPage, created.getByRole("link", { name: "Open lobby" }));
      await expect(hostPage.getByRole("heading", { name: `Lobby ${code}` })).toBeVisible();
      await expect(
        hostPage.getByRole("region", { name: "Live game status" }).locator(".connection-state"),
      ).toHaveText("Connected");

      const playerPage = await playerContext.newPage();
      await playerPage.goto(`/?code=${code}#join-lobby`);
      const findLobby = playerPage.getByRole("button", { name: "Find lobby" });
      await activate(playerPage, findLobby);
      const playerNameInput = playerPage.getByLabel("Player name");
      await expect(playerNameInput).toBeFocused();
      await playerNameInput.fill(playerName);
      await playerPage.keyboard.press("Enter");
      await activate(playerPage, playerPage.getByRole("link", { name: "Open lobby" }));
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
      const startRound = hostPage.getByRole("button", { name: "Start round" });
      await activate(hostPage, startRound);
      await expect(hostPage.getByRole("button", { name: "Call Next" })).toBeVisible();
      await activate(playerPage, playerPage.getByRole("button", { name: "Refresh lobby" }));
      await expect(playerPage.getByText(/queued for the next round/i)).toBeVisible();
      await expect(playerPage.getByRole("button", { name: "Call Next" })).toHaveCount(0);

      const availableMark = hostPage.getByRole("button", {
        name: /called - mark available to mark/i,
      });
      let calledWithKeyboard = false;
      for (
        let callCount = 0;
        callCount < 52 && (await availableMark.count()) === 0;
        callCount += 1
      ) {
        const previousCallCount = await hostPage.locator(".call-history li").count();
        if (!calledWithKeyboard) {
          await activate(hostPage, hostPage.getByRole("button", { name: "Call Next" }));
          calledWithKeyboard = true;
        } else {
          await callNextThroughHttp(hostPage, code);
        }
        await expect(hostPage.locator(".call-history li")).toHaveCount(previousCallCount + 1);
      }

      await expect(availableMark.first()).toBeVisible();
      await focusCardCell(hostPage, availableMark.first());
      await markFocusedCardCell(hostPage);
      const markedCell = hostPage.locator('.bingo-card-cell[data-state="marked"]').first();
      await expect(markedCell).toBeVisible();
      const markedValue = (await markedCell.locator(".bingo-card-value").textContent())?.trim();
      if (markedValue === undefined) throw new Error("The marked card value was unavailable.");
      expect(markedValue).toMatch(/^\d+$/);
      await expectNoAccessibilityViolations(hostPage);

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

      const callHistory = hostPage.locator(".call-history li");
      const hostCard = hostPage.getByRole("region", { name: "Your card" });
      const winningMarks = hostCard.locator('.bingo-card-cell[data-state="marked"]');
      const winningMarkAvailable = hostCard.getByRole("button", {
        name: /called - mark available to mark/i,
      });
      for (let callCount = 0; callCount < 75; callCount += 1) {
        const callNext = hostPage.getByRole("button", { name: "Call Next" });
        if ((await callNext.count()) === 0) break;
        await expect(callNext).toBeEnabled();
        const previousCallCount = await callHistory.count();
        await callNextThroughHttp(hostPage, code);
        await expect(callHistory).toHaveCount(previousCallCount + 1);
        while ((await winningMarkAvailable.count()) > 0) {
          const previousMarkCount = await winningMarks.count();
          await focusCardCell(hostPage, winningMarkAvailable.first());
          await markFocusedCardCell(hostPage);
          await expect
            .poll(
              async () =>
                (await winningMarks.count()) === previousMarkCount + 1 ||
                (await hostPage.getByRole("button", { name: "Call Next" }).count()) === 0,
            )
            .toBe(true);
          if ((await hostPage.getByRole("button", { name: "Call Next" }).count()) === 0) break;
        }
      }

      const result = hostPage.getByRole("region", { name: /bingo.*you won/i });
      await expect(result).toBeVisible({ timeout: 10_000 });
      const resultHeading = result.getByRole("heading", { name: /bingo.*you won/i });
      await expect(resultHeading).toBeFocused();
      await expectNoAccessibilityViolations(hostPage);
      const resultArtwork = result.locator(".theme-outcome-art .theme-art-vector");
      await expect(resultArtwork).toHaveCSS("animation-name", "theme-art-arrive");
      await hostPage.emulateMedia({ reducedMotion: "reduce" });
      await expect(resultArtwork).toHaveCSS("animation-name", "none");

      const endRound = hostPage.getByRole("button", { name: "End round" });
      await activate(hostPage, endRound);
      const dialog = hostPage.getByRole("dialog", { name: "End this round?" });
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await hostPage.keyboard.press("Escape");
      await expect(endRound).toBeFocused();
      await activate(hostPage, endRound);
      await hostPage.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "End round" })).toBeFocused();
      await hostPage.keyboard.press("Shift+Tab");
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await hostPage.keyboard.press("Tab");
      await hostPage.keyboard.press("Enter");
      await expect(resultHeading).toBeFocused();
      await expect(hostPage.getByRole("status", { name: "Outcome announcement" })).toContainText(
        /round ended.*confirmed result remains visible/i,
      );
    } finally {
      await Promise.allSettled([hostContext.close(), playerContext.close()]);
    }
  });
});
