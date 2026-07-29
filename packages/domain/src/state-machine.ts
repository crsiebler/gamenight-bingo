export type RoundPatternMode = "one-line" | "two-lines" | "blackout" | "exact";
export type RoundPauseReason = "host-command" | "host-absent" | "participant-absent";

interface RoundStateBase {
  readonly initialPatternMode: RoundPatternMode;
  readonly patternMode: RoundPatternMode;
  readonly createdAt: number;
}

interface StartedRoundStateBase extends RoundStateBase {
  readonly startedAt: number;
}

export interface WaitingRoundState extends RoundStateBase {
  readonly stage: "waiting";
}

export interface ActiveRoundState extends StartedRoundStateBase {
  readonly stage: "active";
  readonly activeAt: number;
}

export interface PausedRoundState extends StartedRoundStateBase {
  readonly stage: "paused";
  readonly pauseReason: RoundPauseReason;
  readonly pausedAt: number;
}

export interface CoWinnerWindowRoundState extends StartedRoundStateBase {
  readonly stage: "co-winner-window";
  readonly windowOpenedAt: number;
  readonly windowClosesAt: number;
}

export interface ResultRoundState extends StartedRoundStateBase {
  readonly stage: "result";
  readonly settledAt: number;
}

export interface EndedRoundState extends RoundStateBase {
  readonly stage: "ended";
  readonly startedAt: number;
  readonly endedAt: number;
}

export type RoundState =
  | WaitingRoundState
  | ActiveRoundState
  | PausedRoundState
  | CoWinnerWindowRoundState
  | ResultRoundState
  | EndedRoundState;

export type RoundCommand =
  | { readonly type: "start"; readonly at: number }
  | {
      readonly type: "pause";
      readonly reason: RoundPauseReason;
      readonly at: number;
    }
  | { readonly type: "resume"; readonly at: number }
  | {
      readonly type: "open-co-winner-window";
      readonly at: number;
      readonly closesAt: number;
    }
  | { readonly type: "settle-result"; readonly at: number }
  | {
      readonly type: "continue";
      readonly patternMode: RoundPatternMode;
      readonly at: number;
    }
  | { readonly type: "end"; readonly at: number };

export type RoundTransitionError = {
  readonly code:
    | "ROUND_TRANSITION_NOT_ALLOWED"
    | "ROUND_CONTINUATION_NOT_ALLOWED"
    | "CO_WINNER_WINDOW_STILL_OPEN";
  readonly message: string;
};

export type RoundTransitionResult =
  | { readonly ok: true; readonly state: RoundState }
  | { readonly ok: false; readonly error: RoundTransitionError };

interface InactiveLobbyState {
  readonly status: "waiting" | "completed" | "abandoned";
  readonly lastActivityAt: number;
}

export interface ActiveLobbyInactivityState {
  readonly status: "active";
  readonly lastActivityAt: number;
  readonly hasActiveCalls: boolean;
  readonly activeConnectionCount: number;
}

export interface ExpiredLobbyInactivityState {
  readonly status: "expired";
  readonly expiredAt: number;
}

export type LobbyInactivityState =
  InactiveLobbyState | ActiveLobbyInactivityState | ExpiredLobbyInactivityState;

export type LobbyExpiryError = {
  readonly code: "LOBBY_NOT_INACTIVE" | "LOBBY_EXPIRY_PROTECTED" | "LOBBY_ALREADY_EXPIRED";
  readonly message: string;
};

