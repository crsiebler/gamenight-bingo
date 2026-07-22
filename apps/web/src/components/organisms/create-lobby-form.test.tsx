import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { themeCatalog } from "../../../../../packages/themes/src/index.js";

import {
  CreateLobbyForm,
  THEME_OPTIONS,
  type CreateLobbySessionFactory,
} from "./create-lobby-form.js";
import { CreateLobbyFlowError } from "../../lib/create-lobby-flow.js";

const patterns = [
  { id: "standard-one-line", name: "One Line", category: "standard" },
  { id: "shape-four-corners", name: "Four Corners", category: "shape" },
  { id: "shape-x", name: "X", category: "shape" },
  { id: "letter-x", name: "X", category: "letter" },
] as const;

describe("CreateLobbyForm", () => {
  it("uses the canonical theme catalog as its complete option source", () => {
    expect(THEME_OPTIONS).toBe(themeCatalog);
  });

  it("defaults to One Line and manual calling without an interval", () => {
    render(<CreateLobbyForm patterns={patterns} />);

    expect(screen.getByRole("textbox", { name: /host name/i })).toBeRequired();
    expect(screen.getByRole("combobox", { name: /theme/i })).toBeRequired();
    expect(screen.getByRole("combobox", { name: /pattern/i })).toHaveValue("standard-one-line");
    expect(screen.getByRole("combobox", { name: /call mode/i })).toHaveValue("manual");
    expect(screen.queryByRole("combobox", { name: /call interval/i })).toBeNull();
    expect(
      screen.getAllByRole("option", {
        name: /animals|nature|superheroes|pirates|ghosts|sports|christmas|halloween|july 4th|valentine's day|birthday/i,
      }),
    ).toHaveLength(THEME_OPTIONS.length);
    expect(screen.getByRole("option", { name: "X (Shape)" })).toBeVisible();
    expect(screen.getByRole("option", { name: "X (Letter)" })).toBeVisible();
  });

  it("shows only supported intervals for automatic calling", () => {
    render(<CreateLobbyForm patterns={patterns} />);

    fireEvent.change(screen.getByRole("combobox", { name: /call mode/i }), {
      target: { value: "automatic" },
    });

    const interval = screen.getByRole("combobox", { name: /call interval/i });
    expect(interval).toBeRequired();
    expect(interval).toHaveValue("30");
    expect(Array.from(interval.querySelectorAll("option"), (option) => option.value)).toEqual([
      "5",
      "10",
      "30",
      "60",
      "120",
    ]);

    fireEvent.change(screen.getByRole("combobox", { name: /call mode/i }), {
      target: { value: "manual" },
    });
    expect(screen.queryByRole("combobox", { name: /call interval/i })).toBeNull();
  });

  it("submits the selected automatic configuration once", async () => {
    const run = vi.fn(async () => ({
      code: "ABC234",
      username: "River",
      themeId: "nature",
      patternId: "shape-four-corners",
      callConfiguration: { mode: "automatic" as const, intervalSeconds: 60 as const },
    }));
    const createSession = vi.fn(() => ({ hasCreatedLobby: false, run }));

    render(
      <CreateLobbyForm
        createSession={createSession as CreateLobbySessionFactory}
        patterns={patterns}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /host name/i }), {
      target: { value: "River" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /theme/i }), {
      target: { value: "nature" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /pattern/i }), {
      target: { value: "shape-four-corners" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /call mode/i }), {
      target: { value: "automatic" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /call interval/i }), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create lobby" }));

    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(createSession).toHaveBeenCalledWith({
      username: "River",
      themeId: "nature",
      patternId: "shape-four-corners",
      callConfiguration: { mode: "automatic", intervalSeconds: 60 },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Lobby ABC234 is ready");
    expect(screen.getByRole("link", { name: "Open lobby" })).toHaveAttribute(
      "href",
      "/lobbies/ABC234",
    );
  });

  it("focuses and announces an empty host-name error", async () => {
    const createSession = vi.fn();
    render(
      <CreateLobbyForm
        createSession={createSession as CreateLobbySessionFactory}
        patterns={patterns}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: /theme/i }), {
      target: { value: "nature" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create lobby" }));

    const hostName = screen.getByRole("textbox", { name: /host name/i });
    expect(hostName).toHaveFocus();
    expect(hostName).toHaveAccessibleDescription(expect.stringContaining("Enter a host name"));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a host name");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("locks ambiguous create attempts and reuses the same flow session", async () => {
    const run = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(
        new CreateLobbyFlowError(
          "We could not confirm the server response. Retry setup to safely check the same command.",
          { ambiguous: true, retryable: true },
        ),
      );
    const createSession = vi.fn(() => ({ hasCreatedLobby: false, run }));
    render(
      <CreateLobbyForm
        createSession={createSession as CreateLobbySessionFactory}
        patterns={patterns}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /host name/i }), {
      target: { value: "River" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /theme/i }), {
      target: { value: "nature" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create lobby" }));
    await screen.findByRole("button", { name: "Retry setup" });

    expect(screen.getByRole("textbox", { name: /host name/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("does not offer retries for terminal partial failures", async () => {
    const run = vi.fn(async () => {
      throw new CreateLobbyFlowError("Authentication is required.", {
        ambiguous: false,
        retryable: false,
      });
    });
    const createSession = vi.fn(() => ({ hasCreatedLobby: true, run }));
    render(
      <CreateLobbyForm
        createSession={createSession as CreateLobbySessionFactory}
        patterns={patterns}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /host name/i }), {
      target: { value: "River" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /theme/i }), {
      target: { value: "nature" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create lobby" }));

    await screen.findByText(/setup cannot continue/i);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("restores create after editing a terminal failure before lobby creation", async () => {
    const failedRun = vi.fn(async () => {
      throw new CreateLobbyFlowError("That username is already in use.", {
        ambiguous: false,
        retryable: false,
      });
    });
    const successfulRun = vi.fn(async () => ({
      code: "ABC234",
      username: "River Two",
      themeId: "nature",
      patternId: "standard-one-line",
      callConfiguration: { mode: "manual" as const },
    }));
    const createSession = vi
      .fn()
      .mockReturnValueOnce({ hasCreatedLobby: false, run: failedRun })
      .mockReturnValueOnce({ hasCreatedLobby: false, run: successfulRun });
    render(
      <CreateLobbyForm
        createSession={createSession as CreateLobbySessionFactory}
        patterns={patterns}
      />,
    );
    const hostName = screen.getByRole("textbox", { name: /host name/i });
    fireEvent.change(hostName, { target: { value: "River" } });
    fireEvent.change(screen.getByRole("combobox", { name: /theme/i }), {
      target: { value: "nature" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create lobby" }));
    await screen.findByText(/edit your setup and try again/i);
    expect(screen.queryByRole("button", { name: /create lobby/i })).toBeNull();

    fireEvent.change(hostName, { target: { value: "River Two" } });
    fireEvent.click(screen.getByRole("button", { name: "Create lobby" }));

    await waitFor(() => expect(successfulRun).toHaveBeenCalledOnce());
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Lobby ABC234 is ready");
  });
});
