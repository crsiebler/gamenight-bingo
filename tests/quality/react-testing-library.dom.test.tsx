import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("React Testing Library", () => {
  it("queries rendered content by accessible role and name", () => {
    render(<button type="button">Start round</button>);

    expect(screen.getByRole("button", { name: "Start round" })).toBeInTheDocument();
  });
});
