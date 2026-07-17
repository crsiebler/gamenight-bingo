import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  ActiveLobbyEventSchema,
  ActiveLobbyEventSequenceSchema,
  CallConfigurationSchema,
  CallSchema,
  CardSchema,
  CoWinnerResultSchema,
  CoWinnerWindowSchema,
  CommandAckSchema,
  CommandIdSchema,
  ErrorSchema,
  IsoTimestampSchema,
  LobbyIdSchema,
  LobbyStateSchema,
  MarkSchema,
  MutationCommandSchema,
  ParticipantPrivateEventSchema,
  ParticipantSessionSchema,
  ParticipantSummarySchema,
  PresenceSchema,
  RealtimeCommandSchema,
  RoundIdSchema,
  RoundStateSchema,
  SnapshotSchema,
  TimerSchema,
} from "../packages/contracts/src/index.js";

const NOW = "2026-07-16T12:00:00.000Z";
const LATER = "2026-07-16T12:00:02.000Z";

const cardCells = [
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
] as const;

const connectedPresence = {
  participantId: "participant_host",
  generation: 1,
  status: "connected",
  changedAt: NOW,
} as const;

const participant = {
  id: "participant_host",
  username: "Host",
  role: "host",
  roundEligibility: "playing",
  presence: connectedPresence,
} as const;

const player = {
  id: "participant_player",
  username: "Player",
  role: "player",
  roundEligibility: "playing",
  presence: {
    participantId: "participant_player",
    generation: 2,
    status: "connected",
    changedAt: NOW,
  },
} as const;

const session = {
  id: "session_host",
  lobbyId: "lobby_alpha",
  participantId: "participant_host",
  status: "active",
  issuedAt: NOW,
} as const;

const card = {
  id: "card_host",
  roundId: "round_one",
  participantId: "participant_host",
  cells: cardCells,
} as const;

const call = {
  id: "call_one",
  roundId: "round_one",
  position: 1,
  ball: 1,
  calledAt: NOW,
} as const;

const mark = {
  id: "mark_one",
  cardId: "card_host",
  ball: 1,
  markedAt: NOW,
} as const;

const activeLobby = {
  id: "lobby_alpha",
  code: "ABC234",
  hostParticipantId: "participant_host",
  themeId: "theme_classic",
  status: "active",
  createdAt: NOW,
  roundId: "round_one",
} as const;

const activeRound = {
  id: "round_one",
  lobbyId: "lobby_alpha",
  patternId: "pattern_one_line",
  callConfiguration: { mode: "manual" },
  stage: "active",
  startedAt: NOW,
} as const;

const waitingRound = {
  id: "round_one",
  lobbyId: "lobby_alpha",
  patternId: "pattern_one_line",
  callConfiguration: { mode: "manual" },
  stage: "waiting",
  createdAt: NOW,
} as const;

const endedRound = {
  ...activeRound,
  stage: "ended",
  endedAt: LATER,
  result: null,
} as const;

const snapshot = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  generatedAt: NOW,
  lastEventSequence: 4,
  lobby: activeLobby,
  session,
  self: participant,
  participants: [participant],
  round: activeRound,
  ownCard: card,
  ownMarks: [mark],
  calls: [call],
  timer: null,
} as const;

describe("v1 contract primitives", () => {
  it("brands identifier outputs independently", () => {
    const lobbyId = LobbyIdSchema.parse("lobby_alpha");
    const roundId = RoundIdSchema.parse("round_one");

    expectTypeOf(lobbyId).not.toEqualTypeOf(roundId);
    expect(LobbyIdSchema.safeParse("").success).toBe(false);
    expect(CommandIdSchema.safeParse("contains spaces").success).toBe(false);
  });

  it.each([5, 10, 30, 60, 120])("accepts automatic interval %i", (intervalSeconds) => {
    expect(CallConfigurationSchema.parse({ mode: "automatic", intervalSeconds })).toEqual({
      mode: "automatic",
      intervalSeconds,
    });
  });

  it.each([
    { mode: "manual", intervalSeconds: 5 },
    { mode: "automatic" },
    { mode: "automatic", intervalSeconds: 15 },
    { mode: "automatic", intervalSeconds: "10" },
    { mode: "automatic", intervalSeconds: 10, extra: true },
  ])("rejects malformed call configuration %#", (configuration) => {
    expect(CallConfigurationSchema.safeParse(configuration).success).toBe(false);
  });

  it("accepts UTC timestamps and positive safe event sequences only", () => {
    expect(IsoTimestampSchema.safeParse(NOW).success).toBe(true);
    expect(IsoTimestampSchema.safeParse("2026-07-16T12:00:00").success).toBe(false);
    expect(IsoTimestampSchema.safeParse(new Date(NOW)).success).toBe(false);

    for (const sequence of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(ActiveLobbyEventSequenceSchema.safeParse(sequence).success).toBe(false);
    }
    expect(ActiveLobbyEventSequenceSchema.safeParse(1).success).toBe(true);
  });

  it("bounds call positions to one 75-ball round", () => {
    expect(CallSchema.safeParse({ ...call, position: 1 }).success).toBe(true);
    expect(CallSchema.safeParse({ ...call, position: 75 }).success).toBe(true);
    expect(CallSchema.safeParse({ ...call, position: 0 }).success).toBe(false);
    expect(CallSchema.safeParse({ ...call, position: 1.5 }).success).toBe(false);
    expect(CallSchema.safeParse({ ...call, position: 76 }).success).toBe(false);
  });
});

