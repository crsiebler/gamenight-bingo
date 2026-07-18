import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { metadata } from "../../app/page.js";
import { PublicLandingPage } from "./public-landing-page.js";

const patterns = [{ id: "standard-one-line", name: "One Line", category: "standard" }] as const;

describe("PublicLandingPage", () => {
  it("presents the public create journey and page metadata", () => {
    render(<PublicLandingPage patterns={patterns} />);

    expect(screen.getByRole("heading", { level: 1, name: /bingo night/i })).toBeVisible();
    expect(screen.getByRole("form", { name: /create a private lobby/i })).toBeVisible();
    expect(metadata.title).toBe("GameNight Bingo | Create a private bingo lobby");
    expect(metadata.description).toMatch(/private 75-ball bingo/i);
  });

  it("keeps public JSON-LD in parity with the visible HowTo steps", () => {
    const { container } = render(<PublicLandingPage patterns={patterns} />);
    const visibleSteps = screen
      .getAllByRole("listitem")
      .filter((item) => item.closest("ol") !== null)
      .map((item) => item.textContent?.replace(/\s+/g, " ").trim());
    const script = container.querySelector('script[type="application/ld+json"]');
    const schema = JSON.parse(script?.textContent ?? "null") as {
      "@graph": Array<{ "@type": string; step?: Array<{ name: string; text: string }> }>;
    };
    const howTo = schema["@graph"].find((entry) => entry["@type"] === "HowTo");

    expect(howTo?.step?.map((step) => `${step.name} ${step.text}`)).toEqual(visibleSteps);
    expect(script?.textContent).not.toContain("participant");
    expect(script?.textContent).not.toContain("session");
    expect(script?.textContent).not.toContain("lobby code");
  });
});
