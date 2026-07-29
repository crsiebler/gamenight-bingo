import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage, { metadata } from "../../app/page.js";
import { PublicLandingPage } from "./public-landing-page.js";

const patterns = [{ id: "standard-one-line", name: "One Line", category: "standard" }] as const;

describe("PublicLandingPage", () => {
  it("presents the public create journey and page metadata", () => {
    render(<PublicLandingPage patterns={patterns} />);

    expect(screen.getByRole("heading", { level: 1, name: /bingo night/i })).toBeVisible();
    expect(screen.getByRole("form", { name: /create a private lobby/i })).toBeVisible();
    expect(screen.getByRole("form", { name: /join a private lobby/i })).toBeVisible();
    expect(metadata.title).toBe("GameNight Bingo | Create a private bingo lobby");
    expect(metadata.description).toMatch(/private 75-ball bingo/i);
  });

  it("explains the necessary same-device cookie and data lifecycle", () => {
    render(
      <PublicLandingPage
        lobbyIdleTtlSeconds={1_800}
        patterns={patterns}
        playerReconnectWindowSeconds={120}
      />,
    );

    const notice = screen.getByRole("complementary", { name: "Privacy and your data" });
    expect(notice).toHaveTextContent(/necessary.*lobby-scoped cookie/i);
    expect(notice).toHaveTextContent(/same device.*two minutes/i);
    expect(notice).toHaveTextContent(/do not fingerprint.*unnecessary device attributes/i);
    expect(notice).toHaveTextContent(/no third-party analytics.*private lobby routes/i);
    expect(notice).toHaveTextContent(/inactive.*30 minutes/i);
    expect(notice).toHaveTextContent(/game and participant-session data/i);
  });

  it("formats configured privacy durations", () => {
    render(
      <PublicLandingPage
        lobbyIdleTtlSeconds={3_600}
        patterns={patterns}
        playerReconnectWindowSeconds={180}
      />,
    );

    const notice = screen.getByRole("complementary", { name: "Privacy and your data" });
    expect(notice).toHaveTextContent(/three minutes/i);
    expect(notice).toHaveTextContent(/60 minutes/i);
  });

  it("prefills an invite code without treating it as participant identity", () => {
    render(<PublicLandingPage initialLobbyCode="abc234" patterns={patterns} />);

    expect(screen.getByRole("textbox", { name: /lobby code/i })).toHaveValue("ABC234");
    expect(screen.getByRole("button", { name: /find lobby/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /rejoin as/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /player name/i })).toBeNull();
  });

  it("accepts only the scalar invite locator from page search parameters", async () => {
    render(
      await HomePage({
        searchParams: Promise.resolve({ code: "abc234", username: "must-not-prefill" }),
      }),
    );

    expect(screen.getByRole("textbox", { name: /lobby code/i })).toHaveValue("ABC234");
    expect(screen.queryByDisplayValue("must-not-prefill")).toBeNull();
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