describe("v1 game state contracts", () => {
  it("parses lobby, round, session, participant, presence, card, mark, and call state", () => {
    expect(LobbyStateSchema.parse(activeLobby)).toEqual(activeLobby);
    expect(RoundStateSchema.parse(activeRound)).toEqual(activeRound);
    expect(ParticipantSessionSchema.parse(session)).toEqual(session);
    expect(ParticipantSummarySchema.parse(participant)).toEqual(participant);
    expect(PresenceSchema.parse(connectedPresence)).toEqual(connectedPresence);
    expect(CardSchema.parse(card)).toEqual(card);
    expect(MarkSchema.parse(mark)).toEqual(mark);
    expect(CallSchema.parse(call)).toEqual(call);
  });

  it("binds presence to its participant summary", () => {
    expect(
      ParticipantSummarySchema.safeParse({
        ...participant,
        presence: { ...connectedPresence, participantId: "participant_other" },
      }).success,
    ).toBe(false);
  });

  it("represents a created round before it starts", () => {
    expect(RoundStateSchema.parse(waitingRound)).toEqual(waitingRound);
  });

  it("rejects malformed cards", () => {
    expect(CardSchema.safeParse({ ...card, cells: cardCells.slice(0, 24) }).success).toBe(false);
    expect(
      CardSchema.safeParse({
        ...card,
        cells: cardCells.map((value, index) => (index === 12 ? 33 : value)),
      }).success,
    ).toBe(false);
    expect(
      CardSchema.safeParse({
        ...card,
        cells: cardCells.map((value, index) => (index === 0 ? 16 : value)),
      }).success,
    ).toBe(false);
    expect(
      CardSchema.safeParse({
        ...card,
        cells: cardCells.map((value, index) => (index === 5 ? 1 : value)),
      }).success,
    ).toBe(false);
  });

  it("rejects unknown nested state fields", () => {
    expect(
      ParticipantSummarySchema.safeParse({
        ...participant,
        presence: { ...connectedPresence, connectionCount: 2 },
      }).success,
    ).toBe(false);
    expect(CardSchema.safeParse({ ...card, drawPosition: 1 }).success).toBe(false);
    expect(CallSchema.safeParse({ ...call, nextBall: 2 }).success).toBe(false);
  });

  it("models automatic, grace, and co-winner timers as server deadlines", () => {
    expect(TimerSchema.safeParse({ kind: "automatic-call", deadline: LATER }).success).toBe(true);
    expect(
      TimerSchema.safeParse({
        kind: "disconnect-grace",
        participantId: "participant_player",
        generation: 2,
        deadline: LATER,
      }).success,
    ).toBe(true);
    expect(
      TimerSchema.safeParse({
        kind: "co-winner",
        triggeringCallId: "call_one",
        deadline: LATER,
      }).success,
    ).toBe(true);
    expect(TimerSchema.safeParse({ kind: "automatic-call", remainingSeconds: 5 }).success).toBe(
      false,
    );
  });

  it("requires a nonempty unique co-winner set", () => {
    const window = {
      triggeringCallId: "call_one",
      openedAt: NOW,
      closesAt: LATER,
    } as const;
    const result = {
      ...window,
      settledAt: LATER,
      winnerParticipantIds: ["participant_host", "participant_player"],
    } as const;

    expect(CoWinnerWindowSchema.parse(window)).toEqual(window);
    expect(CoWinnerResultSchema.parse(result)).toEqual(result);
    expect(CoWinnerResultSchema.safeParse({ ...result, winnerParticipantIds: [] }).success).toBe(
      false,
    );
    expect(
      CoWinnerResultSchema.safeParse({
        ...result,
        winnerParticipantIds: ["participant_host", "participant_host"],
      }).success,
    ).toBe(false);
    expect(
      CoWinnerWindowSchema.safeParse({
        ...window,
        openedAt: "2026-07-16T12:00:00.1001Z",
        closesAt: "2026-07-16T12:00:00.1Z",
      }).success,
    ).toBe(false);
    expect(
      CoWinnerResultSchema.safeParse({
        ...result,
        openedAt: LATER,
        closesAt: NOW,
      }).success,
    ).toBe(false);
    expect(
      CoWinnerResultSchema.safeParse({
        ...result,
        closesAt: LATER,
        settledAt: NOW,
      }).success,
    ).toBe(false);
  });
});

