import "@testing-library/jest-dom/vitest";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ActiveLobbyEventSchema,
  CommandAckSchema,
  CONTRACT_SCHEMA_VERSION,
  parseRuntimeConfig,
  ParticipantPrivateEventSchema,
  SnapshotSchema,
  type ActiveLobbyEvent,
  type CommandAck,
  type Snapshot,
} from "@gamenight-bingo/contracts";
import { patternCatalog } from "@gamenight-bingo/patterns";

import { metadata, revalidate } from "../../app/lobbies/[code]/page.js";
import { PrivateLobbyFlowError } from "../../lib/private-lobby-flow.js";
import type { PrivateLobbyRealtimeHandlers } from "../../lib/private-lobby-realtime.js";
import { PrivateLobbyPage } from "./private-lobby-page.js";

const NOW = "2026-07-18T12:00:00.000Z";
const patterns = patternCatalog.filter(({ id }) =>
  ["standard-one-line", "shape-x", "letter-x"].includes(id),
);

function snapshotFor(
  role: "host" | "player" | "waiting" = "host",
  options: {
    cardId?: string;
    calledBalls?: readonly number[];
    callConfiguration?: { mode: "manual" } | { mode: "automatic"; intervalSeconds: 10 };
    eventSequence?: number | null;
    hostPresence?: "connected" | "absent";
    absentPlayerEligibility?: "playing" | "waiting";
    absentPlayerOverridden?: boolean;
    markedBalls?: readonly number[];
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
            id: options.cardId ?? `card-${role}`,
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
    ownMarks:
      options.round === null || role === "waiting"
        ? []
        : (options.markedBalls ?? []).map((ball, index) => ({
            id: `mark-${index + 1}`,
            cardId: options.cardId ?? `card-${role}`,
            ball,
            markedAt: NOW,
          })),
    calls: (options.calledBalls ?? []).map((ball, index) => ({
      id: `call-${index + 1}`,
      roundId: "round-1",
      position: index + 1,
      ball,
      calledAt: NOW,
    })),
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

function privateAck(): Extract<CommandAck, { scope: "participant-private" }> {
  const acknowledgement = CommandAckSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    type: "ack",
    scope: "participant-private",
    commandId: "command-mark",
    occurredAt: NOW,
    eventSequence: null,
    idempotentReplay: false,
  });
  if (acknowledgement.scope !== "participant-private") {
    throw new Error("Expected participant-private ack.");
  }
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
  it("shows the current call, chronological history, canonical progress, mode, and countdown", async () => {
    const deadline = new Date(Date.now() + 5_000).toISOString();
    const active = snapshotFor("host", {
      absentPlayerOverridden: true,
      calledBalls: [1, 16, 31],
      callConfiguration: { mode: "automatic", intervalSeconds: 10 },
      eventSequence: 3,
      markedBalls: [1, 16],
      round: "active",
    });
    const snapshot = SnapshotSchema.parse({
      ...active,
      timer: { kind: "automatic-call", deadline },
    });

    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () => snapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    const liveGame = await screen.findByRole("region", { name: "Live game status" });
    expect(within(liveGame).getByText("N 31", { selector: "strong" })).toBeVisible();
    expect(within(liveGame).getByText("Automatic every 10 seconds")).toBeVisible();
    expect(within(liveGame).getByText(/next call in 5 seconds/i)).toBeVisible();
    const roundDetails = screen.getByRole("region", { name: "Round details" });
    expect(
      within(roundDetails)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["B 1", "I 16", "N 31"]);
    expect(within(roundDetails).getByText(/2 of 5 required spaces marked/i)).toBeVisible();
    expect(
      within(roundDetails).getByRole("img", { name: /one line pattern example/i }),
    ).toBeVisible();
    expect(
      within(roundDetails).getByRole("list", { name: /calls in chronological order/i }),
    ).toHaveAttribute("tabindex", "0");
    expect(
      within(liveGame).getByRole("status", { name: "New call announcement" }),
    ).toBeEmptyDOMElement();
    const sectionHeadings = screen
      .getAllByRole("heading", { level: 2 })
      .map(({ textContent }) => textContent);
    expect(sectionHeadings.indexOf("Your card")).toBeLessThan(
      sectionHeadings.indexOf("Round details"),
    );
    expect(sectionHeadings.indexOf("Round details")).toBeLessThan(
      sectionHeadings.indexOf("Share the lobby"),
    );
  });

  it("counts down to an authoritative wait without advancing calls in the browser", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const active = snapshotFor("host", {
        absentPlayerOverridden: true,
        callConfiguration: { mode: "automatic", intervalSeconds: 10 },
        round: "active",
      });
      const snapshot = SnapshotSchema.parse({
        ...active,
        timer: {
          kind: "automatic-call",
          deadline: "2026-07-18T12:00:02.000Z",
        },
      });
      render(
        <PrivateLobbyPage
          code="ABC234"
          loadSnapshot={async () => snapshot}
          origin="https://play.example"
          patterns={patterns}
          shareInvite={null}
        />,
      );
      await act(async () => Promise.resolve());
      expect(screen.getByText(/next call in 2 seconds/i)).toBeVisible();

      await act(async () => vi.advanceTimersByTimeAsync(2_100));
      expect(screen.getByText(/waiting for the server to commit the next call/i)).toBeVisible();
      expect(screen.getByText(/no balls called yet/i)).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies only contiguous live call sequences and resynchronizes once on a gap", async () => {
    let handlers:
      | {
          onConnectionState(state: string): void;
          onLobbyEvent(event: ActiveLobbyEvent): void;
          onSnapshot(snapshot: Snapshot): void;
        }
      | undefined;
    const requestResync = vi.fn();
    const connectRealtime = vi.fn((nextHandlers: NonNullable<typeof handlers>) => {
      handlers = nextHandlers;
      return { close: vi.fn(), requestResync };
    });
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={connectRealtime}
        enableRealtime
        loadSnapshot={async () =>
          snapshotFor("host", {
            absentPlayerOverridden: true,
            calledBalls: [1],
            eventSequence: 1,
            round: "active",
          })
        }
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    await screen.findByRole("region", { name: "Live game status" });
    expect(connectRealtime).toHaveBeenCalledOnce();
    const secondCall = ActiveLobbyEventSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "call",
      eventSequence: 2,
      occurredAt: NOW,
      call: { id: "call-2", roundId: "round-1", position: 2, ball: 17, calledAt: NOW },
    });
    act(() => handlers?.onLobbyEvent(secondCall));
    expect(screen.getByText("I 17", { selector: ".current-call strong" })).toBeVisible();
    expect(screen.getByRole("status", { name: "New call announcement" })).toHaveTextContent(
      "New call: I 17",
    );

    act(() => handlers?.onLobbyEvent(secondCall));
    expect(screen.getAllByText("I 17")).toHaveLength(2);
    expect(requestResync).not.toHaveBeenCalled();

    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          ...secondCall,
          eventSequence: 4,
          call: { id: "call-4", roundId: "round-1", position: 4, ball: 47, calledAt: NOW },
        }),
      ),
    );
    expect(requestResync).toHaveBeenCalledOnce();
    expect(requestResync).toHaveBeenCalledWith(2);
    expect(screen.getByText(/snapshot syncing/i, { selector: ".connection-state" })).toBeVisible();
    expect(screen.queryByText("G 47")).toBeNull();
  });

  it("resynchronizes instead of applying an exact-next event that makes the snapshot invalid", async () => {
    let handlers: PrivateLobbyRealtimeHandlers | undefined;
    const requestResync = vi.fn();
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync };
        }}
        enableRealtime
        loadSnapshot={async () =>
          snapshotFor("host", {
            absentPlayerOverridden: true,
            calledBalls: [1],
            eventSequence: 1,
            round: "active",
          })
        }
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    await screen.findByRole("region", { name: "Live game status" });

    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "call",
          eventSequence: 2,
          occurredAt: NOW,
          call: { id: "call-2", roundId: "round-1", position: 2, ball: 1, calledAt: NOW },
        }),
      ),
    );

    expect(requestResync).toHaveBeenCalledWith(1);
    expect(screen.getAllByText("B 1", { selector: ".call-history li" })).toHaveLength(1);
  });

  it("applies a same-generation grace-to-absent presence transition", async () => {
    let handlers: PrivateLobbyRealtimeHandlers | undefined;
    const requestResync = vi.fn();
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync };
        }}
        enableRealtime
        loadSnapshot={async () =>
          snapshotFor("host", { absentPlayerOverridden: true, eventSequence: 1, round: "active" })
        }
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    await screen.findByText("Grace period: reconnecting");

    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "presence",
          eventSequence: 2,
          occurredAt: NOW,
          presence: {
            participantId: "participant-grace",
            generation: 2,
            status: "absent",
            absentSince: NOW,
            changedAt: NOW,
            overridden: false,
          },
        }),
      ),
    );

    expect(screen.getByText("Absent", { selector: ".participant-states span" })).toBeVisible();
    expect(requestResync).not.toHaveBeenCalled();
  });

  it("rejects a stale realtime snapshot after applying a newer event", async () => {
    let handlers: PrivateLobbyRealtimeHandlers | undefined;
    const requestResync = vi.fn();
    const baseline = snapshotFor("host", {
      absentPlayerOverridden: true,
      calledBalls: [1],
      eventSequence: 1,
      round: "active",
    });
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync };
        }}
        enableRealtime
        loadSnapshot={async () => baseline}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    await screen.findByRole("region", { name: "Live game status" });
    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "call",
          eventSequence: 2,
          occurredAt: NOW,
          call: { id: "call-2", roundId: "round-1", position: 2, ball: 17, calledAt: NOW },
        }),
      ),
    );

    act(() => handlers?.onSnapshot(baseline));

    expect(screen.getByText("I 17", { selector: ".current-call strong" })).toBeVisible();
    expect(requestResync).toHaveBeenCalledWith(2);
  });

  it("resynchronizes the authoritative deadline after an automatic call without replaying history", async () => {
    let handlers:
      | {
          onConnectionState(state: string): void;
          onLobbyEvent(event: ActiveLobbyEvent): void;
          onSnapshot(snapshot: Snapshot): void;
        }
      | undefined;
    const requestResync = vi.fn();
    const initial = snapshotFor("host", {
      absentPlayerOverridden: true,
      calledBalls: [1],
      callConfiguration: { mode: "automatic", intervalSeconds: 10 },
      eventSequence: 1,
      round: "active",
    });
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync };
        }}
        enableRealtime
        loadSnapshot={async () => initial}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    await screen.findByRole("region", { name: "Live game status" });

    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "call",
          eventSequence: 2,
          occurredAt: NOW,
          call: { id: "call-2", roundId: "round-1", position: 2, ball: 17, calledAt: NOW },
        }),
      ),
    );
    expect(requestResync).toHaveBeenCalledOnce();
    expect(requestResync).toHaveBeenCalledWith(2);
    expect(screen.getByText(/^snapshot syncing$/i)).toBeVisible();
    expect(screen.getByRole("status", { name: "New call announcement" })).toHaveTextContent(
      "New call: I 17",
    );

    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "stage",
          eventSequence: 3,
          occurredAt: NOW,
          round: {
            ...initial.round,
            stage: "active",
          },
        }),
      ),
    );
    expect(requestResync).toHaveBeenCalledOnce();

    const restored = SnapshotSchema.parse({
      ...snapshotFor("host", {
        absentPlayerOverridden: true,
        calledBalls: [1, 17],
        callConfiguration: { mode: "automatic", intervalSeconds: 10 },
        eventSequence: 3,
        round: "active",
      }),
      timer: { kind: "automatic-call", deadline: new Date(Date.now() + 10_000).toISOString() },
    });
    act(() => handlers?.onSnapshot(restored));
    expect(screen.getByText(/next call in 10 seconds/i)).toBeVisible();
    expect(screen.getByRole("status", { name: "New call announcement" })).toHaveTextContent(
      "New call: I 17",
    );
    expect(screen.getAllByText("I 17")).toHaveLength(2);
  });

  it("resynchronizes the authoritative deadline after automatic start and resume events", async () => {
    let handlers:
      | {
          onConnectionState(state: string): void;
          onLobbyEvent(event: ActiveLobbyEvent): void;
          onSnapshot(snapshot: Snapshot): void;
        }
      | undefined;
    const requestResync = vi.fn();
    const active = snapshotFor("host", {
      absentPlayerOverridden: true,
      callConfiguration: { mode: "automatic", intervalSeconds: 10 },
      eventSequence: 1,
      round: "active",
    });
    const paused = SnapshotSchema.parse({
      ...active,
      round: {
        ...active.round,
        stage: "paused",
        pauseReason: "host-command",
        pausedAt: NOW,
      },
    });
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync };
        }}
        enableRealtime
        loadSnapshot={async () => paused}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    await screen.findByRole("region", { name: "Live game status" });

    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "stage",
          eventSequence: 2,
          occurredAt: NOW,
          round: {
            id: "round-1",
            lobbyId: "lobby-1",
            patternId: "standard-one-line",
            callConfiguration: { mode: "automatic", intervalSeconds: 10 },
            stage: "active",
            startedAt: NOW,
          },
        }),
      ),
    );
    expect(requestResync).toHaveBeenCalledOnce();
    expect(requestResync).toHaveBeenCalledWith(2);
    expect(screen.getByText(/^snapshot syncing$/i)).toBeVisible();
  });

  it("shows connection recovery and paused state without implying reconnect resumes calls", async () => {
    let handlers:
      | {
          onConnectionState(state: string): void;
          onLobbyEvent(event: ActiveLobbyEvent): void;
          onSnapshot(snapshot: Snapshot): void;
        }
      | undefined;
    const active = snapshotFor("player", {
      absentPlayerOverridden: true,
      calledBalls: [1],
      eventSequence: 1,
      round: "active",
    });
    const paused = SnapshotSchema.parse({
      ...active,
      round: {
        ...active.round,
        stage: "paused",
        pauseReason: "participant-absent",
        pausedAt: NOW,
      },
    });
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync: vi.fn() };
        }}
        enableRealtime
        loadSnapshot={async () => paused}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    expect(await screen.findByText(/grace period.*reconnecting/i)).toBeVisible();
    expect(
      screen.getByText(/paused because a player is absent/i, { selector: ".round-alert strong" }),
    ).toBeVisible();
    expect(screen.getByText(/reconnecting does not resume calling/i)).toBeVisible();
    expect(screen.getByRole("status", { name: "Game status announcement" })).toHaveTextContent(
      /snapshot syncing.*paused because a player is absent.*grace/i,
    );

    act(() => handlers?.onConnectionState("offline"));
    expect(screen.getByText(/^offline$/i)).toBeVisible();
    expect(screen.getByRole("status", { name: "Game status announcement" })).toHaveTextContent(
      /offline/i,
    );
    act(() => handlers?.onConnectionState("reconnecting"));
    expect(screen.getByText(/^reconnecting$/i)).toBeVisible();
    act(() => handlers?.onConnectionState("snapshot-syncing"));
    expect(screen.getByText(/^snapshot syncing$/i)).toBeVisible();
    act(() => handlers?.onSnapshot(paused));
    expect(screen.getByText(/^recovered$/i)).toBeVisible();

    act(() => handlers?.onConnectionState("expired"));
    expect(await screen.findByText(/session is not active/i)).toBeVisible();
    expect(screen.queryByRole("heading", { name: /lobby abc234/i })).toBeNull();
    expect(screen.queryByRole("list", { name: /participants/i })).toBeNull();
  });

  it("does not let a delayed HTTP snapshot roll back an applied live sequence", async () => {
    let handlers:
      | {
          onConnectionState(state: string): void;
          onLobbyEvent(event: ActiveLobbyEvent): void;
          onSnapshot(snapshot: Snapshot): void;
        }
      | undefined;
    const refresh = deferred<Snapshot>();
    const baseline = snapshotFor("host", {
      absentPlayerOverridden: true,
      calledBalls: [1],
      eventSequence: 1,
      round: "active",
    });
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(baseline)
      .mockReturnValueOnce(refresh.promise);
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync: vi.fn() };
        }}
        enableRealtime
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    await screen.findByRole("region", { name: "Live game status" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));
    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "call",
          eventSequence: 2,
          occurredAt: NOW,
          call: { id: "call-2", roundId: "round-1", position: 2, ball: 17, calledAt: NOW },
        }),
      ),
    );
    expect(screen.getByText("I 17", { selector: ".current-call strong" })).toBeVisible();

    refresh.resolve(baseline);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh lobby" })).toBeEnabled(),
    );
    expect(screen.getByText("I 17", { selector: ".current-call strong" })).toBeVisible();
  });

  it("reconciles a committed setup against live state when its HTTP refresh is stale", async () => {
    let handlers: PrivateLobbyRealtimeHandlers | undefined;
    const refresh = deferred<Snapshot>();
    const baseline = snapshotFor("host", {
      absentPlayerOverridden: true,
      eventSequence: 1,
    });
    const configured = snapshotFor("host", {
      absentPlayerOverridden: true,
      callConfiguration: { mode: "automatic", intervalSeconds: 10 },
      eventSequence: 2,
    });
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(baseline)
      .mockReturnValueOnce(refresh.promise);
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync: vi.fn() };
        }}
        createCommandSession={() => ({ run: async () => activeLobbyAck(2) })}
        enableRealtime
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
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));

    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "stage",
          eventSequence: 2,
          occurredAt: NOW,
          round: configured.round,
        }),
      ),
    );
    refresh.resolve(baseline);

    await screen.findByText("Lobby setup saved.");
    expect(screen.getByRole("combobox", { name: "Call mode" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Call mode" })).toHaveValue("automatic");
  });

  it("keeps a private mark when an equal-sequence snapshot arrives afterward", async () => {
    let handlers: PrivateLobbyRealtimeHandlers | undefined;
    const baseline = snapshotFor("player", {
      absentPlayerOverridden: true,
      calledBalls: [1],
      eventSequence: 1,
      round: "active",
    });
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync: vi.fn() };
        }}
        enableRealtime
        loadSnapshot={async () => baseline}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    await screen.findByRole("button", { name: /b.*1.*called - mark.*available to mark/i });
    const cardId = baseline.ownCard!.id;

    act(() =>
      handlers?.onPrivateEvent?.(
        ParticipantPrivateEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "mark-result",
          commandId: "command-private",
          occurredAt: NOW,
          mark: { id: "mark-live", cardId, ball: 1, markedAt: NOW },
        }),
      ),
    );
    expect(screen.getByRole("button", { name: /b.*1.*marked/i })).toBeVisible();

    act(() => handlers?.onSnapshot(baseline));
    expect(screen.getByRole("button", { name: /b.*1.*marked/i })).toBeVisible();
  });

  it("keeps the newest chronological calls visible while the reader remains at the end", async () => {
    let handlers:
      | {
          onConnectionState(state: string): void;
          onLobbyEvent(event: ActiveLobbyEvent): void;
          onSnapshot(snapshot: Snapshot): void;
        }
      | undefined;
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync: vi.fn() };
        }}
        enableRealtime
        loadSnapshot={async () =>
          snapshotFor("host", {
            absentPlayerOverridden: true,
            calledBalls: [1],
            eventSequence: 1,
            round: "active",
          })
        }
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    const history = await screen.findByRole("list", { name: /calls in chronological order/i });
    Object.defineProperties(history, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 400, writable: true },
    });
    fireEvent.scroll(history);

    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "call",
          eventSequence: 2,
          occurredAt: NOW,
          call: { id: "call-2", roundId: "round-1", position: 2, ball: 17, calledAt: NOW },
        }),
      ),
    );
    expect(history.scrollTop).toBe(500);
  });

  it("resets history following and call announcements when the round changes", async () => {
    let handlers: PrivateLobbyRealtimeHandlers | undefined;
    const baseline = snapshotFor("host", {
      absentPlayerOverridden: true,
      calledBalls: [17],
      eventSequence: 2,
      round: "active",
    });
    render(
      <PrivateLobbyPage
        code="ABC234"
        connectRealtime={(nextHandlers) => {
          handlers = nextHandlers;
          return { close: vi.fn(), requestResync: vi.fn() };
        }}
        enableRealtime
        loadSnapshot={async () => baseline}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    const history = await screen.findByRole("list", { name: /calls in chronological order/i });
    Object.defineProperties(history, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    fireEvent.scroll(history);
    act(() =>
      handlers?.onLobbyEvent(
        ActiveLobbyEventSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type: "call",
          eventSequence: 3,
          occurredAt: NOW,
          call: { id: "call-2", roundId: "round-1", position: 2, ball: 18, calledAt: NOW },
        }),
      ),
    );
    expect(screen.getByRole("status", { name: "New call announcement" })).toHaveTextContent(
      "New call: I 18",
    );

    const nextRound = SnapshotSchema.parse({
      ...snapshotFor("host", {
        absentPlayerOverridden: true,
        calledBalls: [1, 16],
        eventSequence: 4,
        round: "active",
      }),
      lobby: { ...baseline.lobby, roundId: "round-2" },
      round: { ...baseline.round, id: "round-2" },
      ownCard: { ...baseline.ownCard, id: "card-2", roundId: "round-2" },
      ownMarks: [],
      calls: [
        { id: "round-2-call-1", roundId: "round-2", position: 1, ball: 1, calledAt: NOW },
        { id: "round-2-call-2", roundId: "round-2", position: 2, ball: 16, calledAt: NOW },
      ],
    });
    act(() => handlers?.onSnapshot(nextRound));

    expect(history.scrollTop).toBe(500);
    expect(screen.getByRole("status", { name: "New call announcement" })).toBeEmptyDOMElement();
  });

  it("visibly distinguishes a flexible pattern example from closest-variation progress", async () => {
    render(
      <PrivateLobbyPage
        code="ABC234"
        loadSnapshot={async () =>
          snapshotFor("host", {
            absentPlayerOverridden: true,
            calledBalls: [1],
            markedBalls: [1],
            round: "active",
          })
        }
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    expect(await screen.findByText(/one possible pattern example/i)).toBeVisible();
    expect(
      screen.getByText(/closest eligible variation: 1 of 4 required spaces marked/i),
    ).toBeVisible();
  });

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
    expect(screen.getByText("Manual calling", { selector: "dd" })).toBeVisible();

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

  it("renders and keyboard-navigates all card cells with explicit non-color states", async () => {
    const createMarkCommandSession = vi.fn(() => ({ run: vi.fn(async () => privateAck()) }));
    render(
      <PrivateLobbyPage
        code="ABC234"
        createMarkCommandSession={createMarkCommandSession}
        loadSnapshot={async () =>
          snapshotFor("host", {
            absentPlayerOverridden: true,
            calledBalls: [1, 17, 31],
            markedBalls: [17],
            round: "active",
          })
        }
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    const card = await screen.findByRole("table", { name: "Your Bingo card" });
    expect(
      within(card)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["B", "I", "N", "G", "O"]);
    expect(within(card).getAllByRole("button")).toHaveLength(25);
    const called = within(card).getByRole("button", {
      name: /b.*1.*called - mark.*available to mark/i,
    });
    expect(called).toHaveTextContent(/called/i);
    expect(within(card).getByRole("button", { name: /i.*17.*marked/i })).toHaveTextContent(
      /marked/i,
    );
    expect(
      within(card).getByRole("button", {
        name: /n.*free.*automatically satisfied/i,
      }),
    ).toHaveTextContent(/free/i);
    const uncalled = within(card).getByRole("button", {
      name: /g.*46.*not called.*cannot be marked yet/i,
    });
    expect(uncalled).toHaveTextContent(/not called/i);
    expect(uncalled).toHaveAttribute("aria-disabled", "true");

    called.focus();
    fireEvent.keyDown(called, { key: "ArrowRight" });
    expect(within(card).getByRole("button", { name: /i.*16.*not called/i })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(within(card).getByRole("button", { name: /i.*17.*marked/i })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(within(card).getByRole("button", { name: /o.*62.*not called/i })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { ctrlKey: true, key: "Home" });
    expect(called).toHaveFocus();
    expect(
      within(card)
        .getAllByRole("button")
        .filter((cell) => cell.getAttribute("tabindex") === "0"),
    ).toEqual([called]);

    fireEvent.click(uncalled);
    expect(createMarkCommandSession).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Card marking status" })).toHaveTextContent(
      /g 46 has not been called and was not marked/i,
    );
  });

  it("submits a called daub once and waits for an authoritative marked snapshot", async () => {
    const mark = deferred<CommandAck>();
    const createMarkCommandSession = vi.fn(() => ({ run: () => mark.promise }));
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1],
          eventSequence: 4,
          round: "active",
        }),
      )
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1],
          eventSequence: 4,
          markedBalls: [1],
          round: "active",
        }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        createMarkCommandSession={createMarkCommandSession}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    const cell = await screen.findByRole("button", {
      name: /b.*1.*called - mark.*available to mark/i,
    });
    cell.focus();
    fireEvent.click(cell);
    fireEvent.click(cell);
    expect(createMarkCommandSession).toHaveBeenCalledOnce();
    expect(createMarkCommandSession).toHaveBeenCalledWith({ ball: 1, code: "ABC234" });
    expect(screen.getByRole("status", { name: "Card marking status" })).toHaveTextContent(
      /marking b 1/i,
    );
    expect(cell).toHaveAttribute("aria-disabled", "true");

    mark.resolve(privateAck());
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /b.*1.*marked/i })).toHaveFocus();
    expect(screen.getByRole("status", { name: "Card marking status" })).toHaveTextContent(
      /b 1 marked/i,
    );
  });

  it("keeps a winning mark latched until its lobby sequence is visible", async () => {
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1],
          eventSequence: 4,
          round: "active",
        }),
      )
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1],
          eventSequence: 4,
          markedBalls: [1],
          round: "active",
        }),
      )
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1],
          eventSequence: 5,
          markedBalls: [1],
          round: "active",
        }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        createMarkCommandSession={() => ({ run: async () => activeLobbyAck(5) })}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /b.*1.*called - mark.*available to mark/i,
      }),
    );
    await screen.findByText(/mark committed.*could not confirm/i);
    expect(screen.getByRole("button", { name: /i.*16.*unavailable.*pending/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("status", { name: "Card marking status" })).toHaveTextContent(
      /b 1 marked/i,
    );
    expect(screen.getByRole("button", { name: /i.*16.*not called.*cannot/i })).toBeVisible();
  });

  it("retains an ambiguous mark for explicit same-card replay and blocks competing daubs", async () => {
    const run = vi
      .fn<() => Promise<CommandAck>>()
      .mockRejectedValueOnce(
        new PrivateLobbyFlowError(
          "We could not confirm the server response. Retry to safely check the same command.",
          { ambiguous: true },
        ),
      )
      .mockResolvedValueOnce(privateAck());
    const createMarkCommandSession = vi.fn(() => ({ run }));
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1, 31],
          round: "active",
        }),
      )
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1, 31],
          markedBalls: [1],
          round: "active",
        }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        createMarkCommandSession={createMarkCommandSession}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /b.*1.*called - mark.*available to mark/i,
      }),
    );
    expect(await screen.findByRole("button", { name: /retry b 1 mark/i })).toBeVisible();
    const competing = screen.getByRole("button", {
      name: /n.*31.*unavailable.*b 1 mark needs confirmation/i,
    });
    fireEvent.click(competing);
    expect(createMarkCommandSession).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: /retry b 1 mark/i }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(createMarkCommandSession).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: /b.*1.*marked/i })).toBeVisible();
  });

  it("retires an ambiguous mark session when authority replaces the card", async () => {
    const unresolvedRun = vi.fn(async () => {
      throw new PrivateLobbyFlowError(
        "We could not confirm the server response. Retry to safely check the same command.",
        { ambiguous: true },
      );
    });
    const replacementRun = vi.fn<() => Promise<CommandAck>>(
      () => new Promise<CommandAck>(() => undefined),
    );
    const createMarkCommandSession = vi
      .fn()
      .mockReturnValueOnce({ run: unresolvedRun })
      .mockReturnValueOnce({ run: replacementRun });
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1],
          round: "active",
        }),
      )
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1],
          cardId: "replacement-card",
          round: "active",
        }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        createMarkCommandSession={createMarkCommandSession}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /b.*1.*called - mark.*available to mark/i,
      }),
    );
    await screen.findByRole("button", { name: /retry b 1 mark/i });
    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /retry b 1 mark/i })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /b.*1.*called - mark.*available to mark/i }),
    );
    expect(createMarkCommandSession).toHaveBeenCalledTimes(2);
    expect(replacementRun).toHaveBeenCalledOnce();
  });

  it("ignores a late rejection after authority replaces the card", async () => {
    const originalMark = deferred<CommandAck>();
    const replacementRun = vi.fn<() => Promise<CommandAck>>(
      () => new Promise<CommandAck>(() => undefined),
    );
    const createMarkCommandSession = vi
      .fn()
      .mockReturnValueOnce({ run: () => originalMark.promise })
      .mockReturnValueOnce({ run: replacementRun });
    const loadSnapshot = vi
      .fn<(code: string) => Promise<Snapshot>>()
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1],
          round: "active",
        }),
      )
      .mockResolvedValueOnce(
        snapshotFor("host", {
          absentPlayerOverridden: true,
          calledBalls: [1],
          cardId: "replacement-card",
          round: "active",
        }),
      );
    render(
      <PrivateLobbyPage
        code="ABC234"
        createMarkCommandSession={createMarkCommandSession}
        loadSnapshot={loadSnapshot}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /b.*1.*called - mark.*available to mark/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh lobby" }));
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));

    await act(async () => {
      originalMark.reject(
        new PrivateLobbyFlowError(
          "We could not confirm the server response. Retry to safely check the same command.",
          { ambiguous: true },
        ),
      );
      await originalMark.promise.catch(() => undefined);
    });

    fireEvent.click(
      screen.getByRole("button", { name: /b.*1.*called - mark.*available to mark/i }),
    );
    expect(createMarkCommandSession).toHaveBeenCalledTimes(2);
    expect(replacementRun).toHaveBeenCalledOnce();
  });

  it("keeps a created card discoverable but unavailable before the round starts", async () => {
    const createMarkCommandSession = vi.fn(() => ({ run: vi.fn(async () => privateAck()) }));
    const { rerender } = render(
      <PrivateLobbyPage
        code="ABC234"
        createMarkCommandSession={createMarkCommandSession}
        loadSnapshot={async () => snapshotFor("host", { absentPlayerOverridden: true })}
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );

    const cell = await screen.findByRole("button", {
      name: /b.*1.*unavailable.*round has not started/i,
    });
    expect(cell).toHaveTextContent("Locked");
    fireEvent.click(cell);
    expect(createMarkCommandSession).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Card marking status" })).toHaveTextContent(
      /round has not started/i,
    );

    rerender(
      <PrivateLobbyPage
        code="ABC234"
        createMarkCommandSession={createMarkCommandSession}
        loadSnapshot={async () =>
          snapshotFor("host", {
            absentPlayerOverridden: true,
            calledBalls: [1],
            round: "active",
          })
        }
        origin="https://play.example"
        patterns={patterns}
        shareInvite={null}
      />,
    );
    expect(
      await screen.findByRole("button", {
        name: /b.*1.*called - mark.*available to mark/i,
      }),
    ).toBeVisible();
    expect(screen.getByRole("status", { name: "Card marking status" })).toBeEmptyDOMElement();
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
    expect(screen.getByRole("status", { name: "Sharing status" })).toHaveTextContent(
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
    expect(screen.getByRole("status", { name: "Sharing status" })).toHaveTextContent(
      /sharing failed.*copy it manually/i,
    );

    fireEvent.click(share);
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Sharing status" })).toHaveTextContent(
        /sharing canceled/i,
      ),
    );
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
          snapshotFor("host", {
            hostPresence: "absent",
            absentPlayerOverridden: true,
            eventSequence: 2,
          })
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

  it("accepts only an HTTP(S) origin for the public game server URL", () => {
    const parsePublicGameServerUrl = (value: string | undefined) =>
      parseRuntimeConfig({ NEXT_PUBLIC_GAME_SERVER_URL: value }).publicGameServerUrl;
    expect(parsePublicGameServerUrl(undefined)).toBeUndefined();
    expect(parsePublicGameServerUrl("https://game.example")).toBe("https://game.example");
    for (const invalid of [
      "ws://game.example",
      "https://user:secret@game.example",
      "https://game.example/socket.io",
      "https://game.example?ticket=secret",
      "http://[abcd]:3001",
      "http://[:::]:3001",
      "http://999.999.999.999",
      "not-a-url",
    ]) {
      expect(() => parsePublicGameServerUrl(invalid)).toThrow(
        "NEXT_PUBLIC_GAME_SERVER_URL must be one HTTP or HTTPS origin without credentials, path, query, or fragment.",
      );
    }
  });
});
