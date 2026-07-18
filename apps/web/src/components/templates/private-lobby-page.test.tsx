import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CommandAckSchema,
  CONTRACT_SCHEMA_VERSION,
  SnapshotSchema,
  type CommandAck,
  type Snapshot,
} from "@gamenight-bingo/contracts";

import { metadata, revalidate } from "../../app/lobbies/[code]/page.js";
import { PrivateLobbyFlowError } from "../../lib/private-lobby-flow.js";
import { PrivateLobbyPage } from "./private-lobby-page.js";

const NOW = "2026-07-18T12:00:00.000Z";
const patterns = [
  { id: "standard-one-line", name: "One Line", category: "standard" },
  { id: "shape-x", name: "X", category: "shape" },
  { id: "letter-x", name: "X", category: "letter" },
] as const;

function snapshotFor(
  role: "host" | "player" | "waiting" = "host",
  options: {
    callConfiguration?: { mode: "manual" } | { mode: "automatic"; intervalSeconds: 10 };
    eventSequence?: number | null;
    hostPresence?: "connected" | "absent";
    absentPlayerEligibility?: "playing" | "waiting";
    absentPlayerOverridden?: boolean;
    patternId?: string;
    round?: "waiting" | "active" | null;
  } = {},
): Snapshot {
  const selfId =
    role === "host"
      ? "participant-host"
      : role === "player"
        ? "participant-grace"
        : "participant-waiting";
  const hostPresence =
    options.hostPresence === "absent"
      ? {
          participantId: "participant-host",
          generation: 1,
          status: "absent" as const,
          absentSince: NOW,
          changedAt: NOW,
          overridden: false,
        }
      : {
          participantId: "participant-host",
          generation: 1,
          status: "connected" as const,
          changedAt: NOW,
        };
  const participants = [
    {
      id: "participant-host",
      username: "Casey",
      role: "host",
      roundEligibility: "playing",
      presence: hostPresence,
    },
    {
      id: "participant-grace",
      username: "Robin",
      role: "player",
      roundEligibility: "playing",
      presence: {
        participantId: "participant-grace",
        generation: 2,
        status: "grace",
        graceEndsAt: "2026-07-18T12:00:10.000Z",
        changedAt: NOW,
      },
    },
    {
      id: "participant-absent",
      username: "Drew",
      role: "player",
      roundEligibility: options.absentPlayerEligibility ?? "playing",
      presence: {
        participantId: "participant-absent",
        generation: 3,
        status: "absent",
        absentSince: NOW,
        changedAt: NOW,
        overridden: options.absentPlayerOverridden ?? false,
      },
    },
    {
      id: "participant-departed",
      username: "Alex",
      role: "player",
      roundEligibility: "waiting",
      presence: {
        participantId: "participant-departed",
        generation: 4,
        status: "departed",
        departedAt: NOW,
        changedAt: NOW,
      },
    },
    {
      id: "participant-waiting",
      username: "Morgan",
      role: "player",
      roundEligibility: "waiting",
      presence: {
        participantId: "participant-waiting",
        generation: 5,
        status: "connected",
        changedAt: NOW,
      },
    },
  ] as const;
  const self = participants.find((participant) => participant.id === selfId);
  if (self === undefined) throw new Error("Missing self fixture.");

  return SnapshotSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    generatedAt: NOW,
    lastEventSequence: options.eventSequence ?? null,
    lobby: {
      id: "lobby-1",
      code: "ABC234",
      hostParticipantId: "participant-host",
      themeId: "animals",
      ...(options.round === "active"
        ? { status: "active" as const, roundId: "round-1" }
        : { status: "waiting" as const }),
      createdAt: NOW,
    },
    session: {
      id: `session-${role}`,
      lobbyId: "lobby-1",
      participantId: selfId,
      status: "active",
      issuedAt: NOW,
    },
    self,
    participants,
    round:
      options.round === null
        ? null
        : {
            id: "round-1",
            lobbyId: "lobby-1",
            patternId: options.patternId ?? "standard-one-line",
            callConfiguration: options.callConfiguration ?? { mode: "manual" },
            ...(options.round === "active"
              ? { stage: "active" as const, startedAt: NOW }
              : { stage: "waiting" as const, createdAt: NOW }),
          },
    ownCard:
      options.round === null || role === "waiting"
        ? null
        : {
            id: `card-${role}`,
            roundId: "round-1",
            participantId: selfId,
            cells: [
              1,
              16,
              31,
              46,
              61,
              2,
              17,
              32,
              47,
              62,
              3,
              18,
              "FREE",
              48,
              63,
              4,
              19,
              34,
              49,
              64,
              5,
              20,
              35,
              50,
              65,
            ],
          },
    ownMarks: [],
    calls: [],
    timer: null,
  });
}

