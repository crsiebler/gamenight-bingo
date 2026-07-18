import "@testing-library/jest-dom/vitest";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LobbyEntryResponseSchema,
  SameDeviceSessionStatusResponseSchema,
} from "@gamenight-bingo/contracts";

import {
  JoinLobbyForm,
  type LobbyEntrySessionFactory,
  type SessionStatusLookup,
} from "./join-lobby-form.js";
import { LobbyEntryFlowError } from "../../lib/lobby-entry-flow.js";

const newParticipantStatus = SameDeviceSessionStatusResponseSchema.parse({
  schemaVersion: 1,
  type: "same-device-session-status",
  status: "new-participant-required",
});

const waitingEntry = LobbyEntryResponseSchema.parse({
  schemaVersion: 1,
  type: "lobby-entry",
  commandId: "command-join",
  idempotentReplay: false,
  lobby: { id: "lobby-1", code: "ABC234", themeId: "nature" },
  participant: {
    id: "participant-1",
    username: "River Song",
    role: "player",
    roundEligibility: "waiting",
  },
  session: {
    id: "session-1",
    status: "active",
    issuedAt: "2026-07-18T12:00:00.000Z",
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("JoinLobbyForm", () => {
  it("normalizes typed and pasted codes before looking up same-device status", async () => {
    const lookupSession = vi.fn<SessionStatusLookup>(async () => newParticipantStatus);
    render(<JoinLobbyForm lookupSession={lookupSession} />);
    const code = screen.getByRole("textbox", { name: /lobby code/i });

    fireEvent.change(code, { target: { value: "abc234" } });
    expect(code).toHaveValue("ABC234");
    code.focus();
    fireEvent.submit(screen.getByRole("form", { name: /join a private lobby/i }));

    await waitFor(() => expect(lookupSession).toHaveBeenCalledWith("ABC234"));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /player name/i })).toHaveFocus(),
    );
  });

  it("focuses and associates invalid code and username errors", async () => {
    const lookupSession = vi.fn<SessionStatusLookup>(async () => newParticipantStatus);
    const createEntrySession = vi.fn<LobbyEntrySessionFactory>();
    render(<JoinLobbyForm createEntrySession={createEntrySession} lookupSession={lookupSession} />);
    const form = screen.getByRole("form", { name: /join a private lobby/i });
    const code = screen.getByRole("textbox", { name: /lobby code/i });

    fireEvent.change(code, { target: { value: "O01" } });
    fireEvent.submit(form);

    expect(code).toHaveFocus();
    expect(code).toHaveAccessibleDescription(expect.stringContaining("six-character"));
    expect(screen.getByRole("alert")).toHaveTextContent("six-character");
    expect(lookupSession).not.toHaveBeenCalled();

    fireEvent.change(code, { target: { value: "abc234" } });
    fireEvent.submit(form);
    await screen.findByRole("textbox", { name: /player name/i });
    fireEvent.submit(form);

    const username = screen.getByRole("textbox", { name: /player name/i });
    expect(username).toHaveFocus();
    expect(username).toHaveAccessibleDescription(expect.stringContaining("Enter a username"));
    expect(createEntrySession).not.toHaveBeenCalled();
  });

  it("submits the normalized username and explains waiting eligibility", async () => {
    const run = vi.fn(async () => waitingEntry);
    const createEntrySession = vi.fn(() => ({ run }));
    render(
      <JoinLobbyForm
        createEntrySession={createEntrySession as LobbyEntrySessionFactory}
        initialLobbyCode="abc234"
        lookupSession={async () => newParticipantStatus}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /find lobby/i }));
    const username = await screen.findByRole("textbox", { name: /player name/i });
    fireEvent.change(username, { target: { value: "  River   Song  " } });
    fireEvent.click(screen.getByRole("button", { name: /^join lobby$/i }));

    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(createEntrySession).toHaveBeenCalledWith({
      action: "join",
      code: "ABC234",
      username: "River Song",
    });
    expect(screen.getByRole("status")).toHaveTextContent(/River Song.*waiting.*next round/i);
  });

  it("offers rejoin only before its deadline and refreshes status at expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const lookupSession = vi
      .fn<SessionStatusLookup>()
      .mockResolvedValueOnce(
        SameDeviceSessionStatusResponseSchema.parse({
          schemaVersion: 1,
          type: "same-device-session-status",
          status: "rejoin-available",
          username: "Prior Player",
          rejoinUntil: "2026-07-18T12:00:01.000Z",
        }),
      )
      .mockResolvedValueOnce(newParticipantStatus);
    render(<JoinLobbyForm initialLobbyCode="ABC234" lookupSession={lookupSession} />);

    fireEvent.click(screen.getByRole("button", { name: /find lobby/i }));
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Rejoin as Prior Player" })).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: /player name/i })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.queryByRole("button", { name: /rejoin as/i })).toBeNull();
    expect(screen.getByRole("textbox", { name: /player name/i })).toBeVisible();
    expect(lookupSession).toHaveBeenCalledTimes(2);
  });

  it("unlocks a new join when an ambiguous rejoin reaches its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const lookupSession = vi
      .fn<SessionStatusLookup>()
      .mockResolvedValueOnce(
        SameDeviceSessionStatusResponseSchema.parse({
          schemaVersion: 1,
          type: "same-device-session-status",
          status: "rejoin-available",
          username: "Prior Player",
          rejoinUntil: "2026-07-18T12:00:01.000Z",
        }),
      )
      .mockResolvedValueOnce(newParticipantStatus);
    const run = vi.fn(async () => {
      throw new LobbyEntryFlowError("We could not confirm the server response.", {
        ambiguous: true,
        retryable: true,
      });
    });
    render(
      <JoinLobbyForm
        createEntrySession={() => ({ run })}
        initialLobbyCode="ABC234"
        lookupSession={lookupSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /find lobby/i }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Rejoin as Prior Player" }));
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Rejoin as Prior Player" })).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByRole("textbox", { name: /player name/i })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: /player name/i })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Join lobby" })).toBeEnabled();
  });

  it("does not refresh status while a rejoin mutation crosses its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const lookupSession = vi.fn<SessionStatusLookup>(async () =>
      SameDeviceSessionStatusResponseSchema.parse({
        schemaVersion: 1,
        type: "same-device-session-status",
        status: "rejoin-available",
        username: "Prior Player",
        rejoinUntil: "2026-07-18T12:00:01.000Z",
      }),
    );
    let resolveRejoin!: (entry: typeof waitingEntry) => void;
    const run = vi.fn(
      () =>
        new Promise<typeof waitingEntry>((resolve) => {
          resolveRejoin = resolve;
        }),
    );
    render(
      <JoinLobbyForm
        createEntrySession={() => ({ run })}
        initialLobbyCode="ABC234"
        lookupSession={lookupSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /find lobby/i }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Rejoin as Prior Player" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(lookupSession).toHaveBeenCalledOnce();
    await act(async () => resolveRejoin(waitingEntry));
    expect(screen.getByRole("status")).toHaveTextContent(/waiting.*next round/i);
    expect(lookupSession).toHaveBeenCalledOnce();
  });

  it("clears an ambiguous rejoin after a failed deadline refresh and successful manual lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const lookupSession = vi
      .fn<SessionStatusLookup>()
      .mockResolvedValueOnce(
        SameDeviceSessionStatusResponseSchema.parse({
          schemaVersion: 1,
          type: "same-device-session-status",
          status: "rejoin-available",
          username: "Prior Player",
          rejoinUntil: "2026-07-18T12:00:01.000Z",
        }),
      )
      .mockRejectedValueOnce(
        new LobbyEntryFlowError("We could not refresh that lobby. Try again.", {
          ambiguous: false,
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(newParticipantStatus);
    const run = vi.fn(async () => {
      throw new LobbyEntryFlowError("We could not confirm the server response.", {
        ambiguous: true,
        retryable: true,
      });
    });
    render(
      <JoinLobbyForm
        createEntrySession={() => ({ run })}
        initialLobbyCode="ABC234"
        lookupSession={lookupSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /find lobby/i }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Rejoin as Prior Player" }));
    await act(async () => undefined);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole("button", { name: "Find lobby" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Find lobby" }));
    await act(async () => undefined);

    expect(screen.getByRole("textbox", { name: /player name/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Join lobby" })).toBeEnabled();
  });

  it("preserves focus outside the join form when a deadline refresh changes its status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const lookupSession = vi
      .fn<SessionStatusLookup>()
      .mockResolvedValueOnce(
        SameDeviceSessionStatusResponseSchema.parse({
          schemaVersion: 1,
          type: "same-device-session-status",
          status: "rejoin-available",
          username: "Prior Player",
          rejoinUntil: "2026-07-18T12:00:01.000Z",
        }),
      )
      .mockResolvedValueOnce(newParticipantStatus);
    render(
      <>
        <JoinLobbyForm initialLobbyCode="ABC234" lookupSession={lookupSession} />
        <label>
          Host name
          <input />
        </label>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: /find lobby/i }));
    await act(async () => undefined);
    const hostName = screen.getByRole("textbox", { name: "Host name" });
    hostName.focus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(hostName).toHaveFocus();
    expect(screen.getByRole("textbox", { name: /player name/i })).toBeVisible();
  });

  it("does not transfer deadline focus when the join form no longer owns focus", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const lookupSession = vi
      .fn<SessionStatusLookup>()
      .mockResolvedValueOnce(
        SameDeviceSessionStatusResponseSchema.parse({
          schemaVersion: 1,
          type: "same-device-session-status",
          status: "rejoin-available",
          username: "Prior Player",
          rejoinUntil: "2026-07-18T12:00:01.000Z",
        }),
      )
      .mockResolvedValueOnce(newParticipantStatus);
    render(<JoinLobbyForm initialLobbyCode="ABC234" lookupSession={lookupSession} />);

    fireEvent.click(screen.getByRole("button", { name: /find lobby/i }));
    await act(async () => undefined);
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(document.body).toHaveFocus();
    expect(screen.getByRole("textbox", { name: /player name/i })).toBeVisible();
  });

  it("focuses new join after the server rejects an expired rejoin credential", async () => {
    const run = vi.fn(async () => {
      throw new LobbyEntryFlowError("Authentication is required.", {
        ambiguous: false,
        code: "UNAUTHORIZED",
        retryable: false,
      });
    });
    render(
      <JoinLobbyForm
        createEntrySession={() => ({ run })}
        initialLobbyCode="ABC234"
        lookupSession={async () =>
          SameDeviceSessionStatusResponseSchema.parse({
            schemaVersion: 1,
            type: "same-device-session-status",
            status: "rejoin-available",
            username: "Prior Player",
            rejoinUntil: new Date(Date.now() + 60_000).toISOString(),
          })
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /find lobby/i }));
    const rejoin = await screen.findByRole("button", { name: "Rejoin as Prior Player" });
    fireEvent.click(rejoin);

    const username = await screen.findByRole("textbox", { name: /player name/i });
    expect(username).toBeEnabled();
    expect(username).toHaveFocus();
  });

  it("does not expose join or rejoin actions for an already-active session", async () => {
    render(
      <JoinLobbyForm
        initialLobbyCode="ABC234"
        lookupSession={async () =>
          SameDeviceSessionStatusResponseSchema.parse({
            schemaVersion: 1,
            type: "same-device-session-status",
            status: "active",
            username: "River",
            role: "player",
          })
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /find lobby/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/already active as River/i);
    expect(screen.queryByRole("button", { name: /join lobby|rejoin as/i })).toBeNull();
  });
});
