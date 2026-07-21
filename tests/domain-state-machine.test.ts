import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createWaitingRound,
  expireInactiveLobby,
  transitionRound,
} from "../packages/domain/src/index.js";
import type {
  LobbyInactivityState,
  RoundCommand,
  RoundPatternMode,
  RoundState,
  RoundTransitionResult,
} from "../packages/domain/src/index.js";

const CREATED_AT = 1_000;
const STARTED_AT = 2_000;

function expectRoundTransition(result: RoundTransitionResult): RoundState {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.state;
}

function progressToResult(initialPatternMode: RoundPatternMode) {
  let state = expectRoundTransition(
    transitionRound(createWaitingRound(initialPatternMode, CREATED_AT), {
      type: "start",
      at: STARTED_AT,
    }),
  );
  state = expectRoundTransition(
    transitionRound(state, {
      type: "open-co-winner-window",
      at: 3_000,
      closesAt: 5_000,
    }),
  );
  return expectRoundTransition(transitionRound(state, { type: "settle-result", at: 5_000 }));
}

describe("round state machine", () => {
  it("moves through waiting, active, paused, co-winner-window, result, and ended states", () => {
    let state: RoundState = createWaitingRound("one-line", CREATED_AT);
    expect(state).toMatchObject({
      stage: "waiting",
      initialPatternMode: "one-line",
      patternMode: "one-line",
      createdAt: CREATED_AT,
    });

    state = expectRoundTransition(transitionRound(state, { type: "start", at: STARTED_AT }));
    expect(state).toMatchObject({ stage: "active", startedAt: STARTED_AT });

    state = expectRoundTransition(
      transitionRound(state, { type: "pause", reason: "host-command", at: 2_500 }),
    );
    expect(state).toEqual({
      initialPatternMode: "one-line",
      patternMode: "one-line",
      createdAt: CREATED_AT,
      startedAt: STARTED_AT,
      stage: "paused",
      pauseReason: "host-command",
      pausedAt: 2_500,
    });

    state = expectRoundTransition(transitionRound(state, { type: "resume", at: 2_750 }));
    expect(state).toMatchObject({ stage: "active", startedAt: STARTED_AT });

    state = expectRoundTransition(
      transitionRound(state, {
        type: "open-co-winner-window",
        at: 3_000,
        closesAt: 5_000,
      }),
    );
    expect(state).toEqual({
      initialPatternMode: "one-line",
      patternMode: "one-line",
      createdAt: CREATED_AT,
      startedAt: STARTED_AT,
      stage: "co-winner-window",
      windowOpenedAt: 3_000,
      windowClosesAt: 5_000,
    });

    state = expectRoundTransition(transitionRound(state, { type: "settle-result", at: 5_000 }));
    expect(state).toMatchObject({ stage: "result", settledAt: 5_000 });

    state = expectRoundTransition(transitionRound(state, { type: "end", at: 5_500 }));
    expect(state).toMatchObject({ stage: "ended", endedAt: 5_500 });
  });

  it("allows only One Line to continue through Two Lines and Blackout", () => {
    let state = progressToResult("one-line");

    state = expectRoundTransition(
      transitionRound(state, { type: "continue", patternMode: "two-lines", at: 6_000 }),
    );
    expect(state).toMatchObject({ stage: "active", patternMode: "two-lines" });

    state = expectRoundTransition(
      transitionRound(state, {
        type: "open-co-winner-window",
        at: 7_000,
        closesAt: 9_000,
      }),
    );
    state = expectRoundTransition(transitionRound(state, { type: "settle-result", at: 9_000 }));
    state = expectRoundTransition(
      transitionRound(state, { type: "continue", patternMode: "blackout", at: 10_000 }),
    );

    expect(state).toMatchObject({
      stage: "active",
      initialPatternMode: "one-line",
      patternMode: "blackout",
    });
  });

  it.each(["two-lines", "blackout", "exact"] as const)(
    "treats an initially selected %s pattern as terminal after its result",
    (initialPatternMode) => {
      const result = transitionRound(progressToResult(initialPatternMode), {
        type: "continue",
        patternMode: "blackout",
        at: 6_000,
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "ROUND_CONTINUATION_NOT_ALLOWED",
          message: "Only a round that started with One Line may continue to its next pattern.",
        },
      });
    },
  );

  it("treats Blackout reached through One Line progression as terminal", () => {
    let state = progressToResult("one-line");
    state = expectRoundTransition(
      transitionRound(state, { type: "continue", patternMode: "two-lines", at: 6_000 }),
    );
    state = expectRoundTransition(
      transitionRound(state, {
        type: "open-co-winner-window",
        at: 7_000,
        closesAt: 9_000,
      }),
    );
    state = expectRoundTransition(transitionRound(state, { type: "settle-result", at: 9_000 }));
    state = expectRoundTransition(
      transitionRound(state, { type: "continue", patternMode: "blackout", at: 10_000 }),
    );
    state = expectRoundTransition(
      transitionRound(state, {
        type: "open-co-winner-window",
        at: 11_000,
        closesAt: 13_000,
      }),
    );
    state = expectRoundTransition(transitionRound(state, { type: "settle-result", at: 13_000 }));

    expect(
      transitionRound(state, { type: "continue", patternMode: "blackout", at: 14_000 }),
    ).toEqual({
      ok: false,
      error: {
        code: "ROUND_CONTINUATION_NOT_ALLOWED",
        message: "Blackout is the terminal pattern in a continuing round.",
      },
    });
  });

  it("returns stable errors for invalid transitions and early result settlement", () => {
    const waiting = createWaitingRound("one-line", CREATED_AT);
    const invalidPause = transitionRound(waiting, {
      type: "pause",
      reason: "host-command",
      at: 1_500,
    });

    expect(invalidPause).toEqual({
      ok: false,
      error: {
        code: "ROUND_TRANSITION_NOT_ALLOWED",
        message: "Cannot pause while the round is waiting.",
      },
    });
    expect(transitionRound(waiting, { type: "pause", reason: "host-command", at: 1_500 })).toEqual(
      invalidPause,
    );

    let state = expectRoundTransition(transitionRound(waiting, { type: "start", at: STARTED_AT }));
    state = expectRoundTransition(
      transitionRound(state, {
        type: "open-co-winner-window",
        at: 3_000,
        closesAt: 5_000,
      }),
    );

    expect(transitionRound(state, { type: "settle-result", at: 4_999 })).toEqual({
      ok: false,
      error: {
        code: "CO_WINNER_WINDOW_STILL_OPEN",
        message: "The co-winner window must close before its result can settle.",
      },
    });
  });

  it("opens the co-winner window when a valid completion arrives while paused", () => {
    let state = expectRoundTransition(
      transitionRound(createWaitingRound("one-line", CREATED_AT), {
        type: "start",
        at: STARTED_AT,
      }),
    );
    state = expectRoundTransition(
      transitionRound(state, { type: "pause", reason: "participant-absent", at: 2_500 }),
    );

    expect(
      transitionRound(state, {
        type: "open-co-winner-window",
        at: 3_000,
        closesAt: 5_000,
      }),
    ).toEqual({
      ok: true,
      state: {
        initialPatternMode: "one-line",
        patternMode: "one-line",
        createdAt: CREATED_AT,
        startedAt: STARTED_AT,
        stage: "co-winner-window",
        windowOpenedAt: 3_000,
        windowClosesAt: 5_000,
      },
    });
  });

  it("rejects ending an unstarted round and keeps ended rounds terminal", () => {
    const waiting = createWaitingRound("exact", CREATED_AT);

    expect(transitionRound(waiting, { type: "end", at: 1_500 })).toEqual({
      ok: false,
      error: {
        code: "ROUND_TRANSITION_NOT_ALLOWED",
        message: "Cannot end while the round is waiting.",
      },
    });

    const ended = expectRoundTransition(
      transitionRound(progressToResult("exact"), { type: "end", at: 5_500 }),
    );

    expect(transitionRound(ended, { type: "start", at: STARTED_AT })).toMatchObject({
      ok: false,
      error: { code: "ROUND_TRANSITION_NOT_ALLOWED" },
    });
  });

  it("rejects transition timestamps that move backward", () => {
    let state = expectRoundTransition(
      transitionRound(createWaitingRound("one-line", CREATED_AT), {
        type: "start",
        at: STARTED_AT,
      }),
    );
    state = expectRoundTransition(
      transitionRound(state, { type: "pause", reason: "host-command", at: 3_000 }),
    );

    expect(() => transitionRound(state, { type: "end", at: 2_999 })).toThrow(RangeError);

    state = expectRoundTransition(transitionRound(state, { type: "resume", at: 4_000 }));

    expect(() =>
      transitionRound(state, {
        type: "open-co-winner-window",
        at: 3_999,
        closesAt: 5_000,
      }),
    ).toThrow(RangeError);
  });

  it("rejects a requested continuation that skips the next pattern", () => {
    const state = progressToResult("one-line");

    expect(
      transitionRound(state, {
        type: "continue",
        patternMode: "blackout",
        at: 6_000,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "ROUND_CONTINUATION_NOT_ALLOWED",
        message: "The requested pattern is not the next allowed continuation.",
      },
    });
  });

  it("rejects every command not allowed by the current stage without mutating state", () => {
    const waiting = createWaitingRound("one-line", CREATED_AT);
    const active = expectRoundTransition(
      transitionRound(waiting, { type: "start", at: STARTED_AT }),
    );
    const paused = expectRoundTransition(
      transitionRound(active, { type: "pause", reason: "host-command", at: 3_000 }),
    );
    const coWinnerWindow = expectRoundTransition(
      transitionRound(active, {
        type: "open-co-winner-window",
        at: 3_000,
        closesAt: 5_000,
      }),
    );
    const result = expectRoundTransition(
      transitionRound(coWinnerWindow, { type: "settle-result", at: 5_000 }),
    );
    const ended = expectRoundTransition(transitionRound(result, { type: "end", at: 6_000 }));
    const states = { waiting, active, paused, coWinnerWindow, result, ended } as const;
    const commands = [
      { type: "start", at: 10_000 },
      { type: "pause", reason: "host-command", at: 10_000 },
      { type: "resume", at: 10_000 },
      { type: "open-co-winner-window", at: 10_000, closesAt: 12_000 },
      { type: "settle-result", at: 10_000 },
      { type: "continue", patternMode: "two-lines", at: 10_000 },
      { type: "end", at: 10_000 },
    ] satisfies readonly RoundCommand[];
    const allowed = {
      waiting: new Set<RoundCommand["type"]>(["start"]),
      active: new Set<RoundCommand["type"]>(["pause", "open-co-winner-window", "end"]),
      paused: new Set<RoundCommand["type"]>(["resume", "open-co-winner-window", "end"]),
      coWinnerWindow: new Set<RoundCommand["type"]>(["settle-result"]),
      result: new Set<RoundCommand["type"]>(["continue", "end"]),
      ended: new Set<RoundCommand["type"]>(),
    } as const;

    Object.entries(states).forEach(([name, state]) => {
      commands.forEach((command) => {
        if (allowed[name as keyof typeof allowed].has(command.type)) {
          return;
        }
        const before = structuredClone(state);

        expect(transitionRound(state, command)).toEqual({
          ok: false,
          error: {
            code: "ROUND_TRANSITION_NOT_ALLOWED",
            message: `Cannot ${command.type} while the round is ${state.stage}.`,
          },
        });
        expect(state).toEqual(before);
      });
    });
  });

  it("rejects malformed timestamps at every round transition boundary", () => {
    expect(() => createWaitingRound("one-line", -1)).toThrow(RangeError);

    const waiting = createWaitingRound("one-line", CREATED_AT);
    expect(() => transitionRound(waiting, { type: "start", at: CREATED_AT - 1 })).toThrow(
      RangeError,
    );

    const active = expectRoundTransition(
      transitionRound(waiting, { type: "start", at: STARTED_AT }),
    );
    expect(() =>
      transitionRound(active, {
        type: "pause",
        reason: "host-command",
        at: STARTED_AT - 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      transitionRound(active, {
        type: "open-co-winner-window",
        at: STARTED_AT - 1,
        closesAt: 4_000,
      }),
    ).toThrow(RangeError);
    expect(() =>
      transitionRound(active, {
        type: "open-co-winner-window",
        at: 3_000,
        closesAt: 3_000,
      }),
    ).toThrow(RangeError);

    const paused = expectRoundTransition(
      transitionRound(active, { type: "pause", reason: "host-command", at: 3_000 }),
    );
    expect(() => transitionRound(paused, { type: "resume", at: 2_999 })).toThrow(RangeError);

    const result = progressToResult("one-line");
    expect(() =>
      transitionRound(result, {
        type: "continue",
        patternMode: "two-lines",
        at: 4_999,
      }),
    ).toThrow(RangeError);
    expect(() => transitionRound(active, { type: "end", at: STARTED_AT - 1 })).toThrow(RangeError);
  });
});

describe("lobby inactivity state machine", () => {
  const ttlMs = 30 * 60 * 1_000;
  const lastActivityAt = 10_000;
  const expiryAt = lastActivityAt + ttlMs;

  it("preserves the exact inactivity boundary across generated eligible lobbies", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("waiting", "completed", "abandoned"),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER - 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (status, generatedLastActivityAt, generatedTtlMs) => {
          const state: LobbyInactivityState = {
            status,
            lastActivityAt: generatedLastActivityAt,
          };
          const generatedExpiryAt = generatedLastActivityAt + generatedTtlMs;

          expect(expireInactiveLobby(state, generatedExpiryAt - 1, generatedTtlMs)).toMatchObject({
            ok: false,
            error: { code: "LOBBY_NOT_INACTIVE" },
          });
          expect(expireInactiveLobby(state, generatedExpiryAt, generatedTtlMs)).toEqual({
            ok: true,
            state: { status: "expired", expiredAt: generatedExpiryAt },
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it.each(["waiting", "completed", "abandoned"] as const)(
    "expires an inactive %s lobby at the configured boundary",
    (status) => {
      const state: LobbyInactivityState = { status, lastActivityAt };

      expect(expireInactiveLobby(state, expiryAt, ttlMs)).toEqual({
        ok: true,
        state: { status: "expired", expiredAt: expiryAt },
      });
    },
  );

  it("does not expire a lobby before its inactivity threshold", () => {
    const state: LobbyInactivityState = { status: "waiting", lastActivityAt };

    expect(expireInactiveLobby(state, expiryAt - 1, ttlMs)).toEqual({
      ok: false,
      error: {
        code: "LOBBY_NOT_INACTIVE",
        message: "The lobby has not reached its inactivity expiry threshold.",
      },
    });
  });

  it.each([
    { hasActiveCalls: true, activeConnectionCount: 0 },
    { hasActiveCalls: false, activeConnectionCount: 1 },
    { hasActiveCalls: true, activeConnectionCount: 2 },
  ])("protects active lobbies with calls or connections from expiry", (activity) => {
    const state: LobbyInactivityState = {
      status: "active",
      lastActivityAt,
      ...activity,
    };

    expect(expireInactiveLobby(state, expiryAt, ttlMs)).toEqual({
      ok: false,
      error: {
        code: "LOBBY_EXPIRY_PROTECTED",
        message: "An active lobby with calls or connections cannot expire.",
      },
    });
  });

  it("expires an abandoned active lobby with no calls or connections", () => {
    const state: LobbyInactivityState = {
      status: "active",
      lastActivityAt,
      hasActiveCalls: false,
      activeConnectionCount: 0,
    };

    expect(expireInactiveLobby(state, expiryAt, ttlMs)).toEqual({
      ok: true,
      state: { status: "expired", expiredAt: expiryAt },
    });
  });

  it("keeps expired lobbies terminal with a stable error", () => {
    const state: LobbyInactivityState = { status: "expired", expiredAt: expiryAt };

    expect(expireInactiveLobby(state, expiryAt + ttlMs, ttlMs)).toEqual({
      ok: false,
      error: {
        code: "LOBBY_ALREADY_EXPIRED",
        message: "The lobby has already expired.",
      },
    });
  });

  it("rejects malformed timing and connection inputs", () => {
    const waiting: LobbyInactivityState = { status: "waiting", lastActivityAt };
    const active: LobbyInactivityState = {
      status: "active",
      lastActivityAt,
      hasActiveCalls: false,
      activeConnectionCount: -1,
    };

    expect(() => expireInactiveLobby(waiting, lastActivityAt - 1, ttlMs)).toThrow(RangeError);
    expect(() => expireInactiveLobby(waiting, expiryAt, 0)).toThrow(RangeError);
    expect(() => expireInactiveLobby(active, expiryAt, ttlMs)).toThrow(RangeError);
  });
});
