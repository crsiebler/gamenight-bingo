import { render, screen } from "@testing-library/react";
import { test } from "vitest";

test("intentional React Testing Library failure", () => {
  render(<p>Waiting for host</p>);
  screen.getByRole("button");
});