export type LobbyExpiryResult =
  | { readonly ok: true; readonly state: ExpiredLobbyInactivityState }
  | { readonly ok: false; readonly error: LobbyExpiryError };

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer timestamp.`);
  }
}

function success(state: RoundState): RoundTransitionResult {
  return { ok: true, state };
}

function transitionNotAllowed(state: RoundState, command: RoundCommand): RoundTransitionResult {
  return {
    ok: false,
    error: {
      code: "ROUND_TRANSITION_NOT_ALLOWED",
      message: `Cannot ${command.type} while the round is ${state.stage}.`,
    },
  };
}

function startedStateBase(state: StartedRoundStateBase): StartedRoundStateBase {
  return {
    initialPatternMode: state.initialPatternMode,
    patternMode: state.patternMode,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
  };
}

function latestRoundTransitionAt(state: Exclude<RoundState, CoWinnerWindowRoundState>): number {
  switch (state.stage) {
    case "waiting":
      return state.createdAt;
    case "active":
      return state.activeAt;
    case "paused":
      return state.pausedAt;
    case "result":
      return state.settledAt;
    case "ended":
      return state.endedAt;
  }
}

export function createWaitingRound(
  initialPatternMode: RoundPatternMode,
  createdAt: number,
): WaitingRoundState {
  assertTimestamp(createdAt, "Round creation time");
  return {
    stage: "waiting",
    initialPatternMode,
    patternMode: initialPatternMode,
    createdAt,
  };
}

export function transitionRound(state: RoundState, command: RoundCommand): RoundTransitionResult {
  assertTimestamp(command.at, "Round transition time");

  switch (command.type) {
    case "start":
      if (state.stage !== "waiting") {
        return transitionNotAllowed(state, command);
      }
      if (command.at < state.createdAt) {
        throw new RangeError("Round start time cannot precede round creation.");
      }
      return success({
        ...state,
        stage: "active",
        startedAt: command.at,
        activeAt: command.at,
      });

    case "pause":
      if (state.stage !== "active") {
        return transitionNotAllowed(state, command);
      }
      if (command.at < state.activeAt) {
        throw new RangeError("Round pause time cannot precede round activation.");
      }
      return success({
        ...startedStateBase(state),
        stage: "paused",
        pauseReason: command.reason,
        pausedAt: command.at,
      });

    case "resume":
      if (state.stage !== "paused") {
        return transitionNotAllowed(state, command);
      }
      if (command.at < state.pausedAt) {
        throw new RangeError("Round resume time cannot precede the pause.");
      }
      return success({
        ...startedStateBase(state),
        stage: "active",
        activeAt: command.at,
      });

    case "open-co-winner-window":
      assertTimestamp(command.closesAt, "Co-winner window close time");
      if (command.closesAt <= command.at) {
        throw new RangeError("The co-winner window must close after it opens.");
      }
      if (state.stage !== "active" && state.stage !== "paused") {
        return transitionNotAllowed(state, command);
      }
      if (command.at < (state.stage === "active" ? state.activeAt : state.pausedAt)) {
        throw new RangeError("The co-winner window cannot open before the current round state.");
      }
      return success({
        ...startedStateBase(state),
        stage: "co-winner-window",
        windowOpenedAt: command.at,
        windowClosesAt: command.closesAt,
      });

    case "settle-result":
      if (state.stage !== "co-winner-window") {
        return transitionNotAllowed(state, command);
      }
      if (command.at < state.windowClosesAt) {
        return {
          ok: false,
          error: {
            code: "CO_WINNER_WINDOW_STILL_OPEN",
            message: "The co-winner window must close before its result can settle.",
          },
        };
      }
      return success({
        ...startedStateBase(state),
        stage: "result",
        settledAt: command.at,
      });

    case "continue": {
      if (state.stage !== "result") {
        return transitionNotAllowed(state, command);
      }
      if (command.at < state.settledAt) {
        throw new RangeError("Round continuation time cannot precede result settlement.");
      }
      if (state.initialPatternMode !== "one-line") {
        return {
          ok: false,
          error: {
            code: "ROUND_CONTINUATION_NOT_ALLOWED",
            message: "Only a round that started with One Line may continue to its next pattern.",
          },
        };
      }
      if (state.patternMode === "blackout") {
        return {
          ok: false,
          error: {
            code: "ROUND_CONTINUATION_NOT_ALLOWED",
            message: "Blackout is the terminal pattern in a continuing round.",
          },
        };
      }

      const patternMode = state.patternMode === "one-line" ? "two-lines" : "blackout";
      if (command.patternMode !== patternMode) {
        return {
          ok: false,
          error: {
            code: "ROUND_CONTINUATION_NOT_ALLOWED",
            message: "The requested pattern is not the next allowed continuation.",
          },
        };
      }
      return success({
        ...startedStateBase(state),
        stage: "active",
        activeAt: command.at,
        patternMode,
      });
    }

    case "end":
      if (
        state.stage === "waiting" ||
        state.stage === "co-winner-window" ||
        state.stage === "ended"
      ) {
        return transitionNotAllowed(state, command);
      }
      if (command.at < latestRoundTransitionAt(state)) {
        throw new RangeError("Round end time cannot precede the current round state.");
      }
      return success({
        initialPatternMode: state.initialPatternMode,
        patternMode: state.patternMode,
        createdAt: state.createdAt,
        stage: "ended",
        startedAt: state.startedAt,
        endedAt: command.at,
      });
  }
}

export function expireInactiveLobby(
  state: LobbyInactivityState,
  now: number,
  inactivityTtlMs: number,
): LobbyExpiryResult {
  assertTimestamp(now, "Current time");
  if (!Number.isSafeInteger(inactivityTtlMs) || inactivityTtlMs <= 0) {
    throw new RangeError("Lobby inactivity TTL must be a positive safe integer duration.");
  }

  if (state.status === "expired") {
    assertTimestamp(state.expiredAt, "Lobby expiry time");
    return {
      ok: false,
      error: {
        code: "LOBBY_ALREADY_EXPIRED",
        message: "The lobby has already expired.",
      },
    };
  }

  assertTimestamp(state.lastActivityAt, "Last lobby activity time");
  if (now < state.lastActivityAt) {
    throw new RangeError("Current time cannot precede the last lobby activity.");
  }

  if (state.status === "active") {
    if (!Number.isSafeInteger(state.activeConnectionCount) || state.activeConnectionCount < 0) {
      throw new RangeError("Active connection count must be a nonnegative safe integer.");
    }
    if (state.hasActiveCalls || state.activeConnectionCount > 0) {
      return {
        ok: false,
        error: {
          code: "LOBBY_EXPIRY_PROTECTED",
          message: "An active lobby with calls or connections cannot expire.",
        },
      };
    }
  }

  if (now - state.lastActivityAt < inactivityTtlMs) {
    return {
      ok: false,
      error: {
        code: "LOBBY_NOT_INACTIVE",
        message: "The lobby has not reached its inactivity expiry threshold.",
      },
    };
  }

  return {
    ok: true,
    state: { status: "expired", expiredAt: now },
  };
}
