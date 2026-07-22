import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { themeCatalog } from "../../packages/themes/src/index.js";

const moodboardPath = resolve(process.cwd(), "docs/theme-moodboards.html");
const globalStylesPath = resolve(process.cwd(), "apps/web/src/app/globals.css");
const e2eTrustedProxySecret = "gamenight-bingo-e2e-trusted-proxy-marker";

function cssRgb(hex: string): string {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  return `rgb(${channels.join(", ")})`;
}

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

async function createThemedLobby(page: Page, themeId: string, index: number) {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `192.0.2.${index + 1}`,
    "x-gamenight-trusted-proxy": e2eTrustedProxySecret,
  });
  await page.goto("/");
  await page.getByLabel("Host name").fill(`Theme reviewer ${index}`);
  await page.getByLabel("Theme").selectOption(themeId);
  await page.getByLabel("Call mode").selectOption("manual");
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/lobbies",
  );
  await page.getByRole("button", { name: "Create lobby" }).click();
  const response = await createResponse;
  expect(response.status()).toBe(201);
  const created = page.getByRole("region", { name: "Lobby created" });
  const code = (await created.locator("strong").textContent())?.trim();
  if (code === undefined || !/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    throw new Error("The created lobby code was unavailable.");
  }
  await created.getByRole("link", { name: "Open lobby" }).click();
  await expect(page.getByRole("heading", { name: /lobby [A-HJ-NP-Z2-9]{6}/i })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Live game status" }).locator(".connection-state"),
  ).toHaveText("Connected");
  return code;
}

async function postCommand(
  page: Page,
  path: string,
  command: Readonly<Record<string, string | number>>,
) {
  const result = await page.evaluate(
    async ({ body, url }) => {
      const response = await fetch(url, {
        body: JSON.stringify(body),
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-gamenight-request": "mutation" },
        method: "POST",
      });
      return { body: await response.text(), status: response.status };
    },
    {
      body: { ...command, commandId: crypto.randomUUID(), schemaVersion: 1 },
      url: path,
    },
  );
  expect(result.status, result.body).toBeLessThan(300);
}

async function settleOneLine(page: Page, code: string) {
  const card = page.getByRole("region", { name: "Your card" });
  const availableMarks = card.getByRole("button", {
    name: /called - mark available to mark/i,
  });
  const callHistory = page.locator(".call-history li");
  let observedCalledState = false;
  let observedMarkedState = false;

  await activate(page, page.getByRole("button", { name: "Start round" }));
  await expect(page.getByRole("button", { name: "Call Next" })).toBeVisible();

  for (let callCount = 0; callCount < 75; callCount += 1) {
    const callNext = page.getByRole("button", { name: "Call Next" });
    if ((await callNext.count()) === 0) break;
    const previousCallCount = await callHistory.count();
    await postCommand(page, `/api/v1/lobbies/${code}/rounds/current/call-next`, {
      type: "call-next",
    });
    await expect(callHistory).toHaveCount(previousCallCount + 1);

    while ((await availableMarks.count()) > 0) {
      observedCalledState = true;
      const previousMarkCount = await card.locator('[data-state="marked"]').count();
      await availableMarks.first().click();
      await expect
        .poll(
          async () =>
            (await card.locator('[data-state="marked"]').count()) === previousMarkCount + 1 ||
            (await page.getByRole("region", { name: /bingo.*you won/i }).count()) > 0,
        )
        .toBe(true);
      observedMarkedState = true;
      if ((await page.getByRole("region", { name: /bingo.*you won/i }).count()) > 0) break;
    }
  }

  expect(observedCalledState).toBe(true);
  expect(observedMarkedState).toBe(true);
  await expect(page.getByRole("region", { name: /bingo.*you won/i })).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("accessibility and theme regressions", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1280 });
    await page.setContent(await readFile(moodboardPath, "utf8"));
  });

  test("keeps every canonical theme specimen accessible", async ({ page }) => {
    const cards = page.locator(".theme-card");
    await expect(cards).toHaveCount(themeCatalog.length);

    for (const theme of themeCatalog) {
      const card = page.locator(`[data-theme-id="${theme.id}"]`);
      await expect(card.getByRole("heading", { name: theme.name })).toBeVisible();
      await expect(card.getByText("Called", { exact: true })).toBeVisible();
      await expect(card.getByText("Marked", { exact: true })).toBeVisible();
      await expect(card.getByText("Unavailable", { exact: true })).toBeVisible();
      await expect(card.getByText("You won", { exact: true })).toBeVisible();
      await expect(card.getByText("Another player won", { exact: true })).toBeVisible();

      await card.getByText("Moodboard direction", { exact: true }).focus();
    }

    await expectNoAccessibilityViolations(page);
  });

  test("uses canonical theme focus rings and restores high-contrast link underlines", async ({
    page,
  }, testInfo) => {
    await page.setContent(`
      <style>${await readFile(globalStylesPath, "utf8")}</style>
      <main
        class="private-lobby-shell"
        data-theme-id="animals"
        style="--bingo-theme-focus-inner:#ffffff;--bingo-theme-focus-outer:#172b35;--bingo-theme-focus-width:4px;--bingo-theme-focus-offset:3px;--bingo-theme-focus-outer-width:7px"
      >
        <a class="hero-jump" href="#target">Start a lobby</a>
        <button type="button">Call Next</button>
      </main>
    `);
    const button = page.getByRole("button", { name: "Call Next" });
    await button.focus();
    await expect(button).toHaveCSS("outline-color", "rgb(255, 255, 255)");
    await expect(button).toHaveCSS("outline-width", "4px");
    await expect(button).toHaveCSS("outline-offset", "3px");
    await expect(button).toHaveCSS("box-shadow", /rgb\(23, 43, 53\).*7px/);

    await page.emulateMedia({ contrast: "more" });
    if (["android-chromium", "chrome", "chromium", "edge"].includes(testInfo.project.name)) {
      await expect(page.getByRole("link", { name: "Start a lobby" })).toHaveCSS(
        "text-decoration-line",
        "underline",
      );
    }
  });
});

