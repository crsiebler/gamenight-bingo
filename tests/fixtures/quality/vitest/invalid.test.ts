import { expect, test } from "vitest";

test("intentional Vitest failure", () => {
  expect("actual").toBe("expected");
});
