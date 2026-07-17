import { expect, test } from "@playwright/test";

test("intentional Playwright failure", () => {
  expect("actual").toBe("expected");
});