test.describe("rendered application theme regressions", () => {
  test.skip(
    process.env["TEST_DATABASE_URL"] === undefined,
    "A migrated TEST_DATABASE_URL is required for rendered private theme coverage.",
  );

  test("renders every theme through the real private lobby", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "webkit" || testInfo.project.name === "ios-webkit",
      "The HTTP harness cannot carry the required Secure participant cookie in WebKit; run the documented native Safari journey over HTTPS.",
    );
    test.setTimeout(600_000);
    const supportsChromiumMediaEmulation = [
      "android-chromium",
      "chrome",
      "chromium",
      "edge",
    ].includes(testInfo.project.name);

    for (const [index, theme] of themeCatalog.entries()) {
      await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" });
      const code = await createThemedLobby(page, theme.id, index);

      const shell = page.locator("main.private-lobby-shell");
      await expect(shell).toHaveAttribute("data-theme-id", theme.id);
      const card = page.getByRole("region", { name: "Your card" });
      await expect(
        card
          .getByRole("button", { name: /unavailable because the round has not started/i })
          .first(),
      ).toBeVisible();
      await expect(
        card.getByRole("button", { name: /free.*automatically satisfied/i }),
      ).toBeVisible();
      await expect(shell.locator('[data-theme-asset="dauber"] use')).toHaveAttribute(
        "href",
        `${theme.visuals.spriteUrl}#dauber`,
      );
      const themedArtwork = shell.locator('[data-theme-asset="icon"]').first();
      const artworkContainer = themedArtwork.locator("..");
      await expect(artworkContainer).toHaveAttribute("data-loaded", "true");
      await expect(themedArtwork).toHaveCSS("opacity", "1");
      await expect(page.getByRole("group", { name: "Sound settings" })).toContainText(
        /sounds are off until you enable them/i,
      );
      const audioResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === theme.audio.spriteUrl,
      );
      await activate(page, page.getByRole("button", { name: "Enable sounds" }));
      expect((await audioResponse).status()).toBe(200);
      await expect(page.getByRole("group", { name: "Sound settings" })).toContainText(
        /optional theme sounds are ready/i,
      );

      const startRound = page.getByRole("button", { name: "Start round" });
      await tabTo(page, page.getByRole("button", { name: "Save setup" }));
      await page.keyboard.press("Tab");
      await expect(startRound).toBeFocused();
      await expect(startRound).toHaveCSS("outline-width", `${theme.tokens.focus.widthPx}px`);
      await expect(startRound).toHaveCSS("outline-color", cssRgb(theme.tokens.focus.inner));
      await expect(startRound).toHaveCSS(
        "box-shadow",
        new RegExp(`${theme.tokens.focus.widthPx + theme.tokens.focus.offsetPx}px`),
      );
      await expectNoAccessibilityViolations(page);
      if (testInfo.project.name === "chromium") {
        await expect(themedArtwork).toHaveScreenshot(`${theme.id}-theme.png`, {
          animations: "disabled",
          maxDiffPixels: 0,
          scale: "css",
          threshold: 0,
        });
      }

      const failedSpriteUrl = `${theme.visuals.spriteUrl}?e2e-failure=${index}`;
      await page.route(`**${failedSpriteUrl}`, (route) => route.abort());
      await shell.locator("img[data-theme-sprite-preload]").evaluate((element, src) => {
        element.setAttribute("src", src);
      }, failedSpriteUrl);
      const failedArtwork = page.locator('[data-theme-asset="icon"]').first();
      const failedArtworkContainer = failedArtwork.locator("..");
      await expect(failedArtworkContainer).toHaveAttribute("data-loaded", "false");
      await expect(failedArtwork).toHaveCSS("opacity", "0");
      await expect(failedArtworkContainer.locator(".theme-art-fallback")).toHaveCSS(
        "opacity",
        "0.3",
      );
      await page.unroute(`**${failedSpriteUrl}`);

      await settleOneLine(page, code);
      const result = page.getByRole("region", { name: /bingo.*you won/i });
      await expect(result.locator('[data-theme-asset="winner"]')).toBeVisible();
      await expect(result.locator(".theme-outcome-art")).toHaveAttribute("data-loaded", "false");
      await expectNoAccessibilityViolations(page);
      const resultArtwork = result.locator(".theme-art-vector");
      await expect(resultArtwork).toHaveCSS("animation-name", "theme-art-arrive");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(resultArtwork).toHaveCSS("animation-name", "none");

      const artwork = shell.locator(".theme-artwork").first();
      await expect(artwork).toBeVisible();
      const cell = card.locator(".bingo-card-cell").first();
      await expect(cell).toHaveCSS("border-top-width", "2px");
      if (supportsChromiumMediaEmulation) {
        await page.emulateMedia({ contrast: "more" });
        await expect(artwork).toBeHidden();
        await expect(cell).toHaveCSS("border-top-width", "3px");

        await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" });
        await expect(artwork).toBeVisible();
        await page.emulateMedia({ forcedColors: "active" });
        await expect(artwork).toBeHidden();
      }

      await page.emulateMedia({
        contrast: "no-preference",
        forcedColors: "none",
        reducedMotion: "no-preference",
      });
    }
  });
});