describe("v1 snapshot privacy", () => {
  it("parses a complete authorized snapshot", () => {
    expect(SnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each([
    ["future draw order", { ...snapshot, drawOrder: [1, 2, 3] }],
    ["active event history", { ...snapshot, events: [] }],
    ["prior-round results", { ...snapshot, resultHistory: [] }],
    ["session token", { ...snapshot, session: { ...session, token: "secret" } }],
    [
      "another participant card",
      {
        ...snapshot,
        participants: [{ ...participant, card }],
      },
    ],
    [
      "another participant marks",
      {
        ...snapshot,
        participants: [{ ...participant, marks: [mark] }],
      },
    ],
  ])("rejects %s", (_, payload) => {
    expect(SnapshotSchema.safeParse(payload).success).toBe(false);
  });

  it("requires the designated host to be the only host", () => {
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        participants: [participant, { ...player, role: "host" }],
      }).success,
    ).toBe(false);
  });

  it("requires disconnect timers to match the participant grace state", () => {
    const graceEndsAt = LATER;
    const gracePlayer = {
      ...player,
      presence: {
        ...player.presence,
        status: "grace",
        graceEndsAt,
      },
    } as const;
    const timer = {
      kind: "disconnect-grace",
      participantId: gracePlayer.id,
      generation: gracePlayer.presence.generation,
      deadline: graceEndsAt,
    } as const;

    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        participants: [participant, gracePlayer],
        timer,
      }).success,
    ).toBe(true);
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        participants: [participant, player],
        timer,
      }).success,
    ).toBe(false);
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        participants: [participant, gracePlayer],
        timer: { ...timer, generation: 3 },
      }).success,
    ).toBe(false);
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        participants: [participant, gracePlayer],
        timer: { ...timer, deadline: "2026-07-16T12:00:03.000Z" },
      }).success,
    ).toBe(false);
  });

  it("requires winners to be eligible for the current round", () => {
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        participants: [participant, { ...player, roundEligibility: "waiting" }],
        round: {
          ...activeRound,
          stage: "result",
          result: {
            triggeringCallId: "call_one",
            openedAt: NOW,
            closesAt: LATER,
            settledAt: LATER,
            winnerParticipantIds: [player.id],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects expired lobby snapshots that retain private state", () => {
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        lobby: {
          id: activeLobby.id,
          code: activeLobby.code,
          hostParticipantId: activeLobby.hostParticipantId,
          themeId: activeLobby.themeId,
          status: "expired",
          createdAt: activeLobby.createdAt,
          expiredAt: LATER,
        },
      }).success,
    ).toBe(false);
  });

  it("requires timers to agree with the current round", () => {
    const window = {
      triggeringCallId: call.id,
      openedAt: NOW,
      closesAt: LATER,
    } as const;
    const coWinnerRound = {
      ...activeRound,
      stage: "co-winner-window",
      window,
    } as const;
    const coWinnerTimer = {
      kind: "co-winner",
      triggeringCallId: call.id,
      deadline: LATER,
    } as const;

    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        timer: { kind: "automatic-call", deadline: LATER },
      }).success,
    ).toBe(false);
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        round: {
          ...activeRound,
          callConfiguration: { mode: "automatic", intervalSeconds: 5 },
          stage: "paused",
          pauseReason: "host-command",
          pausedAt: NOW,
        },
        timer: { kind: "automatic-call", deadline: LATER },
      }).success,
    ).toBe(false);
    expect(
      SnapshotSchema.safeParse({ ...snapshot, round: coWinnerRound, timer: coWinnerTimer }).success,
    ).toBe(true);
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        round: coWinnerRound,
        timer: { ...coWinnerTimer, triggeringCallId: "call_other" },
      }).success,
    ).toBe(false);
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        round: coWinnerRound,
        timer: { ...coWinnerTimer, deadline: "2026-07-16T12:00:03.000Z" },
      }).success,
    ).toBe(false);
  });

  it("binds own-card presence to current-round eligibility", () => {
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        self: { ...participant, roundEligibility: "waiting" },
        participants: [{ ...participant, roundEligibility: "waiting" }],
      }).success,
    ).toBe(false);
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        ownCard: null,
        ownMarks: [],
      }).success,
    ).toBe(false);
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        self: { ...participant, roundEligibility: "waiting" },
        participants: [{ ...participant, roundEligibility: "waiting" }],
        ownCard: null,
        ownMarks: [],
      }).success,
    ).toBe(true);
  });

  it.each([
    ["duplicate call IDs", [call, { ...call, position: 2, ball: 2, calledAt: LATER }]],
    ["duplicate called balls", [call, { ...call, id: "call_two", position: 2, calledAt: LATER }]],
    ["noncontiguous call positions", [{ ...call, position: 2 }]],
  ])("rejects %s", (_, calls) => {
    expect(SnapshotSchema.safeParse({ ...snapshot, calls }).success).toBe(false);
  });

  it.each([
    ["duplicate marks", [mark, { ...mark, markedAt: LATER }], [call]],
    ["a mark absent from the card", [{ ...mark, ball: 6 }], [{ ...call, ball: 6 }]],
    ["an uncalled mark", [{ ...mark, ball: 2 }], [call]],
  ])("rejects %s", (_, ownMarks, calls) => {
    expect(SnapshotSchema.safeParse({ ...snapshot, ownMarks, calls }).success).toBe(false);
  });

  it("requires co-winner state to reference the latest call", () => {
    const latestCall = {
      ...call,
      id: "call_two",
      position: 2,
      ball: 2,
      calledAt: LATER,
    } as const;
    const resultRound = {
      ...activeRound,
      stage: "result",
      result: {
        triggeringCallId: call.id,
        openedAt: NOW,
        closesAt: LATER,
        settledAt: LATER,
        winnerParticipantIds: [participant.id],
      },
    } as const;

    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        round: resultRound,
        calls: [call, latestCall],
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "a session for another participant",
      { ...snapshot, session: { ...session, participantId: "participant_other" } },
    ],
    [
      "a session for another lobby",
      { ...snapshot, session: { ...session, lobbyId: "lobby_other" } },
    ],
    [
      "a foreign own card",
      { ...snapshot, ownCard: { ...card, participantId: "participant_other" } },
    ],
    ["a prior-round own card", { ...snapshot, ownCard: { ...card, roundId: "round_old" } }],
    ["a mark for another card", { ...snapshot, ownMarks: [{ ...mark, cardId: "card_other" }] }],
    ["a prior-round call", { ...snapshot, calls: [{ ...call, roundId: "round_old" }] }],
    [
      "a round for another lobby",
      { ...snapshot, round: { ...activeRound, lobbyId: "lobby_other" } },
    ],
    [
      "a round other than the active lobby round",
      {
        ...snapshot,
        round: { ...activeRound, id: "round_other" },
        ownCard: { ...card, roundId: "round_other" },
        calls: [{ ...call, roundId: "round_other" }],
      },
    ],
    [
      "an active lobby without its round",
      { ...snapshot, round: null, ownCard: null, ownMarks: [], calls: [] },
    ],
    [
      "a self projection that differs from its roster entry",
      { ...snapshot, self: { ...participant, role: "player" } },
    ],
    [
      "a host outside the participant roster",
      { ...snapshot, lobby: { ...activeLobby, hostParticipantId: "participant_other" } },
    ],
    [
      "a disconnect timer for someone outside the participant roster",
      {
        ...snapshot,
        timer: {
          kind: "disconnect-grace",
          participantId: "participant_other",
          generation: 1,
          deadline: LATER,
        },
      },
    ],
    [
      "a winner outside the participant roster",
      {
        ...snapshot,
        round: {
          ...activeRound,
          stage: "result",
          result: {
            triggeringCallId: "call_one",
            openedAt: NOW,
            closesAt: LATER,
            settledAt: LATER,
            winnerParticipantIds: ["participant_other"],
          },
        },
      },
    ],
  ])("rejects %s", (_, payload) => {
    expect(SnapshotSchema.safeParse(payload).success).toBe(false);
  });

  it("bounds snapshot and winner collections", () => {
    const participants = [
      participant,
      ...Array.from({ length: 24 }, (_, index) => ({
        ...player,
        id: `participant_${index}`,
        presence: { ...player.presence, participantId: `participant_${index}` },
      })),
    ];
    const marks = Array.from({ length: 25 }, (_, index) => ({
      ...mark,
      id: `mark_${index}`,
      ball: index + 1,
    }));
    const calls = Array.from({ length: 76 }, (_, index) => ({
      ...call,
      id: `call_${index}`,
      position: Math.min(index + 1, 75),
      ball: (index % 75) + 1,
    }));
    const winners = Array.from({ length: 26 }, (_, index) => `participant_${index}`);

    expect(SnapshotSchema.safeParse({ ...snapshot, participants }).success).toBe(true);
    expect(
      SnapshotSchema.safeParse({
        ...snapshot,
        participants: [
          ...participants,
          {
            ...player,
            id: "participant_25",
            presence: { ...player.presence, participantId: "participant_25" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(SnapshotSchema.safeParse({ ...snapshot, ownMarks: marks }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...snapshot, calls }).success).toBe(false);
    expect(
      CoWinnerResultSchema.safeParse({
        triggeringCallId: "call_one",
        openedAt: NOW,
        closesAt: LATER,
        settledAt: LATER,
        winnerParticipantIds: winners,
      }).success,
    ).toBe(false);
  });
});

describe("v1 command contracts", () => {
  const mutationCommands = [
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "configure",
      commandId: "command_configure",
      patternId: "pattern_one_line",
      callConfiguration: { mode: "manual" },
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "create-round",
      commandId: "command_create",
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "start-round",
      commandId: "command_start",
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "pause-round",
      commandId: "command_pause",
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resume-round",
      commandId: "command_resume",
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "call-next",
      commandId: "command_call",
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "continue-round",
      commandId: "command_continue",
      patternId: "pattern_two_lines",
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "end-round",
      commandId: "command_end",
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: "command_mark",
      ball: 1,
    },
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "override-absence",
      commandId: "command_override",
      participantId: "participant_player",
      presenceGeneration: 2,
    },
  ] as const;

  it.each(mutationCommands)("parses $type", (command) => {
    expect(MutationCommandSchema.parse(command)).toEqual(command);
    expect(RealtimeCommandSchema.parse(command)).toEqual(command);
  });

  it("parses heartbeat and resync without treating them as mutations", () => {
    expect(
      RealtimeCommandSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "heartbeat",
      }),
    ).toEqual({ schemaVersion: CONTRACT_SCHEMA_VERSION, type: "heartbeat" });
    expect(
      RealtimeCommandSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "resync",
        lastEventSequence: 4,
      }),
    ).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "resync",
      lastEventSequence: 4,
    });
  });

  it.each(mutationCommands)("requires a valid command ID for $type", (command) => {
    const { commandId, ...missingCommandId } = command;

    expect(CommandIdSchema.safeParse(commandId).success).toBe(true);
    expect(MutationCommandSchema.safeParse(missingCommandId).success).toBe(false);
    expect(MutationCommandSchema.safeParse({ ...command, commandId: "" }).success).toBe(false);
  });

  it.each(["event-history", "get-event-history", "events-since", "chat"])(
    "defines no %s command",
    (type) => {
      expect(
        RealtimeCommandSchema.safeParse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          type,
          commandId: "command_unsupported",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects actor identity and authoritative result fields on commands", () => {
    expect(
      MutationCommandSchema.safeParse({
        ...mutationCommands[8],
        participantId: "participant_host",
      }).success,
    ).toBe(false);
    expect(
      MutationCommandSchema.safeParse({
        ...mutationCommands[5],
        eventSequence: 5,
        calledAt: NOW,
      }).success,
    ).toBe(false);
  });
});