function activeLobbyAck(eventSequence = 2): Extract<CommandAck, { scope: "active-lobby" }> {
  const acknowledgement = CommandAckSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    type: "ack",
    scope: "active-lobby",
    commandId: "command-1",
    occurredAt: NOW,
    eventSequence,
    idempotentReplay: false,
  });
  if (acknowledgement.scope !== "active-lobby") throw new Error("Expected active-lobby ack.");
  return acknowledgement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("PrivateLobbyPage", () => {
  it("shows the authoritative setup and every participant state as text", async () => {
    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshotFor()}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    expect(await screen.findByRole("heading", { name: /lobby abc234/i })).toBeVisible();
    expect(screen.getByText("Animals")).toBeVisible();
    expect(screen.getByText("One Line", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("Manual calling")).toBeVisible();

    const roster = screen.getByRole("list", { name: /participants/i });
    expect(within(roster).getAllByRole("listitem")).toHaveLength(5);
    expect(
      within(within(roster).getByText("Casey").closest("li")!).getByText("Host"),
    ).toBeVisible();
    expect(
      within(within(roster).getByText("Casey").closest("li")!).getByText("Connected"),
    ).toBeVisible();
    expect(
      within(within(roster).getByText("Casey").closest("li")!).getByText("Playing this round"),
    ).toBeVisible();
    expect(
      within(within(roster).getByText("Robin").closest("li")!).getByText(/grace period/i),
    ).toBeVisible();
    expect(
      within(within(roster).getByText("Drew").closest("li")!).getByText("Absent"),
    ).toBeVisible();
    expect(
      within(within(roster).getByText("Alex").closest("li")!).getByText("Departed"),
    ).toBeVisible();
    expect(
      within(within(roster).getByText("Morgan").closest("li")!).getByText(
        /waiting for next round/i,
      ),
    ).toBeVisible();
    expect(
      within(within(roster).getByText("Morgan").closest("li")!).getByText("Connected"),
    ).toBeVisible();
  });

  it("copies only credential-free sharing values and provides a focused fallback", async () => {
    const copyText = vi
      .fn<(value: string) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("denied"));
    render(
      <PrivateLobbyPage
        code="ABC234"
        copyText={copyText}
        loadSnapshot={async () => snapshotFor()}
        origin="https://play.example/private?session=secret"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    await screen.findByRole("heading", { name: /lobby abc234/i });
    expect(screen.queryByRole("button", { name: "Share Invite" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy Code" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("ABC234"));
    fireEvent.click(screen.getByRole("button", { name: "Copy Invite URL" }));

    const invite = screen.getByRole("textbox", { name: /invite url to copy/i });
    await waitFor(() => expect(invite).toHaveFocus());
    expect(invite).toHaveProperty("selectionStart", 0);
    expect(invite).toHaveProperty("selectionEnd", String(invite.getAttribute("value")).length);
    expect(invite).toHaveValue("https://play.example/?code=ABC234#join-lobby");
    expect(copyText).toHaveBeenLastCalledWith("https://play.example/?code=ABC234#join-lobby");
    expect(screen.getByRole("status")).toHaveTextContent(
      /select the invite url and copy it manually/i,
    );
    expect(String(copyText.mock.calls[1]?.[0])).not.toMatch(/session|secret|participant/i);
  });

  it("offers native sharing only when available with an allowlisted payload", async () => {
    const shareInvite = vi.fn(async () => undefined);
    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshotFor()}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={shareInvite}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Share Invite" }));
    await waitFor(() =>
      expect(shareInvite).toHaveBeenCalledWith({
        title: "GameNight Bingo",
        text: "Join my private Bingo lobby ABC234.",
        url: "https://play.example/?code=ABC234#join-lobby",
      }),
    );
  });

  it("selects the invite fallback after native sharing fails and handles cancellation", async () => {
    const shareInvite = vi
      .fn<(data: { title: string; text: string; url: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("denied"))
      .mockRejectedValueOnce(new DOMException("canceled", "AbortError"));
    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshotFor()}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={shareInvite}
      />,
    );

    const share = await screen.findByRole("button", { name: "Share Invite" });
    fireEvent.click(share);
    const invite = screen.getByRole("textbox", { name: /invite url to copy/i });
    await waitFor(() => expect(invite).toHaveFocus());
    expect(invite).toHaveProperty("selectionStart", 0);
    expect(invite).toHaveProperty("selectionEnd", String(invite.getAttribute("value")).length);
    expect(screen.getByRole("status")).toHaveTextContent(/sharing failed.*copy it manually/i);

    fireEvent.click(share);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/sharing canceled/i));
  });

  it("shows setup controls only to the host", async () => {
    const { rerender } = render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshotFor("player")}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    await screen.findByRole("heading", { name: /lobby abc234/i });
    expect(screen.queryByRole("form", { name: /host lobby setup/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /start round/i })).toBeNull();

    rerender(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshotFor("host")}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    expect(await screen.findByRole("form", { name: /host lobby setup/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /start round/i })).toBeVisible();
    expect(screen.getByRole("option", { name: "X (Shape)" })).toBeVisible();
    expect(screen.getByRole("option", { name: "X (Letter)" })).toBeVisible();
  });

  it("keeps start unavailable until presence is connected and edited setup is committed", async () => {
    const commands: unknown[] = [];
    let snapshots = 0;
    const loadSnapshot = vi.fn(async () => {
      snapshots += 1;
      return snapshots === 1
        ? snapshotFor("host", {
            hostPresence: "connected",
            absentPlayerOverridden: true,
            eventSequence: 1,
          })
        : snapshotFor("host", {
            hostPresence: "connected",
            absentPlayerOverridden: true,
            callConfiguration: { mode: "automatic", intervalSeconds: 10 },
            eventSequence: 2,
          });
    });
    const createCommandSession = vi.fn((command: unknown) => {
      commands.push(command);
      return { run: vi.fn(async () => activeLobbyAck()) };
    });
    const { rerender } = render(
      <PrivateLobbyPage
        code="ABC234"
        createCommandSession={createCommandSession}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    const mode = await screen.findByRole("combobox", { name: "Call mode" });
    const start = screen.getByRole("button", { name: "Start round" });
    expect(start).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.change(mode, { target: { value: "automatic" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Call interval" }), {
      target: { value: "10" },
    });
    expect(start).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(start);
    expect(createCommandSession).not.toHaveBeenCalled();

    const save = screen.getByRole("button", { name: "Save setup" });
    save.focus();
    fireEvent.click(save);
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
    expect(commands).toEqual([
      {
        type: "configure",
        code: "ABC234",
        patternId: "standard-one-line",
        callConfiguration: { mode: "automatic", intervalSeconds: 10 },
      },
    ]);
    expect(save).toHaveFocus();
    expect(start).not.toHaveAttribute("aria-disabled", "true");

    fireEvent.click(start);
    await waitFor(() => expect(createCommandSession).toHaveBeenCalledTimes(2));
    expect(commands[1]).toEqual({ type: "start-round", code: "ABC234" });

    rerender(
      <PrivateLobbyPage
        code="ABC234"
        createCommandSession={createCommandSession}
        loadSnapshot={async () =>
          snapshotFor("host", { hostPresence: "absent", absentPlayerOverridden: true })
        }
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    expect(await screen.findByRole("button", { name: "Start round" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText(/start becomes available.*connected/i)).toBeVisible();
  });

  it("retains the last snapshot and bounds an unsuccessful refresh", async () => {
    let rejectRefresh: ((error: Error) => void) | undefined;
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(snapshotFor())
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRefresh = reject;
          }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    await screen.findByRole("heading", { name: /lobby abc234/i });
    const refresh = screen.getByRole("button", { name: "Refresh lobby" });
    refresh.focus();
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    expect(refresh).toHaveFocus();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    rejectRefresh?.(new Error("offline"));

    await waitFor(() => expect(refresh).not.toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByRole("heading", { name: /lobby abc234/i })).toBeVisible();
    expect(screen.getByText(/could not load.*try again/i)).toBeVisible();
  });

  it("synchronizes clean setup controls from an authoritative manual refresh", async () => {
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(
        snapshotFor("host", { absentPlayerOverridden: true, eventSequence: 1 }),
      )
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          callConfiguration: { mode: "automatic", intervalSeconds: 10 },
          eventSequence: 2,
          patternId: "shape-x",
        }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    await screen.findByRole("heading", { name: /lobby abc234/i });
    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));

    expect(await screen.findByText("X (Shape)", { selector: "dd" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: /winning pattern/i })).toHaveValue("shape-x");
    expect(screen.getByRole("combobox", { name: "Call mode" })).toHaveValue("automatic");
    expect(screen.getByRole("combobox", { name: "Call interval" })).toHaveValue("10");
  });

  it("describes round-less and waiting-player readiness without implying play has started", async () => {
    const { rerender } = render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshotFor("host", { round: null })}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    expect(await screen.findByText(/host is preparing the first round/i)).toBeVisible();
    expect(screen.queryByText(/round has started/i)).toBeNull();
    const roster = screen.getByRole("list", { name: /participants/i });
    expect(
      within(within(roster).getByText("Casey").closest("li")!).getByText(/ready for first round/i),
    ).toBeVisible();

    rerender(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshotFor("waiting")}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    expect(await screen.findByText(/you are queued for the next round/i)).toBeVisible();
  });

  it("blocks start for a current absent player but not waiting or overridden absences", async () => {
    const waitingAbsence = snapshotFor("host", { absentPlayerEligibility: "waiting" });
    const overriddenAbsence = snapshotFor("host", { absentPlayerOverridden: true });
    const { rerender } = render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshotFor("host")}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    expect(await screen.findByRole("button", { name: "Start round" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText(/current player.*absent/i)).toBeVisible();

    rerender(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => waitingAbsence}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start round" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );

    rerender(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => overriddenAbsence}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start round" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
  });

  it("qualifies duplicate pattern names in the authoritative setup summary", async () => {
    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshotFor("host", { patternId: "shape-x" })}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    expect(await screen.findByText("X (Shape)", { selector: "dd" })).toBeVisible();
  });

  it("queues committed start reconciliation behind a manual refresh and latches controls", async () => {
    const manualRefresh = deferred<Snapshot>();
    const reconciliation = deferred<Snapshot>();
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(
        snapshotFor("host", { absentPlayerOverridden: true, eventSequence: 1 }),
      )
      .mockReturnValueOnce(manualRefresh.promise)
      .mockReturnValueOnce(reconciliation.promise);
    const run = vi.fn(async () => activeLobbyAck(2));
    render(
      <PrivateLobbyPage
        code="ABC234"
        createCommandSession={() => ({ run })}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    await screen.findByRole("heading", { name: /lobby abc234/i });
    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));
    fireEvent.click(screen.getByRole("button", { name: "Start round" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Start round" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    manualRefresh.resolve(snapshotFor("host", { absentPlayerOverridden: true, eventSequence: 1 }));
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("Round started.")).toBeNull();
    expect(screen.getByRole("button", { name: "Start round" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    reconciliation.resolve(
      snapshotFor("host", {
        absentPlayerOverridden: true,
        eventSequence: 2,
        round: "active",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Start round" })).toBeNull());
    expect(screen.getByText(/round has started/i)).toBeVisible();
  });

  it("does not report a committed start as reconciled after refresh failure", async () => {
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(
        snapshotFor("host", { absentPlayerOverridden: true, eventSequence: 1 }),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          eventSequence: 2,
          round: "active",
        }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        createCommandSession={() => ({ run: async () => activeLobbyAck(2) })}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Start round" }));
    await screen.findByText(/committed.*could not confirm.*refresh/i);
    expect(screen.queryByText("Round started.")).toBeNull();
    expect(screen.getByRole("button", { name: "Start round" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Start round" })).toBeNull());
  });

  it("latches an acknowledged configuration until authority confirms it", async () => {
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(
        snapshotFor("host", { absentPlayerOverridden: true, eventSequence: 1 }),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          callConfiguration: { mode: "automatic", intervalSeconds: 10 },
          eventSequence: 1,
        }),
      )
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          eventSequence: 2,
        }),
      )
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          callConfiguration: { mode: "automatic", intervalSeconds: 10 },
          eventSequence: 2,
        }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        createCommandSession={() => ({ run: async () => activeLobbyAck(2) })}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    fireEvent.change(await screen.findByRole("combobox", { name: "Call mode" }), {
      target: { value: "automatic" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Call interval" }), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save setup" }));

    await screen.findByText(/committed.*could not confirm.*refresh/i);
    expect(screen.getByRole("combobox", { name: /winning pattern/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Call mode" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save setup" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Start round" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("combobox", { name: "Call mode" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(4));
    expect(screen.getByRole("combobox", { name: "Call mode" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Call mode" })).not.toBeDisabled(),
    );
    expect(screen.getByRole("combobox", { name: "Call mode" })).toHaveValue("automatic");
    expect(screen.getByRole("button", { name: "Save setup" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("removes private lobby content after a definitive refresh failure", async () => {
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(snapshotFor("host", { absentPlayerOverridden: true }))
      .mockRejectedValueOnce(
        new PrivateLobbyFlowError("Authentication is required.", {
          code: "UNAUTHORIZED",
          retryable: false,
        }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    await screen.findByRole("heading", { name: /lobby abc234/i });
    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));

    expect(await screen.findByText(/session is not active/i)).toBeVisible();
    expect(screen.queryByRole("heading", { name: /lobby abc234/i })).toBeNull();
    expect(screen.queryByRole("list", { name: /participants/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Join or rejoin" })).toBeVisible();
  });

  it("retains retryable command sessions but retires definitive failures", async () => {
    const retryableRun = vi
      .fn<() => Promise<Extract<CommandAck, { scope: "active-lobby" }>>>()
      .mockRejectedValueOnce(
        new PrivateLobbyFlowError("Too many requests. Try again later.", {
          code: "RATE_LIMITED",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(activeLobbyAck());
    const createCommandSession = vi.fn(() => ({ run: retryableRun }));
    const loadSnapshot = vi.fn(async () =>
      snapshotFor("host", { absentPlayerOverridden: true, eventSequence: 2 }),
    );
    render(
      <PrivateLobbyPage
        code="ABC234"
        createCommandSession={createCommandSession}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    const save = await screen.findByRole("button", { name: "Save setup" });
    fireEvent.click(save);
    await screen.findByText(/too many requests/i);
    fireEvent.click(save);
    await screen.findByText("Lobby setup saved.");
    expect(createCommandSession).toHaveBeenCalledOnce();
    expect(retryableRun).toHaveBeenCalledTimes(2);
  });

  it("matches recovery actions to unavailable and unauthorized snapshots", async () => {
    const unavailable = render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => {
          throw new PrivateLobbyFlowError("The requested resource was not found.", {
            code: "NOT_FOUND",
            retryable: false,
          });
        }}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    expect(await screen.findByText(/unavailable or has expired/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("link", { name: "Return home" })).toHaveAttribute("href", "/");
    unavailable.unmount();

    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => {
          throw new PrivateLobbyFlowError("Authentication is required.", {
            code: "UNAUTHORIZED",
            retryable: false,
          });
        }}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    expect(await screen.findByText(/session is not active/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Join or rejoin" })).toHaveAttribute(
      "href",
      "/?code=ABC234#join-lobby",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers retry when the strict snapshot error is retryable", async () => {
    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => {
          throw new PrivateLobbyFlowError("Too many requests. Try again later.", {
            code: "RATE_LIMITED",
            retryable: true,
          });
        }}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    expect(await screen.findByText(/too many lobby refreshes/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("marks the private route as dynamic, no-store, and excluded from indexing", () => {
    expect(revalidate).toBe(0);
    expect(metadata.robots).toBe("noindex, nofollow, noarchive");
  });
});