describe("v1 event, acknowledgement, and error contracts", () => {
  it("requires committed events and acknowledgements to carry a sequence and timestamp", () => {
    const event = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "call",
      eventSequence: 5,
      occurredAt: NOW,
      call,
    } as const;
    const acknowledgement = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "ack",
      scope: "active-lobby",
      commandId: "command_call",
      eventSequence: 5,
      occurredAt: NOW,
      idempotentReplay: false,
    } as const;

    expect(ActiveLobbyEventSchema.parse(event)).toEqual(event);
    expect(CommandAckSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(ActiveLobbyEventSchema.safeParse({ ...event, eventSequence: 0 }).success).toBe(false);
    expect(CommandAckSchema.safeParse({ ...acknowledgement, occurredAt: "today" }).success).toBe(
      false,
    );
  });

  it("allows private-only command acknowledgements without a lobby event sequence", () => {
    const acknowledgement = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "ack",
      scope: "participant-private",
      commandId: "command_mark",
      eventSequence: null,
      occurredAt: NOW,
      idempotentReplay: false,
    } as const;

    expect(CommandAckSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(
      CommandAckSchema.safeParse({
        ...acknowledgement,
        scope: "active-lobby",
      }).success,
    ).toBe(false);
    expect(
      CommandAckSchema.safeParse({
        ...acknowledgement,
        scope: "participant-private",
        eventSequence: 5,
      }).success,
    ).toBe(false);
  });

  it("keeps participant-private events out of the lobby-wide event schema", () => {
    const privateMarkEvent = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-result",
      occurredAt: NOW,
      commandId: "command_mark",
      mark,
    } as const;
    const privateNearWinEvent = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "near-win",
      occurredAt: NOW,
      requiredBall: 2,
    } as const;

    expect(ParticipantPrivateEventSchema.parse(privateMarkEvent)).toEqual(privateMarkEvent);
    expect(ParticipantPrivateEventSchema.parse(privateNearWinEvent)).toEqual(privateNearWinEvent);
    expect(ActiveLobbyEventSchema.safeParse(privateMarkEvent).success).toBe(false);
    expect(ActiveLobbyEventSchema.safeParse(privateNearWinEvent).success).toBe(false);
    expect(
      ParticipantPrivateEventSchema.safeParse({ ...privateMarkEvent, eventSequence: 5 }).success,
    ).toBe(false);
    expect(
      ParticipantPrivateEventSchema.safeParse({ ...privateNearWinEvent, eventSequence: 6 }).success,
    ).toBe(false);
  });

  it("requires round-end events to contain an ended round", () => {
    const event = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "round-end",
      eventSequence: 7,
      occurredAt: LATER,
      round: endedRound,
    } as const;

    expect(ActiveLobbyEventSchema.parse(event)).toEqual(event);
    expect(ActiveLobbyEventSchema.safeParse({ ...event, round: activeRound }).success).toBe(false);
  });

  it("parses a safe versioned error and rejects internal detail", () => {
    const error = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "error",
      code: "INVALID_COMMAND",
      message: "The command is not valid in the current state.",
      commandId: "command_call",
      occurredAt: NOW,
      retryable: false,
      issues: [{ path: "type", code: "invalid_value", message: "Unsupported command." }],
    } as const;

    expect(ErrorSchema.parse(error)).toEqual(error);
    expect(ErrorSchema.safeParse({ ...error, stack: "private stack" }).success).toBe(false);
    expect(ErrorSchema.safeParse({ ...error, details: { token: "private" } }).success).toBe(false);
    expect(ErrorSchema.safeParse({ ...error, message: "Secret token abc123" }).success).toBe(false);
    expect(
      ErrorSchema.safeParse({
        ...error,
        issues: [{ ...error.issues[0], message: "Raw private payload" }],
      }).success,
    ).toBe(false);
    expect(
      ErrorSchema.safeParse({
        ...error,
        issues: [{ ...error.issues[0], path: "session.token=private" }],
      }).success,
    ).toBe(false);
    expect(
      ErrorSchema.safeParse({
        ...error,
        code: "UNAUTHORIZED",
      }).success,
    ).toBe(false);
    expect(
      ErrorSchema.safeParse({
        ...error,
        issues: [{ path: "type", code: "required", message: "Unsupported command." }],
      }).success,
    ).toBe(false);
    expect(ErrorSchema.safeParse({ ...error, schemaVersion: 2 }).success).toBe(false);
  });
});
