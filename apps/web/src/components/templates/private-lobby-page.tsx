"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

import {
  SnapshotSchema,
  type ParticipantPrivateEvent,
  type ActiveLobbyEvent,
  type AutomaticCallInterval,
  type CallConfiguration,
  type CommandAck,
  type ParticipantSummary,
  type Snapshot,
} from "@gamenight-bingo/contracts";
import { calculatePatternProgress, patternCatalog } from "@gamenight-bingo/patterns";
import {
  getTheme,
  themeCssVariables,
  type ThemeAssetRole,
  type ThemeDefinition,
} from "@gamenight-bingo/themes";
import { BingoCard, type BingoCardCell } from "@gamenight-bingo/ui";

import { Button, LinkButton, Option } from "@/atoms";
import { Select } from "@/molecules";
import {
  MarkCardCommandSession,
  PrivateLobbyFlowError,
  WaitingLobbyCommandSession,
  loadPrivateLobbySnapshot,
  type MarkCardCommandSelection,
  type WaitingLobbyCommand,
  type WaitingLobbyCommandAck,
} from "@/lib/private-lobby-flow";
import {
  connectPrivateLobbyRealtime,
  type PrivateLobbyConnectionState,
  type PrivateLobbyRealtimeConnection,
  type PrivateLobbyRealtimeHandlers,
} from "@/lib/private-lobby-realtime";

type PatternOption = {
  category: "standard" | "shape" | "letter" | "number" | "christmas";
  id: string;
  name: string;
};

type PrivateLobbyPageProps = {
  code: string;
  patterns: readonly PatternOption[];
  loadSnapshot?: (code: string) => Promise<Snapshot>;
  copyText?: (value: string) => Promise<void>;
  shareInvite?: ((data: { title: string; text: string; url: string }) => Promise<void>) | null;
  origin?: string;
  createCommandSession?: (command: WaitingLobbyCommand) => {
    run(): Promise<WaitingLobbyCommandAck>;
  };
  createMarkCommandSession?: (command: MarkCardCommandSelection) => {
    run(): Promise<CommandAck>;
  };
  connectRealtime?: (handlers: PrivateLobbyRealtimeHandlers) => PrivateLobbyRealtimeConnection;
  enableRealtime?: boolean;
  realtimeServerUrl?: string;
};

type PendingCommandReconciliation = {
  command: WaitingLobbyCommand;
  eventSequence: WaitingLobbyCommandAck["eventSequence"];
  roundId: string | null;
  startingCallCount: number;
};

type PendingMarkReconciliation = {
  ball: number;
  cardId: string;
  eventSequence: number | null;
};

type UnresolvedMark = {
  ball: number;
  cardId: string;
};

const AUTOMATIC_INTERVALS = [5, 10, 30, 60, 120] as const;
const PATTERN_CATEGORY_LABELS = {
  standard: "Standard",
  shape: "Shape",
  letter: "Letter",
  number: "Number",
  christmas: "Christmas",
} as const;

function ThemeArtwork({
  className,
  loaded,
  role,
  theme,
}: {
  className: string;
  loaded: boolean;
  role: ThemeAssetRole;
  theme: ThemeDefinition | undefined;
}) {
  if (theme === undefined) return null;
  return (
    <span aria-hidden="true" className={`theme-artwork ${className}`} data-loaded={loaded}>
      <span className="theme-art-fallback">◇</span>
      <svg
        aria-hidden="true"
        className="theme-art-vector"
        data-theme-asset={role}
        focusable="false"
        viewBox="0 0 120 120"
      >
        <use href={`${theme.visuals.spriteUrl}#${role}`} />
      </svg>
    </span>
  );
}

function presenceText(participant: ParticipantSummary): string {
  switch (participant.presence.status) {
    case "connected":
      return "Connected";
    case "grace":
      return "Grace period: reconnecting";
    case "absent":
      return participant.presence.overridden ? "Absent: host override applied" : "Absent";
    case "departed":
      return "Departed";
  }
}

function intervalFromValue(value: string): AutomaticCallInterval {
  const interval = Number(value);
  return AUTOMATIC_INTERVALS.includes(interval as AutomaticCallInterval)
    ? (interval as AutomaticCallInterval)
    : 30;
}

function eligibilityText(participant: ParticipantSummary, hasRound: boolean): string {
  if (!hasRound) {
    return participant.roundEligibility === "playing"
      ? "Ready for first round"
      : "Waiting for first round";
  }
  return participant.roundEligibility === "waiting"
    ? "Waiting for next round"
    : "Playing this round";
}

function patternLabel(pattern: PatternOption, duplicateNames: ReadonlySet<string>): string {
  return duplicateNames.has(pattern.name)
    ? `${pattern.name} (${PATTERN_CATEGORY_LABELS[pattern.category]})`
    : pattern.name;
}

function ballLabel(ball: number): string {
  return `${["B", "I", "N", "G", "O"][Math.floor((ball - 1) / 15)]} ${ball}`;
}

function namesAsSentence(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "The confirmed winner";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function coWinnerDurationLabel(openedAt: string, closesAt: string): string {
  const durationMs = Date.parse(closesAt) - Date.parse(openedAt);
  if (durationMs < 1_000) return `${durationMs}-millisecond`;
  const seconds = durationMs / 1_000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(3).replace(/0+$/, "")}-second`;
}

function outcomeIdentityFor(snapshot: Snapshot): string | null {
  const round = snapshot.round;
  if (round?.stage === "co-winner-window") {
    return [
      "window",
      round.id,
      round.patternId,
      round.window.triggeringCallId,
      round.window.openedAt,
      round.window.closesAt,
    ].join(":");
  }
  if (round?.stage !== "result" && round?.stage !== "ended") return null;
  const result = round.result;
  if (round.stage === "ended" && result === null) {
    return ["ended", round.id, round.patternId, round.endedAt, "no-result"].join(":");
  }
  if (result === null) return null;
  return [
    round.stage,
    round.id,
    round.patternId,
    result.triggeringCallId,
    result.openedAt,
    result.closesAt,
    result.settledAt,
    ...result.winnerParticipantIds,
  ].join(":");
}

function resultAnnouncementFor(snapshot: Snapshot): string | null {
  const result =
    snapshot.round?.stage === "result"
      ? snapshot.round.result
      : snapshot.round?.stage === "ended"
        ? snapshot.round.result
        : null;
  if (result === null) return null;
  const patternName =
    patternCatalog.find(({ id }) => id === snapshot.round?.patternId)?.name ?? "the pattern";
  const winners = result.winnerParticipantIds.flatMap((participantId) => {
    const participant = snapshot.participants.find(({ id }) => id === participantId);
    return participant === undefined ? [] : [participant];
  });
  if (winners.some(({ id }) => id === snapshot.self.id)) {
    if (winners.length === 1) return `Results confirmed. You won ${patternName}.`;
    return `Results confirmed. You and ${winners.length - 1} other ${winners.length === 2 ? "participant" : "participants"} won ${patternName}.`;
  }
  return winners.length === 1
    ? `Results confirmed. ${winners[0]?.username ?? "One participant"} won ${patternName}.`
    : `Results confirmed. ${winners.length} participants won ${patternName}.`;
}

function pauseDescription(reason: "host-command" | "host-absent" | "participant-absent"): string {
  switch (reason) {
    case "host-command":
      return "Paused by the host.";
    case "host-absent":
      return "Paused because the host is absent.";
    case "participant-absent":
      return "Paused because a player is absent.";
  }
}

function validateSnapshot(snapshot: Snapshot): Snapshot | null {
  const parsed = SnapshotSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : null;
}

function mergeAppendOnlyMarks(current: Snapshot | null, next: Snapshot): Snapshot | null {
  if (current === null || current.ownCard?.id !== next.ownCard?.id) return validateSnapshot(next);
  const markIds = new Set(next.ownMarks.map(({ id }) => id));
  const markedBalls = new Set(next.ownMarks.map(({ ball }) => ball));
  const retained = current.ownMarks.filter(
    ({ id, ball }) => !markIds.has(id) && !markedBalls.has(ball),
  );
  return validateSnapshot({ ...next, ownMarks: [...next.ownMarks, ...retained] });
}

function applyLobbyEvent(snapshot: Snapshot, event: ActiveLobbyEvent): Snapshot | null {
  if (event.type === "call") {
    if (
      snapshot.round === null ||
      event.call.roundId !== snapshot.round.id ||
      event.call.position !== snapshot.calls.length + 1 ||
      snapshot.calls.some(({ id, ball }) => id === event.call.id || ball === event.call.ball)
    ) {
      return null;
    }
    return validateSnapshot({
      ...snapshot,
      generatedAt: event.occurredAt,
      lastEventSequence: event.eventSequence,
      calls: [...snapshot.calls, event.call],
      timer: snapshot.timer?.kind === "automatic-call" ? null : snapshot.timer,
    });
  }

  if (event.type === "presence") {
    const prior = snapshot.participants.find(({ id }) => id === event.presence.participantId);
    if (prior === undefined || event.presence.generation < prior.presence.generation) return null;
    const participants = snapshot.participants.map((participant) =>
      participant.id === event.presence.participantId
        ? { ...participant, presence: event.presence }
        : participant,
    );
    return validateSnapshot({
      ...snapshot,
      generatedAt: event.occurredAt,
      lastEventSequence: event.eventSequence,
      participants,
      self:
        snapshot.self.id === event.presence.participantId
          ? { ...snapshot.self, presence: event.presence }
          : snapshot.self,
    });
  }

  if (snapshot.round === null) return null;
  if (event.type === "stage" || event.type === "round-end") {
    if (event.round.id !== snapshot.round.id) return null;
    return validateSnapshot({
      ...snapshot,
      generatedAt: event.occurredAt,
      lastEventSequence: event.eventSequence,
      round: event.round,
      timer: null,
    });
  }
  if (event.type === "co-winner-window") {
    if (
      snapshot.round.stage === "waiting" ||
      snapshot.calls.at(-1)?.id !== event.window.triggeringCallId
    ) {
      return null;
    }
    return validateSnapshot({
      ...snapshot,
      generatedAt: event.occurredAt,
      lastEventSequence: event.eventSequence,
      round: {
        id: snapshot.round.id,
        lobbyId: snapshot.round.lobbyId,
        patternId: snapshot.round.patternId,
        callConfiguration: snapshot.round.callConfiguration,
        startedAt: snapshot.round.startedAt,
        stage: "co-winner-window",
        window: event.window,
      },
      timer: {
        kind: "co-winner",
        triggeringCallId: event.window.triggeringCallId,
        deadline: event.window.closesAt,
      },
    });
  }
  if (
    snapshot.round.stage === "waiting" ||
    snapshot.calls.at(-1)?.id !== event.result.triggeringCallId
  ) {
    return null;
  }
  return validateSnapshot({
    ...snapshot,
    generatedAt: event.occurredAt,
    lastEventSequence: event.eventSequence,
    round: {
      id: snapshot.round.id,
      lobbyId: snapshot.round.lobbyId,
      patternId: snapshot.round.patternId,
      callConfiguration: snapshot.round.callConfiguration,
      startedAt: snapshot.round.startedAt,
      stage: "result",
      result: event.result,
    },
    timer: null,
  });
}

function callConfigurationMatches(actual: CallConfiguration, expected: CallConfiguration): boolean {
  return (
    actual.mode === expected.mode &&
    (actual.mode === "manual" ||
      (expected.mode === "automatic" && actual.intervalSeconds === expected.intervalSeconds))
  );
}

function snapshotConfirmsCommand(
  snapshot: Snapshot,
  pending: PendingCommandReconciliation,
): boolean {
  if (snapshot.lastEventSequence === null || snapshot.lastEventSequence < pending.eventSequence) {
    return false;
  }
  if (snapshot.lastEventSequence > pending.eventSequence) return true;
  if (
    pending.command.type !== "override-absence" &&
    (pending.roundId === null || snapshot.round?.id !== pending.roundId)
  ) {
    return false;
  }
  switch (pending.command.type) {
    case "configure":
      return (
        snapshot.round?.patternId === pending.command.patternId &&
        callConfigurationMatches(
          snapshot.round.callConfiguration,
          pending.command.callConfiguration,
        )
      );
    case "start-round":
      return snapshot.round !== null && snapshot.round.stage !== "waiting";
    case "pause-round":
      return snapshot.round?.stage === "paused";
    case "resume-round":
      return snapshot.round?.stage === "active";
    case "call-next":
      return snapshot.calls.length > pending.startingCallCount;
    case "continue-round":
      return (
        (snapshot.round?.stage === "active" || snapshot.round?.stage === "result") &&
        snapshot.round.patternId === pending.command.patternId
      );
    case "end-round":
      return snapshot.round?.stage === "ended";
    case "override-absence": {
      const command = pending.command as Extract<WaitingLobbyCommand, { type: "override-absence" }>;
      const participant = snapshot.participants.find(({ id }) => id === command.participantId);
      return (
        participant?.presence.status === "absent" &&
        participant.presence.generation === command.presenceGeneration &&
        participant.presence.overridden
      );
    }
  }
}

function commandPendingMessage(command: WaitingLobbyCommand): string {
  switch (command.type) {
    case "configure":
      return "Saving lobby setup...";
    case "start-round":
      return "Starting the round...";
    case "pause-round":
      return "Pausing calling...";
    case "resume-round":
      return "Resuming calling...";
    case "call-next":
      return "Calling the next ball...";
    case "continue-round":
      return "Continuing the round...";
    case "end-round":
      return "Ending the round...";
    case "override-absence":
      return "Applying the absence override...";
  }
}

function commandSuccessMessage(command: WaitingLobbyCommand): string {
  switch (command.type) {
    case "configure":
      return "Lobby setup saved.";
    case "start-round":
      return "Round started.";
    case "pause-round":
      return "Calling paused.";
    case "resume-round":
      return "Calling resumed.";
    case "call-next":
      return "Next ball called.";
    case "continue-round":
      return "Round continued.";
    case "end-round":
      return "Round ended.";
    case "override-absence":
      return "Player absence override applied. Calling remains paused until you resume it.";
  }
}

function commandActionLabel(command: WaitingLobbyCommand): string {
  switch (command.type) {
    case "configure":
      return "Save setup";
    case "start-round":
      return "Start round";
    case "pause-round":
      return "Pause calling";
    case "resume-round":
      return "Resume calling";
    case "call-next":
      return "Call Next";
    case "continue-round":
      return "Continue round";
    case "end-round":
      return "End round";
    case "override-absence":
      return "absence override";
  }
}

function absenceOverrideState(
  snapshot: Snapshot,
  command: Extract<WaitingLobbyCommand, { type: "override-absence" }>,
): "pending" | "confirmed" | "stale" {
  const participant = snapshot.participants.find(({ id }) => id === command.participantId);
  if (
    participant?.presence.status !== "absent" ||
    participant.presence.generation !== command.presenceGeneration
  ) {
    return "stale";
  }
  return participant.presence.overridden ? "confirmed" : "pending";
}

function snapshotConfirmsMark(snapshot: Snapshot, pending: PendingMarkReconciliation): boolean {
  return (
    snapshot.ownCard?.id === pending.cardId &&
    snapshot.ownMarks.some((mark) => mark.ball === pending.ball) &&
    (pending.eventSequence === null ||
      (snapshot.lastEventSequence !== null && snapshot.lastEventSequence >= pending.eventSequence))
  );
}

function cardBallLabel(snapshot: Snapshot, ball: number): string {
  const index = snapshot.ownCard?.cells.findIndex((cell) => cell === ball) ?? -1;
  return index < 0 ? String(ball) : `${["B", "I", "N", "G", "O"][index % 5]} ${ball}`;
}

function snapshotErrorMessage(error: unknown): string {
  if (!(error instanceof PrivateLobbyFlowError)) {
    return "We could not load this private lobby. Try again.";
  }
  if (error.code === "UNAUTHORIZED") {
    return "Your private lobby session is not active on this device. Join or rejoin to continue.";
  }
  if (error.code === "NOT_FOUND" || error.code === "LOBBY_EXPIRED") {
    return "This lobby is unavailable or has expired.";
  }
  if (error.code === "RATE_LIMITED") {
    return "Too many lobby refreshes. Wait a moment, then try again.";
  }
  return error.message;
}

const defaultCreateCommandSession = (command: WaitingLobbyCommand) =>
  new WaitingLobbyCommandSession(command);
const defaultCreateMarkCommandSession = (command: MarkCardCommandSelection) =>
  new MarkCardCommandSession(command);

export function PrivateLobbyPage({
  code,
  patterns,
  loadSnapshot = loadPrivateLobbySnapshot,
  copyText,
  shareInvite,
  origin,
  createCommandSession = defaultCreateCommandSession,
  createMarkCommandSession = defaultCreateMarkCommandSession,
  connectRealtime,
  enableRealtime = false,
  realtimeServerUrl,
}: PrivateLobbyPageProps) {
  const codeRef = useRef<HTMLInputElement>(null);
  const inviteRef = useRef<HTMLInputElement>(null);
  const commandSessionRef = useRef<{
    command: WaitingLobbyCommand;
    key: string;
    roundId: string | null;
    runner: ReturnType<NonNullable<PrivateLobbyPageProps["createCommandSession"]>>;
    startingCallCount: number;
  } | null>(null);
  const commandPendingRef = useRef(false);
  const markCommandPendingRef = useRef(false);
  const markCommandSessionRef = useRef<{
    ball: number;
    cardId: string;
    runner: ReturnType<NonNullable<PrivateLobbyPageProps["createMarkCommandSession"]>>;
  } | null>(null);
  const loadGenerationRef = useRef(0);
  const terminalDeliveryClosedRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<Snapshot | null> | null>(null);
  const pendingCommandRef = useRef<PendingCommandReconciliation | null>(null);
  const pendingMarkRef = useRef<PendingMarkReconciliation | null>(null);
  const unresolvedMarkRef = useRef<UnresolvedMark | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const liveConnectionRef = useRef<PrivateLobbyRealtimeConnection | null>(null);
  const resyncRequestedRef = useRef(false);
  const recoveringRef = useRef(false);
  const connectionStateRef = useRef<PrivateLobbyConnectionState>("snapshot-syncing");
  const outcomeAnnouncementIdentityRef = useRef<string | null>(null);
  const callHistoryRef = useRef<HTMLOListElement>(null);
  const followCallHistoryRef = useRef(true);
  const liveGameHeadingRef = useRef<HTMLHeadingElement>(null);
  const outcomeHeadingRef = useRef<HTMLHeadingElement>(null);
  const setupHeadingRef = useRef<HTMLHeadingElement>(null);
  const hostControlsRef = useRef<HTMLElement>(null);
  const cardPanelRef = useRef<HTMLElement>(null);
  const hostControlsHeadingRef = useRef<HTMLHeadingElement>(null);
  const terminalHeadingRef = useRef<HTMLHeadingElement>(null);
  const terminalFocusedRef = useRef(false);
  const callNextButtonRef = useRef<HTMLButtonElement>(null);
  const endRoundButtonRef = useRef<HTMLButtonElement>(null);
  const endRoundCancelRef = useRef<HTMLButtonElement>(null);
  const endRoundDialogRef = useRef<HTMLDialogElement>(null);
  const endConfirmationRoundIdRef = useRef<string | null>(null);
  const setupDirtyRef = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotMessage, setSnapshotMessage] = useState("Loading private lobby...");
  const [snapshotErrorCode, setSnapshotErrorCode] = useState<string | undefined>();
  const [snapshotErrorRetryable, setSnapshotErrorRetryable] = useState(true);
  const [snapshotPending, setSnapshotPending] = useState(true);
  const [shareMessage, setShareMessage] = useState("");
  const [commandMessage, setCommandMessage] = useState("");
  const [commandPending, setCommandPending] = useState(false);
  const [markMessage, setMarkMessage] = useState("");
  const [markPendingBall, setMarkPendingBall] = useState<number | null>(null);
  const [unresolvedMark, setUnresolvedMark] = useState<UnresolvedMark | null>(null);
  const [patternId, setPatternId] = useState("");
  const [callMode, setCallMode] = useState<CallConfiguration["mode"]>("manual");
  const [interval, setInterval] = useState("30");
  const [setupDirty, setSetupDirty] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<PendingCommandReconciliation | null>(null);
  const [unresolvedCommand, setUnresolvedCommand] = useState<WaitingLobbyCommand | null>(null);
  const [resolvedOrigin, setResolvedOrigin] = useState(origin ?? "");
  const [nativeShare, setNativeShare] = useState<NonNullable<typeof shareInvite> | null>(null);
  const [connectionState, setConnectionState] =
    useState<PrivateLobbyConnectionState>("snapshot-syncing");
  const [callAnnouncement, setCallAnnouncement] = useState("");
  const [outcomeAnnouncement, setOutcomeAnnouncement] = useState("");
  const [endConfirmationOpen, setEndConfirmationOpen] = useState(false);
  const [restoreEndRoundFocus, setRestoreEndRoundFocus] = useState(false);
  const [loadedThemeSpriteUrl, setLoadedThemeSpriteUrl] = useState<string | null>(null);
  const [commandFocusTarget, setCommandFocusTarget] = useState<
    "host-controls" | "live-game" | "outcome" | "setup" | null
  >(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const terminalUnavailable =
    snapshot === null &&
    !snapshotPending &&
    (snapshotErrorCode === "NOT_FOUND" || snapshotErrorCode === "LOBBY_EXPIRED");

  function setSetupDraftDirty(dirty: boolean) {
    setupDirtyRef.current = dirty;
    setSetupDirty(dirty);
  }

  function transitionConnectionState(state: PrivateLobbyConnectionState) {
    const wasReady =
      connectionStateRef.current === "connected" || connectionStateRef.current === "recovered";
    const isReady = state === "connected" || state === "recovered";
    const activeElement = document.activeElement;
    if (
      wasReady &&
      !isReady &&
      hostControlsRef.current !== null &&
      activeElement !== null &&
      hostControlsRef.current.contains(activeElement)
    ) {
      setCommandFocusTarget("host-controls");
    }
    connectionStateRef.current = state;
    setConnectionState(state);
  }

  function reconcileOutcomeAnnouncement(next: Snapshot, clear = false) {
    if (clear || outcomeIdentityFor(next) !== outcomeAnnouncementIdentityRef.current) {
      outcomeAnnouncementIdentityRef.current = null;
      setOutcomeAnnouncement("");
    }
  }

  function reconcilePendingState(
    next: Snapshot,
    previous: Snapshot | null,
  ): PendingCommandReconciliation | null {
    const activeElement = document.activeElement;
    const hostControlsHadFocus =
      hostControlsRef.current !== null &&
      activeElement !== null &&
      hostControlsRef.current.contains(activeElement);
    const cardHadFocus =
      cardPanelRef.current !== null &&
      activeElement !== null &&
      cardPanelRef.current.contains(activeElement);
    const focusedHostAction =
      activeElement instanceof HTMLElement ? activeElement.dataset["hostAction"] : undefined;
    const nextHostAuthorityUnavailable =
      next.self.presence.status !== "connected" ||
      (enableRealtime &&
        connectionStateRef.current !== "connected" &&
        connectionStateRef.current !== "recovered");
    const nextBlockingAbsentPlayer = next.participants.some(
      (participant) =>
        participant.role === "player" &&
        participant.roundEligibility === "playing" &&
        participant.presence.status === "absent" &&
        !participant.presence.overridden,
    );
    const focusedHostActionUnavailable = (() => {
      if (focusedHostAction === undefined) return false;
      if (nextHostAuthorityUnavailable) return true;
      switch (focusedHostAction) {
        case "pause-round":
          return next.round?.stage !== "active";
        case "resume-round":
          return next.round?.stage !== "paused" || nextBlockingAbsentPlayer;
        case "call-next":
          return (
            next.round?.stage !== "active" || next.calls.length >= 75 || nextBlockingAbsentPlayer
          );
        case "continue-round":
          return (
            next.round?.stage !== "result" ||
            next.round.continuationPatternId !== activeElement?.getAttribute("data-pattern-id") ||
            nextBlockingAbsentPlayer
          );
        case "end-round":
          return (
            next.round?.stage !== "active" &&
            next.round?.stage !== "paused" &&
            next.round?.stage !== "result"
          );
        case "override-absence": {
          const participant = next.participants.find(
            ({ id }) => id === activeElement?.getAttribute("data-participant-id"),
          );
          return !(
            participant?.role === "player" &&
            participant.roundEligibility === "playing" &&
            participant.presence.status === "absent" &&
            !participant.presence.overridden &&
            String(participant.presence.generation) ===
              activeElement?.getAttribute("data-presence-generation")
          );
        }
        default:
          return false;
      }
    })();
    const roundStageChanged =
      previous?.round?.id !== next.round?.id || previous?.round?.stage !== next.round?.stage;
    const focusedCardIndex =
      cardHadFocus && activeElement instanceof HTMLButtonElement
        ? Array.from(
            cardPanelRef.current?.querySelectorAll<HTMLButtonElement>(".bingo-card-cell") ?? [],
          ).indexOf(activeElement)
        : -1;
    const focusedCardBall = previous?.ownCard?.cells[focusedCardIndex];
    const acknowledgedMark = pendingMarkRef.current;
    const focusedCardHasPendingMark =
      typeof focusedCardBall === "number" &&
      (markCommandSessionRef.current?.ball === focusedCardBall ||
        (acknowledgedMark !== null &&
          acknowledgedMark.cardId === previous?.ownCard?.id &&
          acknowledgedMark.ball === focusedCardBall));
    const focusedCardControlWasAvailable =
      cardHadFocus &&
      activeElement instanceof HTMLButtonElement &&
      ((!activeElement.disabled && activeElement.getAttribute("aria-disabled") !== "true") ||
        focusedCardHasPendingMark);
    const cardBecameUnavailable =
      focusedCardControlWasAvailable &&
      previous?.round !== null &&
      previous?.round?.stage !== "waiting" &&
      previous?.round?.stage !== "result" &&
      previous?.round?.stage !== "ended" &&
      (next.round?.stage === "waiting" ||
        next.round?.stage === "result" ||
        next.round?.stage === "ended");
    if (cardBecameUnavailable) {
      setCommandFocusTarget(
        next.round?.stage === "result" || next.round?.stage === "ended" ? "outcome" : "live-game",
      );
    } else if (hostControlsHadFocus && (roundStageChanged || focusedHostActionUnavailable)) {
      setCommandFocusTarget(
        (focusedHostAction === "continue-round" && next.round?.stage === "result") ||
          next.round?.stage === "co-winner-window" ||
          next.round?.stage === "result" ||
          next.round?.stage === "ended"
          ? "outcome"
          : next.round?.stage === "active" || next.round?.stage === "paused"
            ? "host-controls"
            : "live-game",
      );
    }
    const retainedCommand = commandSessionRef.current;
    const focusedCommandRetry = focusedHostAction === "retry-command";
    if (!commandPendingRef.current && retainedCommand !== null) {
      if (retainedCommand.command.type === "override-absence") {
        const state = absenceOverrideState(next, retainedCommand.command);
        if (state !== "pending") {
          commandSessionRef.current = null;
          setUnresolvedCommand(null);
          setCommandMessage(
            state === "confirmed"
              ? commandSuccessMessage(retainedCommand.command)
              : "The participant's absence changed. The prior command will not be replayed.",
          );
        }
      } else if (retainedCommand.roundId !== null && retainedCommand.roundId !== next.round?.id) {
        commandSessionRef.current = null;
        setUnresolvedCommand(null);
        setCommandMessage(
          "The prior command belongs to a previous round and will not be replayed.",
        );
      }
    }
    if (focusedCommandRetry && commandSessionRef.current === null) {
      setCommandFocusTarget(
        next.round?.stage === "co-winner-window" ||
          next.round?.stage === "result" ||
          next.round?.stage === "ended"
          ? "outcome"
          : next.round?.stage === "active" || next.round?.stage === "paused"
            ? "host-controls"
            : "live-game",
      );
    }
    const pending = pendingCommandRef.current;
    const confirmedCommand =
      pending !== null && snapshotConfirmsCommand(next, pending) ? pending : null;
    if (confirmedCommand !== null) {
      pendingCommandRef.current = null;
      setPendingCommand(null);
      setCommandMessage(
        next.lastEventSequence !== null && next.lastEventSequence > confirmedCommand.eventSequence
          ? "Command committed. The lobby has since advanced."
          : commandSuccessMessage(confirmedCommand.command),
      );
      if (confirmedCommand.command.type === "end-round") {
        setCommandFocusTarget(next.round?.stage === "ended" ? "outcome" : "live-game");
      } else if (confirmedCommand.command.type === "continue-round") {
        setCommandFocusTarget(next.round?.stage === "result" ? "outcome" : "host-controls");
      } else if (
        confirmedCommand.command.type === "start-round" ||
        confirmedCommand.command.type === "pause-round" ||
        confirmedCommand.command.type === "resume-round" ||
        confirmedCommand.command.type === "override-absence"
      ) {
        setCommandFocusTarget("host-controls");
      } else if (
        confirmedCommand.command.type === "call-next" &&
        (next.round?.stage !== "active" || next.calls.length >= 75)
      ) {
        setCommandFocusTarget(
          next.round?.stage === "co-winner-window" || next.round?.stage === "result"
            ? "outcome"
            : next.round?.stage === "active" || next.round?.stage === "paused"
              ? "host-controls"
              : "live-game",
        );
      }
    }
    const retainedMark = markCommandSessionRef.current;
    if (retainedMark !== null) {
      if (next.ownCard?.id !== retainedMark.cardId) {
        markCommandSessionRef.current = null;
        unresolvedMarkRef.current = null;
        setUnresolvedMark(null);
        setMarkPendingBall(null);
        setMarkMessage("Your card changed. The prior mark command will not be replayed.");
      } else if (next.ownMarks.some((mark) => mark.ball === retainedMark.ball)) {
        markCommandSessionRef.current = null;
        unresolvedMarkRef.current = null;
        setUnresolvedMark(null);
        setMarkPendingBall(null);
        setMarkMessage(`${cardBallLabel(next, retainedMark.ball)} marked.`);
      }
    }
    const pendingMark = pendingMarkRef.current;
    if (pendingMark !== null) {
      if (next.ownCard?.id !== pendingMark.cardId) {
        pendingMarkRef.current = null;
        setMarkPendingBall(null);
        setMarkMessage("The round changed before the prior card mark could be shown.");
      } else if (snapshotConfirmsMark(next, pendingMark)) {
        pendingMarkRef.current = null;
        setMarkPendingBall(null);
        setMarkMessage(`${cardBallLabel(next, pendingMark.ball)} marked.`);
      }
    }
    const marksUnavailable =
      next.round === null ||
      next.round.stage === "waiting" ||
      next.round.stage === "result" ||
      next.round.stage === "ended";
    if (
      marksUnavailable &&
      (markCommandSessionRef.current !== null ||
        pendingMarkRef.current !== null ||
        unresolvedMarkRef.current !== null)
    ) {
      markCommandSessionRef.current = null;
      pendingMarkRef.current = null;
      unresolvedMarkRef.current = null;
      setUnresolvedMark(null);
      setMarkPendingBall(null);
      setMarkMessage(
        next.round?.stage === "result" || next.round?.stage === "ended"
          ? "The round settled before the prior mark could be confirmed."
          : "The round changed before the prior mark could be confirmed.",
      );
    }
    return confirmedCommand;
  }

  async function refreshSnapshot(
    message = "Loading private lobby...",
    options: { mandatory?: boolean; syncSetup?: boolean } = {},
  ): Promise<Snapshot | null> {
    if (terminalDeliveryClosedRef.current) return null;
    if (refreshPendingRef.current) {
      if (options.mandatory !== true) return refreshPromiseRef.current;
      await refreshPromiseRef.current;
      if (terminalDeliveryClosedRef.current) return null;
    }

    const refresh = (async () => {
      refreshPendingRef.current = true;
      const generation = ++loadGenerationRef.current;
      setSnapshotPending(true);
      setSnapshotMessage(message);
      try {
        const received = await loadSnapshot(code);
        if (loadGenerationRef.current !== generation || terminalDeliveryClosedRef.current) {
          return null;
        }
        const liveSnapshot = snapshotRef.current;
        const stale =
          liveSnapshot !== null &&
          (received.lastEventSequence ?? 0) < (liveSnapshot.lastEventSequence ?? 0);
        const next = stale ? liveSnapshot : mergeAppendOnlyMarks(liveSnapshot, received);
        if (next === null) {
          throw new Error("The private lobby snapshot is inconsistent.");
        }
        if (!stale) {
          snapshotRef.current = next;
          setSnapshot(next);
        }
        reconcileOutcomeAnnouncement(next);
        const confirmedCommand = reconcilePendingState(next, liveSnapshot);
        if (
          options.syncSetup === true ||
          snapshot === null ||
          !setupDirtyRef.current ||
          confirmedCommand?.command.type === "configure"
        ) {
          setPatternId(next.round?.patternId ?? "");
          setCallMode(next.round?.callConfiguration.mode ?? "manual");
          setInterval(
            next.round?.callConfiguration.mode === "automatic"
              ? String(next.round.callConfiguration.intervalSeconds)
              : "30",
          );
          setSetupDraftDirty(false);
        }
        setSnapshotErrorCode(undefined);
        setSnapshotErrorRetryable(true);
        setSnapshotMessage("");
        return next;
      } catch (error) {
        if (loadGenerationRef.current !== generation) return null;
        const flowError = error instanceof PrivateLobbyFlowError ? error : null;
        setSnapshotErrorCode(flowError?.code);
        setSnapshotErrorRetryable(flowError?.retryable ?? true);
        setSnapshotMessage(snapshotErrorMessage(error));
        if (
          flowError?.retryable === false &&
          (flowError.code === "UNAUTHORIZED" ||
            flowError.code === "NOT_FOUND" ||
            flowError.code === "LOBBY_EXPIRED")
        ) {
          terminalDeliveryClosedRef.current = true;
          liveConnectionRef.current?.close();
          liveConnectionRef.current = null;
          setSnapshot(null);
          snapshotRef.current = null;
        }
        if (options.mandatory === true) throw error;
        return null;
      } finally {
        if (loadGenerationRef.current === generation) {
          refreshPendingRef.current = false;
          refreshPromiseRef.current = null;
          setSnapshotPending(false);
        }
      }
    })();
    refreshPromiseRef.current = refresh;
    return refresh;
  }

  useEffect(() => {
    terminalDeliveryClosedRef.current = false;
    terminalFocusedRef.current = false;
  }, [code]);

  useEffect(() => {
    void refreshSnapshot("Loading private lobby...", { syncSetup: true });
    return () => {
      loadGenerationRef.current += 1;
      refreshPendingRef.current = false;
      refreshPromiseRef.current = null;
    };
  }, [code, loadSnapshot]);

  useEffect(() => {
    if (origin === undefined && typeof window !== "undefined") {
      setResolvedOrigin(window.location.origin);
    }
    if (
      shareInvite === undefined &&
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
      setNativeShare(() => navigator.share.bind(navigator));
    } else {
      setNativeShare(() => shareInvite ?? null);
    }
  }, [origin, shareInvite]);

  useEffect(() => {
    if (!enableRealtime || snapshot === null || liveConnectionRef.current !== null) {
      return;
    }
    const requestResync = (lastEventSequence: number | null) => {
      if (resyncRequestedRef.current) return;
      resyncRequestedRef.current = true;
      transitionConnectionState("snapshot-syncing");
      liveConnectionRef.current?.requestResync(lastEventSequence);
    };
    const handlers: PrivateLobbyRealtimeHandlers = {
      onConnectionState(state, errorCode) {
        if (terminalDeliveryClosedRef.current) return;
        outcomeAnnouncementIdentityRef.current = null;
        setOutcomeAnnouncement("");
        if (state === "offline" || state === "reconnecting") recoveringRef.current = true;
        if (state === "expired") {
          const unavailable = errorCode === "NOT_FOUND" || errorCode === "LOBBY_EXPIRED";
          terminalDeliveryClosedRef.current = true;
          loadGenerationRef.current += 1;
          refreshPendingRef.current = false;
          refreshPromiseRef.current = null;
          liveConnectionRef.current?.close();
          liveConnectionRef.current = null;
          snapshotRef.current = null;
          setSnapshot(null);
          setSnapshotErrorCode(unavailable ? errorCode : "UNAUTHORIZED");
          setSnapshotErrorRetryable(false);
          setSnapshotMessage(
            unavailable
              ? "This lobby is unavailable or has expired."
              : "Your private lobby session is not active on this device. Join or rejoin to continue.",
          );
          setSnapshotPending(false);
        }
        transitionConnectionState(state);
      },
      onLobbyEvent(event) {
        if (terminalDeliveryClosedRef.current) return;
        const current = snapshotRef.current;
        if (current === null) return;
        const baseline = current.lastEventSequence ?? 0;
        if (event.eventSequence <= baseline) return;
        if (event.eventSequence !== baseline + 1) {
          requestResync(current.lastEventSequence);
          return;
        }
        const next = applyLobbyEvent(current, event);
        if (next === null) {
          requestResync(current.lastEventSequence);
          return;
        }
        snapshotRef.current = next;
        setSnapshot(next);
        reconcilePendingState(next, current);
        const requiresAutomaticTimer =
          next.round?.stage === "active" && next.round.callConfiguration.mode === "automatic";
        if (event.type === "call") {
          setCallAnnouncement(`New call: ${ballLabel(event.call.ball)}`);
        }
        if (event.type === "co-winner-window") {
          outcomeAnnouncementIdentityRef.current = outcomeIdentityFor(next);
          setOutcomeAnnouncement(
            `Checking for co-winners during the full ${coWinnerDurationLabel(event.window.openedAt, event.window.closesAt)} window.`,
          );
        } else if (event.type === "round-end") {
          outcomeAnnouncementIdentityRef.current = outcomeIdentityFor(next);
          setOutcomeAnnouncement(
            event.round.result === null
              ? "Round ended."
              : "Round ended. The confirmed result remains visible.",
          );
        } else if (event.type === "co-winner-result" || event.type === "stage") {
          outcomeAnnouncementIdentityRef.current = outcomeIdentityFor(next);
          setOutcomeAnnouncement(resultAnnouncementFor(next) ?? "");
        } else {
          reconcileOutcomeAnnouncement(next);
        }
        if (requiresAutomaticTimer && (event.type === "call" || event.type === "stage")) {
          requestResync(event.eventSequence);
        }
        if (event.type === "co-winner-result") requestResync(event.eventSequence);
      },
      onPrivateEvent(event: ParticipantPrivateEvent) {
        if (terminalDeliveryClosedRef.current) return;
        const current = snapshotRef.current;
        if (current === null) return;
        if (event.type === "near-win") {
          setMarkMessage(`Near win: ${ballLabel(event.requiredBall)} is still needed.`);
          return;
        }
        if (current.ownCard?.id !== event.mark.cardId) {
          requestResync(current.lastEventSequence);
          return;
        }
        if (
          current.ownMarks.some(({ id, ball }) => id === event.mark.id || ball === event.mark.ball)
        ) {
          return;
        }
        const next = validateSnapshot({
          ...current,
          generatedAt: event.occurredAt,
          ownMarks: [...current.ownMarks, event.mark],
        });
        if (next === null) {
          requestResync(current.lastEventSequence);
          return;
        }
        snapshotRef.current = next;
        setSnapshot(next);
        reconcilePendingState(next, current);
      },
      onSnapshot(next) {
        if (terminalDeliveryClosedRef.current) return;
        const current = snapshotRef.current;
        if (current !== null && (next.lastEventSequence ?? 0) < (current.lastEventSequence ?? 0)) {
          requestResync(current.lastEventSequence);
          return;
        }
        const accepted = mergeAppendOnlyMarks(current, next);
        if (accepted === null) {
          requestResync(current?.lastEventSequence ?? null);
          return;
        }
        const recovering = recoveringRef.current;
        const roundChanged = current?.round?.id !== accepted.round?.id;
        snapshotRef.current = accepted;
        resyncRequestedRef.current = false;
        setSnapshot(accepted);
        const confirmedCommand = reconcilePendingState(accepted, current);
        if (confirmedCommand?.command.type === "configure") {
          setPatternId(accepted.round?.patternId ?? "");
          setCallMode(accepted.round?.callConfiguration.mode ?? "manual");
          setInterval(
            accepted.round?.callConfiguration.mode === "automatic"
              ? String(accepted.round.callConfiguration.intervalSeconds)
              : "30",
          );
          setSetupDraftDirty(false);
        }
        if (recovering || roundChanged) setCallAnnouncement("");
        reconcileOutcomeAnnouncement(accepted, recovering || roundChanged);
        if (roundChanged) followCallHistoryRef.current = true;
        const readyState = recovering ? "recovered" : "connected";
        transitionConnectionState(readyState);
        recoveringRef.current = false;
      },
    };
    liveConnectionRef.current =
      connectRealtime?.(handlers) ??
      connectPrivateLobbyRealtime({
        code,
        handlers,
        ...(realtimeServerUrl === undefined ? {} : { serverUrl: realtimeServerUrl }),
      });
  }, [code, connectRealtime, enableRealtime, realtimeServerUrl, snapshot]);

  useEffect(
    () => () => {
      liveConnectionRef.current?.close();
      liveConnectionRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (snapshot?.timer?.kind !== "automatic-call") return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [snapshot?.timer]);

  useEffect(() => {
    const history = callHistoryRef.current;
    if (history !== null && followCallHistoryRef.current) history.scrollTop = history.scrollHeight;
  }, [snapshot?.calls.length, snapshot?.round?.id]);

  useEffect(() => {
    if (!endConfirmationOpen) return;
    const dialog = endRoundDialogRef.current;
    if (dialog !== null && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    endRoundCancelRef.current?.focus();
  }, [endConfirmationOpen]);

  useEffect(() => {
    if (
      endConfirmationOpen &&
      (snapshot?.self.presence.status !== "connected" ||
        (enableRealtime && connectionState !== "connected" && connectionState !== "recovered"))
    ) {
      endRoundCancelRef.current?.focus();
    }
  }, [connectionState, enableRealtime, endConfirmationOpen, snapshot?.self.presence.status]);

  useEffect(() => {
    if (
      endConfirmationOpen &&
      (snapshot?.round?.id !== endConfirmationRoundIdRef.current ||
        (snapshot.round.stage !== "active" &&
          snapshot.round.stage !== "paused" &&
          snapshot.round.stage !== "result"))
    ) {
      endConfirmationRoundIdRef.current = null;
      setEndConfirmationOpen(false);
      setCommandFocusTarget(
        snapshot?.round?.stage === "co-winner-window" ||
          snapshot?.round?.stage === "result" ||
          snapshot?.round?.stage === "ended"
          ? "outcome"
          : "live-game",
      );
    }
  }, [endConfirmationOpen, snapshot?.round?.id, snapshot?.round?.stage]);

  useEffect(() => {
    if (endConfirmationOpen || !restoreEndRoundFocus) return;
    if (endRoundButtonRef.current?.disabled === false) endRoundButtonRef.current.focus();
    else hostControlsHeadingRef.current?.focus();
    setRestoreEndRoundFocus(false);
  }, [endConfirmationOpen, restoreEndRoundFocus]);

  useEffect(() => {
    if (commandFocusTarget === null) return;
    const target =
      commandFocusTarget === "host-controls"
        ? hostControlsHeadingRef.current
        : commandFocusTarget === "outcome"
          ? outcomeHeadingRef.current
          : commandFocusTarget === "setup"
            ? setupHeadingRef.current
            : liveGameHeadingRef.current;
    target?.focus();
    setCommandFocusTarget(null);
  }, [commandFocusTarget, snapshot?.round?.stage]);

  useEffect(() => {
    if (!terminalUnavailable) {
      terminalFocusedRef.current = false;
      return;
    }
    liveConnectionRef.current?.close();
    liveConnectionRef.current = null;
    if (!terminalFocusedRef.current) {
      terminalFocusedRef.current = true;
      terminalHeadingRef.current?.focus();
    }
  }, [terminalUnavailable]);

  const inviteUrl = resolvedOrigin
    ? (() => {
        const url = new URL("/", resolvedOrigin);
        url.searchParams.set("code", code);
        url.hash = "join-lobby";
        return url.toString();
      })()
    : "";

  async function copy(value: string, fallback: HTMLInputElement | null, label: string) {
    try {
      if (copyText !== undefined) {
        await copyText(value);
      } else if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(value);
      } else {
        throw new Error("Clipboard unavailable.");
      }
      setShareMessage(`${label} copied.`);
    } catch {
      fallback?.focus();
      fallback?.select();
      setShareMessage(`Select the ${label.toLowerCase()} and copy it manually.`);
    }
  }

  async function runCommand(
    command: WaitingLobbyCommand,
    pendingMessage = commandPendingMessage(command),
  ) {
    if (commandPendingRef.current) return;
    const commandRetryHadFocus =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset["hostAction"] === "retry-command";
    const key = JSON.stringify(command);
    const retainedCommand = commandSessionRef.current;
    if (
      retainedCommand?.key === key &&
      command.type === "override-absence" &&
      snapshotRef.current !== null
    ) {
      const state = absenceOverrideState(snapshotRef.current, command);
      if (state !== "pending") {
        commandSessionRef.current = null;
        setUnresolvedCommand(null);
        setCommandMessage(
          state === "confirmed"
            ? commandSuccessMessage(command)
            : "The participant's absence changed. The prior command will not be replayed.",
        );
        return;
      }
    }
    if (
      retainedCommand?.key === key &&
      command.type !== "override-absence" &&
      retainedCommand.roundId !== null &&
      retainedCommand.roundId !== snapshotRef.current?.round?.id
    ) {
      commandSessionRef.current = null;
      setUnresolvedCommand(null);
      setCommandMessage("The prior command belongs to a previous round and will not be replayed.");
      return;
    }
    commandPendingRef.current = true;
    if (commandSessionRef.current?.key !== key) {
      commandSessionRef.current = {
        command,
        key,
        roundId: snapshotRef.current?.round?.id ?? null,
        runner: createCommandSession(command),
        startingCallCount: snapshotRef.current?.calls.length ?? 0,
      };
    }
    const session = commandSessionRef.current;
    setCommandPending(true);
    setCommandMessage(pendingMessage);
    let acknowledgement: WaitingLobbyCommandAck;
    try {
      acknowledgement = await session.runner.run();
      commandSessionRef.current = null;
      setUnresolvedCommand(null);
      if (commandRetryHadFocus) {
        const currentStage = snapshotRef.current?.round?.stage;
        setCommandFocusTarget(
          command.type === "start-round" && currentStage === "waiting"
            ? "setup"
            : currentStage === "co-winner-window" ||
                currentStage === "result" ||
                currentStage === "ended"
              ? "outcome"
              : currentStage === "active" || currentStage === "paused"
                ? "host-controls"
                : "live-game",
        );
      }
    } catch (error) {
      const flowError =
        error instanceof PrivateLobbyFlowError
          ? error
          : new PrivateLobbyFlowError("We could not confirm the command response.", {
              ambiguous: true,
            });
      let resultMessage = flowError.message;
      if (flowError.ambiguous || flowError.retryable) {
        const latest = snapshotRef.current;
        if (command.type === "override-absence" && latest !== null) {
          const state = absenceOverrideState(latest, command);
          if (state === "pending") {
            setUnresolvedCommand(command);
          } else {
            commandSessionRef.current = null;
            setUnresolvedCommand(null);
            resultMessage =
              state === "confirmed"
                ? commandSuccessMessage(command)
                : "The participant's absence changed. The prior command will not be replayed.";
          }
        } else if (
          command.type !== "override-absence" &&
          session.roundId !== null &&
          session.roundId !== latest?.round?.id
        ) {
          commandSessionRef.current = null;
          setUnresolvedCommand(null);
          resultMessage = "The prior command belongs to a previous round and will not be replayed.";
        } else {
          setUnresolvedCommand(command);
        }
      } else {
        commandSessionRef.current = null;
        setUnresolvedCommand(null);
      }
      if (commandRetryHadFocus && commandSessionRef.current === null) {
        const currentStage = snapshotRef.current?.round?.stage;
        setCommandFocusTarget(
          command.type === "start-round" && currentStage === "waiting"
            ? "setup"
            : currentStage === "co-winner-window" ||
                currentStage === "result" ||
                currentStage === "ended"
              ? "outcome"
              : currentStage === "active" || currentStage === "paused"
                ? "host-controls"
                : "live-game",
        );
      }
      setCommandMessage(resultMessage);
      commandPendingRef.current = false;
      setCommandPending(false);
      return;
    }

    const pending = {
      command,
      eventSequence: acknowledgement.eventSequence,
      roundId: session.roundId,
      startingCallCount: session.startingCallCount,
    };
    pendingCommandRef.current = pending;
    setPendingCommand(pending);
    setCommandMessage("Command committed. Refreshing the lobby...");
    try {
      const next = await refreshSnapshot("Refreshing the lobby...", { mandatory: true });
      if (next === null || !snapshotConfirmsCommand(next, pending)) {
        throw new Error("The refreshed snapshot did not include the command.");
      }

      if (command.type === "configure") {
        setPatternId(next.round?.patternId ?? "");
        setCallMode(next.round?.callConfiguration.mode ?? "manual");
        setInterval(
          next.round?.callConfiguration.mode === "automatic"
            ? String(next.round.callConfiguration.intervalSeconds)
            : "30",
        );
        setSetupDraftDirty(false);
      }
      setCommandMessage(
        next.lastEventSequence !== null && next.lastEventSequence > pending.eventSequence
          ? "Command committed. The lobby has since advanced."
          : commandSuccessMessage(command),
      );
    } catch {
      setCommandMessage(
        "The command committed, but we could not confirm the latest lobby state. Refresh the lobby.",
      );
    } finally {
      commandPendingRef.current = false;
      setCommandPending(false);
    }
  }

  function saveSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      commandPendingRef.current ||
      pendingCommandRef.current !== null ||
      hostAuthorityUnavailable ||
      (unresolvedCommand !== null && unresolvedCommand.type !== "configure")
    ) {
      return;
    }
    const callConfiguration: CallConfiguration =
      callMode === "manual"
        ? { mode: "manual" }
        : { mode: "automatic", intervalSeconds: intervalFromValue(interval) };
    void runCommand(
      { type: "configure", code, patternId, callConfiguration },
      "Saving lobby setup...",
    );
  }

  async function markCard(ball: number) {
    const currentSnapshot = snapshot;
    if (
      markCommandPendingRef.current ||
      pendingMarkRef.current !== null ||
      currentSnapshot === null ||
      currentSnapshot.ownCard === null
    ) {
      return;
    }
    const card = currentSnapshot.ownCard;
    const unresolved = unresolvedMarkRef.current;
    if (unresolved !== null && (unresolved.ball !== ball || unresolved.cardId !== card.id)) {
      return;
    }

    markCommandPendingRef.current = true;
    const retainedSession = markCommandSessionRef.current;
    if (
      retainedSession !== null &&
      (retainedSession.ball !== ball || retainedSession.cardId !== card.id)
    ) {
      markCommandPendingRef.current = false;
      return;
    }
    const session =
      retainedSession ??
      ({
        ball,
        cardId: card.id,
        runner: createMarkCommandSession({ ball, code }),
      } satisfies NonNullable<typeof markCommandSessionRef.current>);
    markCommandSessionRef.current = session;
    unresolvedMarkRef.current = null;
    setUnresolvedMark(null);
    setMarkPendingBall(ball);
    setMarkMessage(`Marking ${cardBallLabel(currentSnapshot, ball)}...`);

    let acknowledgement: CommandAck;
    try {
      acknowledgement = await session.runner.run();
      if (markCommandSessionRef.current !== session) {
        markCommandPendingRef.current = false;
        return;
      }
      markCommandSessionRef.current = null;
    } catch (error) {
      if (markCommandSessionRef.current !== session) {
        markCommandPendingRef.current = false;
        return;
      }
      const flowError =
        error instanceof PrivateLobbyFlowError
          ? error
          : new PrivateLobbyFlowError("We could not confirm the mark response.", {
              ambiguous: true,
            });
      if (flowError.ambiguous || flowError.retryable) {
        const unresolvedMark = { ball, cardId: card.id };
        unresolvedMarkRef.current = unresolvedMark;
        setUnresolvedMark(unresolvedMark);
      } else {
        markCommandSessionRef.current = null;
      }
      setMarkPendingBall(null);
      setMarkMessage(flowError.message);
      markCommandPendingRef.current = false;
      return;
    }

    const pending: PendingMarkReconciliation = {
      ball,
      cardId: card.id,
      eventSequence:
        acknowledgement.scope === "active-lobby" ? acknowledgement.eventSequence : null,
    };
    pendingMarkRef.current = pending;
    setMarkMessage("Mark committed. Refreshing your card...");
    try {
      const next = await refreshSnapshot("Refreshing your card...", { mandatory: true });
      if (next === null || !snapshotConfirmsMark(next, pending)) {
        throw new Error("The refreshed snapshot did not include the mark.");
      }
    } catch {
      setMarkMessage(
        "The mark committed, but we could not confirm the latest card. Refresh the lobby.",
      );
    } finally {
      markCommandPendingRef.current = false;
    }
  }

  if (snapshot === null) {
    const unavailable = snapshotErrorCode === "NOT_FOUND" || snapshotErrorCode === "LOBBY_EXPIRED";
    if (terminalUnavailable) {
      return (
        <main className="private-lobby-shell">
          <section aria-labelledby="expired-lobby-heading" className="private-state-card">
            <p className="eyebrow">Private lobby closed</p>
            <h1 id="expired-lobby-heading" ref={terminalHeadingRef} tabIndex={-1}>
              This lobby has expired
            </h1>
            <p>
              This private lobby is no longer available. Expired lobbies and their associated game
              and session data cannot be restored.
            </p>
            <nav aria-label="Next steps" className="private-state-actions">
              <LinkButton href="/#create-lobby">Create a new lobby</LinkButton>
              <LinkButton href="/#join-lobby">Join another lobby</LinkButton>
            </nav>
          </section>
        </main>
      );
    }
    return (
      <main aria-busy={snapshotPending} className="private-lobby-shell">
        <section className="private-state-card">
          <p aria-live="polite" role="status">
            {snapshotMessage}
          </p>
          {!snapshotPending ? (
            <div className="private-state-actions">
              {!unavailable && snapshotErrorRetryable ? (
                <Button
                  onClick={() => void refreshSnapshot("Checking the lobby again...")}
                  type="button"
                >
                  Retry
                </Button>
              ) : null}
              {snapshotErrorCode === "UNAUTHORIZED" ? (
                <LinkButton href={`/?code=${code}#join-lobby`}>Join or rejoin</LinkButton>
              ) : (
                <LinkButton href="/">Return home</LinkButton>
              )}
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  const activeTheme = getTheme(snapshot.lobby.themeId);
  const themeName = activeTheme?.name;
  const themeStyle =
    activeTheme === undefined ? undefined : (themeCssVariables(activeTheme) as CSSProperties);
  const themeSpriteLoaded = loadedThemeSpriteUrl === activeTheme?.visuals.spriteUrl;
  const hostCanConfigure = snapshot.self.role === "host" && snapshot.round?.stage === "waiting";
  const selfConnected = snapshot.self.presence.status === "connected";
  const realtimeAuthorityUncertain =
    enableRealtime && connectionState !== "connected" && connectionState !== "recovered";
  const hostAuthorityUnavailable = !selfConnected || realtimeAuthorityUncertain;
  const blockingAbsentPlayer = snapshot.participants.some(
    (participant) =>
      participant.role === "player" &&
      participant.roundEligibility === "playing" &&
      participant.presence.status === "absent" &&
      !participant.presence.overridden,
  );
  const waitingControlsUnavailable =
    hostAuthorityUnavailable ||
    commandPending ||
    pendingCommand !== null ||
    unresolvedCommand !== null;
  const setupCommandUnavailable =
    hostAuthorityUnavailable ||
    commandPending ||
    pendingCommand !== null ||
    (unresolvedCommand !== null && unresolvedCommand.type !== "configure");
  const startUnavailable = waitingControlsUnavailable || setupDirty || blockingAbsentPlayer;
  const duplicatePatternNames = new Set(
    patterns.map(({ name }) => name).filter((name, index, names) => names.indexOf(name) !== index),
  );
  const selectedPattern = patterns.find((pattern) => pattern.id === snapshot.round?.patternId);
  const selectedPatternDefinition = patternCatalog.find(
    (pattern) => pattern.id === snapshot.round?.patternId,
  );
  const patternName =
    selectedPattern === undefined
      ? undefined
      : patternLabel(selectedPattern, duplicatePatternNames);
  const callDescription =
    snapshot.round?.callConfiguration.mode === "automatic"
      ? `Automatic every ${snapshot.round.callConfiguration.intervalSeconds} seconds`
      : "Manual calling";
  const latestCall = snapshot.calls.at(-1);
  const automaticCountdown =
    snapshot.round?.stage === "active" &&
    snapshot.round.callConfiguration.mode === "automatic" &&
    snapshot.timer?.kind === "automatic-call"
      ? Math.max(0, Math.ceil((Date.parse(snapshot.timer.deadline) - clockNow) / 1000))
      : null;
  const eligibleAbsences = snapshot.participants.filter(
    (participant) =>
      participant.role === "player" &&
      participant.roundEligibility === "playing" &&
      participant.presence.status === "absent" &&
      !participant.presence.overridden,
  );
  const roundStage = snapshot.round?.stage;
  const endedWithoutResult = snapshot.round?.stage === "ended" && snapshot.round.result === null;
  const settledResult =
    snapshot.round?.stage === "result"
      ? snapshot.round.result
      : snapshot.round?.stage === "ended"
        ? snapshot.round.result
        : null;
  const hasOutcome =
    roundStage === "co-winner-window" || settledResult !== null || endedWithoutResult;
  const showHostControls =
    snapshot.self.role === "host" &&
    (roundStage === "active" ||
      roundStage === "paused" ||
      roundStage === "result" ||
      eligibleAbsences.length > 0);
  const hostControlsUnavailable =
    hostAuthorityUnavailable ||
    commandPending ||
    pendingCommand !== null ||
    unresolvedCommand !== null;
  const canCallNext = roundStage === "active" && snapshot.calls.length < 75;
  const continuationPatternId =
    snapshot.round?.stage === "result" ? snapshot.round.continuationPatternId : null;
  const continuationPatternName =
    continuationPatternId === undefined || continuationPatternId === null
      ? null
      : (patternCatalog.find(({ id }) => id === continuationPatternId)?.name ??
        continuationPatternId);
  const resultPatternName =
    patternCatalog.find(({ id }) => id === snapshot.round?.patternId)?.name ??
    patternName ??
    "this pattern";
  const winners =
    settledResult?.winnerParticipantIds.flatMap((participantId) => {
      const participant = snapshot.participants.find(({ id }) => id === participantId);
      return participant === undefined ? [] : [participant];
    }) ?? [];
  const winnerNames = winners.map(({ username }) => username);
  const winnerNamesSentence = namesAsSentence(winnerNames);
  const selfWon = winners.some(({ id }) => id === snapshot.self.id);
  const hasContinuation = typeof continuationPatternId === "string";
  const nextStepPending = continuationPatternId === undefined;
  const resultSummary = endedWithoutResult
    ? "This round ended before a winner was confirmed."
    : selfWon
      ? `${resultPatternName} is complete. Congratulations, ${snapshot.self.username}.`
      : hasContinuation
        ? `${winnerNamesSentence} completed ${resultPatternName}. The round can continue.`
        : nextStepPending
          ? `${winnerNamesSentence} completed ${resultPatternName}.`
          : snapshot.self.roundEligibility === "waiting"
            ? `${winnerNamesSentence} won ${resultPatternName}. Thanks for joining the lobby; you were waiting for the next round.`
            : `${winnerNamesSentence} won ${resultPatternName}. Thanks for playing.`;
  const resultHeading = endedWithoutResult
    ? "Round ended"
    : selfWon
      ? "Bingo - you won!"
      : hasContinuation
        ? `${resultPatternName} complete`
        : nextStepPending
          ? `${resultPatternName} result confirmed`
          : "Round complete";
  const coWinnerDuration =
    snapshot.round?.stage === "co-winner-window"
      ? coWinnerDurationLabel(snapshot.round.window.openedAt, snapshot.round.window.closesAt)
      : null;
  const resultNextStep = endedWithoutResult
    ? "No winner was confirmed. This lobby does not provide previous-round browsing."
    : snapshot.round?.stage === "ended"
      ? "This round has ended. The confirmed result remains visible to everyone in the lobby."
      : continuationPatternId === undefined
        ? "Waiting for the server to confirm the available next step."
        : continuationPatternName === null
          ? snapshot.self.role === "host"
            ? "Choose End round in Host controls when everyone is ready."
            : "The host can end the round when everyone is ready."
          : snapshot.self.role === "host"
            ? `Choose Continue to ${continuationPatternName} or End round in Host controls.`
            : `The host can continue to ${continuationPatternName} or end the round.`;
  const hostControlGuidance = realtimeAuthorityUncertain
    ? "Host actions become available after the realtime snapshot is synchronized."
    : !selfConnected
      ? "Host actions are unavailable until authoritative host presence is connected."
      : blockingAbsentPlayer
        ? "A current player is absent. Reconnect or apply the current absence override before progressing."
        : roundStage === "paused"
          ? "Calling is paused. Resume calling when everyone is ready, or end the round."
          : roundStage === "result"
            ? continuationPatternId === undefined
              ? "The result is settled. Waiting for the server to confirm the available next step."
              : continuationPatternName === null
                ? "The result is settled. End this terminal round when everyone is ready."
                : `The result is settled. Continue to ${continuationPatternName} or end the round.`
            : snapshot.round?.callConfiguration.mode === "automatic"
              ? `Automatic calling is set to every ${snapshot.round.callConfiguration.intervalSeconds} seconds. Call Next is also safe to use while no command is pending.`
              : "Manual mode only advances when you choose Call Next.";

  const waitingMessage =
    snapshot.round === null
      ? "The host is preparing the first round."
      : snapshot.round.stage === "ended"
        ? "The round has ended."
        : snapshot.self.roundEligibility === "waiting"
          ? snapshot.round.stage === "result"
            ? "This round is complete. Wait for the host to end it before the next round."
            : "You are queued for the next round and will not play in the pending round."
          : snapshot.round.stage === "waiting"
            ? "Waiting for the host to start the round."
            : "The round has started.";
  const cardUnavailableReason =
    snapshot.round === null || snapshot.round.stage === "waiting"
      ? "the round has not started"
      : snapshot.round.stage === "result"
        ? "the round result is being shown"
        : snapshot.round.stage === "ended"
          ? "the round has ended"
          : unresolvedMark !== null && snapshot.ownCard?.id === unresolvedMark.cardId
            ? `the ${cardBallLabel(snapshot, unresolvedMark.ball)} mark needs confirmation`
            : undefined;
  const marksAvailable =
    snapshot.round?.stage === "active" ||
    snapshot.round?.stage === "paused" ||
    snapshot.round?.stage === "co-winner-window";
  const missingCardMessage =
    snapshot.round?.stage === "result" || snapshot.round?.stage === "ended"
      ? "You did not have a card in this round."
      : "Your card is unavailable while you wait for the next round.";
  const calledBalls = new Set(snapshot.calls.map((call) => call.ball));
  const markedBalls = new Set(snapshot.ownMarks.map((mark) => mark.ball));
  const cardCells: BingoCardCell[] =
    snapshot.ownCard?.cells.map((cell) => ({
      value: cell,
      state:
        cell === "FREE"
          ? "free"
          : markedBalls.has(cell)
            ? "marked"
            : calledBalls.has(cell)
              ? "called"
              : "uncalled",
    })) ?? [];
  const patternProgress =
    selectedPatternDefinition === undefined || snapshot.ownCard === null
      ? null
      : calculatePatternProgress(selectedPatternDefinition, {
          calledCells: snapshot.ownCard.cells.map(
            (cell) => cell === "FREE" || calledBalls.has(cell),
          ),
          markedCells: snapshot.ownCard.cells.map(
            (cell) => cell === "FREE" || markedBalls.has(cell),
          ),
        });
  const previewMask = selectedPatternDefinition?.masks[0]?.replaceAll("/", "") ?? "";
  const connectionLabel =
    connectionState === "snapshot-syncing"
      ? "Snapshot syncing"
      : connectionState.charAt(0).toUpperCase() + connectionState.slice(1);
  const pauseAnnouncement =
    snapshot.round?.stage === "paused" ? pauseDescription(snapshot.round.pauseReason) : null;
  const graceAnnouncement = snapshot.participants.some(
    ({ presence }) => presence.status === "grace",
  )
    ? "A participant is in the reconnect grace period."
    : null;
  const gameStatusAnnouncement = [
    enableRealtime ? connectionLabel : null,
    pauseAnnouncement,
    graceAnnouncement,
  ]
    .filter((message) => message !== null && message.length > 0)
    .join(" ");
  const liveGamePanel = (
    <section
      aria-labelledby="live-game-heading"
      className="lobby-panel live-game-panel"
      key="live-game"
      role="region"
    >
      <div className="live-game-heading">
        <div>
          <p className="eyebrow">On the board</p>
          <h2
            className="section-focus-target"
            id="live-game-heading"
            ref={liveGameHeadingRef}
            tabIndex={-1}
          >
            Live game status
          </h2>
        </div>
        {enableRealtime ? (
          <strong className="connection-state" data-state={connectionState}>
            {connectionLabel}
          </strong>
        ) : null}
      </div>
      <div className="live-game-summary">
        <div className="current-call">
          <ThemeArtwork
            className="theme-call-art"
            loaded={themeSpriteLoaded}
            role="call-ball"
            theme={activeTheme}
          />
          <div className="theme-art-content">
            <span>Current call</span>
            <strong>{latestCall === undefined ? "Waiting" : ballLabel(latestCall.ball)}</strong>
          </div>
        </div>
        <div className="call-mode-status">
          <strong>{snapshot.round === null ? "Round not configured" : callDescription}</strong>
          {automaticCountdown === null ? null : (
            <span>
              {automaticCountdown === 0
                ? "Waiting for the server to commit the next call."
                : `Next call in ${automaticCountdown} ${automaticCountdown === 1 ? "second" : "seconds"}`}
            </span>
          )}
        </div>
      </div>
      {snapshot.round?.stage === "paused" ? (
        <div className="round-alert">
          <strong>{pauseDescription(snapshot.round.pauseReason)}</strong>
          <span>Reconnecting does not resume calling. The host must resume explicitly.</span>
        </div>
      ) : null}
      {snapshot.round?.stage === "co-winner-window" ? (
        <div className="round-alert">
          <strong>Winner confirmation in progress</strong>
          <span>
            The complete winner set will appear only after the server confirms the result.
          </span>
        </div>
      ) : null}
      {snapshot.participants.some(({ presence }) => presence.status === "grace") ? (
        <p className="grace-status">A participant is in the reconnect grace period.</p>
      ) : null}
    </section>
  );
  const statusAnnouncements = (
    <div className="status-announcements">
      <p
        aria-atomic="true"
        aria-label="Game status announcement"
        aria-live="polite"
        className="call-announcement"
        role="status"
      >
        {gameStatusAnnouncement}
      </p>
      <p
        aria-atomic="true"
        aria-label="Outcome announcement"
        aria-live="polite"
        className="call-announcement"
        role="status"
      >
        {outcomeAnnouncement}
      </p>
      <p
        aria-atomic="true"
        aria-label="New call announcement"
        aria-live="polite"
        className="call-announcement"
        role="status"
      >
        {callAnnouncement}
      </p>
    </div>
  );
  const cardPanel = (
    <section
      aria-labelledby="card-heading"
      className={
        roundStage === "co-winner-window"
          ? "lobby-panel card-panel co-winner-card-panel"
          : "lobby-panel card-panel"
      }
      key="card"
      ref={cardPanelRef}
    >
      <p className="eyebrow">Your numbers</p>
      <h2 id="card-heading">Your card</h2>
      <ThemeArtwork
        className="theme-card-decoration"
        loaded={themeSpriteLoaded}
        role="card-decoration"
        theme={activeTheme}
      />
      <ThemeArtwork
        className="theme-dauber-art"
        loaded={themeSpriteLoaded}
        role="dauber"
        theme={activeTheme}
      />
      {snapshot.ownCard === null ? (
        <p className="waiting-note">{missingCardMessage}</p>
      ) : (
        <BingoCard
          cells={cardCells}
          onMark={(ball) => void markCard(ball)}
          pendingBall={markPendingBall}
          statusMessage={markMessage}
          {...(cardUnavailableReason === undefined
            ? {}
            : { unavailableReason: cardUnavailableReason })}
        />
      )}
      {marksAvailable &&
      unresolvedMark !== null &&
      snapshot.ownCard?.id === unresolvedMark.cardId ? (
        <Button onClick={() => void markCard(unresolvedMark.ball)} type="button" variant="outline">
          Retry {cardBallLabel(snapshot, unresolvedMark.ball)} mark
        </Button>
      ) : null}
    </section>
  );

  return (
    <main
      aria-busy={snapshotPending}
      className="private-lobby-shell"
      data-theme-id={activeTheme?.id}
      style={themeStyle}
    >
      {activeTheme === undefined ? null : (
        <img
          alt=""
          aria-hidden="true"
          data-theme-sprite-preload
          hidden
          onError={() => setLoadedThemeSpriteUrl(null)}
          onLoad={() => setLoadedThemeSpriteUrl(activeTheme.visuals.spriteUrl)}
          src={activeTheme.visuals.spriteUrl}
        />
      )}
      <header className="lobby-masthead">
        <div>
          <p className="eyebrow">Private game room</p>
          <h1>Lobby {code}</h1>
          <p>
            Signed in as <strong>{snapshot.self.username}</strong>
            {snapshot.self.role === "host" ? " (host)" : ""}.
          </p>
        </div>
        <ThemeArtwork
          className="theme-masthead-art"
          loaded={themeSpriteLoaded}
          role="icon"
          theme={activeTheme}
        />
        <Button
          aria-disabled={snapshotPending}
          onClick={() => {
            if (!snapshotPending) void refreshSnapshot("Refreshing the lobby...");
          }}
          type="button"
          variant="outline"
        >
          Refresh lobby
        </Button>
      </header>
      <p aria-live="polite" className="refresh-status">
        {snapshotMessage}
      </p>
      {snapshot.self.role === "host" ? (
        <p
          aria-atomic="true"
          aria-label="Host command status"
          aria-live="polite"
          className="command-status"
          role="status"
        >
          {commandMessage}
        </p>
      ) : null}
      {statusAnnouncements}

      <div className="private-lobby-grid">
        {hasOutcome ? null : liveGamePanel}

        {hasOutcome ? (
          <section
            aria-labelledby="outcome-heading"
            className="lobby-panel outcome-panel"
            data-outcome={
              roundStage === "co-winner-window"
                ? "checking"
                : endedWithoutResult
                  ? "ended"
                  : selfWon
                    ? "winner"
                    : "complete"
            }
            role="region"
          >
            {settledResult === null ? null : (
              <ThemeArtwork
                className="theme-outcome-art"
                loaded={themeSpriteLoaded}
                role={selfWon ? "winner" : "other-winner"}
                theme={activeTheme}
              />
            )}
            {roundStage === "co-winner-window" ? (
              <div className="outcome-lockup outcome-lockup-checking">
                <div>
                  <h2
                    className="section-focus-target"
                    id="outcome-heading"
                    ref={outcomeHeadingRef}
                    tabIndex={-1}
                  >
                    Checking for co-winners
                  </h2>
                  <p className="outcome-lead">
                    The full {coWinnerDuration} co-winner check pauses calls.
                  </p>
                  <p>
                    {snapshot.ownCard === null
                      ? "Winner confirmation is in progress. The complete winner set appears after the window closes."
                      : "If the latest call completes your card, mark it now before the window closes."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="outcome-lockup">
                <div aria-hidden="true" className="result-mark">
                  {endedWithoutResult ? "ENDED" : selfWon ? "BINGO" : "RESULT"}
                </div>
                <div>
                  <p className="eyebrow">
                    {endedWithoutResult ? "Round status" : "Confirmed result"}
                  </p>
                  <h2
                    className="section-focus-target"
                    id="outcome-heading"
                    ref={outcomeHeadingRef}
                    tabIndex={-1}
                  >
                    {resultHeading}
                  </h2>
                  <p className="outcome-lead">{resultSummary}</p>
                  {endedWithoutResult ? null : (
                    <>
                      <h3>Confirmed {winnerNames.length === 1 ? "winner" : "co-winners"}</h3>
                      <ul aria-label="Confirmed winners" className="winner-list">
                        {winners.map((winner) => (
                          <li key={winner.id}>
                            <strong>{winner.username}</strong>
                            {winner.id === snapshot.self.id ? <span>You</span> : null}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <p className="outcome-next-step">{resultNextStep}</p>
                </div>
              </div>
            )}
          </section>
        ) : null}

        {hasOutcome && roundStage !== "co-winner-window" ? null : cardPanel}

        {showHostControls ? (
          <section
            aria-busy={commandPending || pendingCommand !== null}
            aria-labelledby="host-controls-heading"
            className="lobby-panel host-controls-panel"
            ref={hostControlsRef}
            role="region"
          >
            <p className="eyebrow">Game authority</p>
            <h2
              className="section-focus-target"
              id="host-controls-heading"
              ref={hostControlsHeadingRef}
              tabIndex={-1}
            >
              Host controls
            </h2>
            <p className="host-control-guidance">{hostControlGuidance}</p>
            <div className="host-round-actions">
              {roundStage === "active" ? (
                <Button
                  data-host-action="pause-round"
                  disabled={hostControlsUnavailable}
                  onClick={() => void runCommand({ type: "pause-round", code })}
                  type="button"
                  variant="outline"
                >
                  Pause calling
                </Button>
              ) : null}
              {roundStage === "paused" ? (
                <Button
                  data-host-action="resume-round"
                  disabled={hostControlsUnavailable || blockingAbsentPlayer}
                  onClick={() => void runCommand({ type: "resume-round", code })}
                  type="button"
                >
                  Resume calling
                </Button>
              ) : null}
              {canCallNext ? (
                <Button
                  data-host-action="call-next"
                  disabled={hostControlsUnavailable || blockingAbsentPlayer}
                  onClick={() => void runCommand({ type: "call-next", code })}
                  ref={callNextButtonRef}
                  type="button"
                >
                  Call Next
                </Button>
              ) : null}
              {roundStage === "result" &&
              continuationPatternId !== undefined &&
              continuationPatternId !== null ? (
                <Button
                  data-host-action="continue-round"
                  data-pattern-id={continuationPatternId}
                  disabled={hostControlsUnavailable || blockingAbsentPlayer}
                  onClick={() =>
                    void runCommand({
                      type: "continue-round",
                      code,
                      patternId: continuationPatternId,
                    })
                  }
                  type="button"
                >
                  Continue to {continuationPatternName}
                </Button>
              ) : null}
              {roundStage === "active" || roundStage === "paused" || roundStage === "result" ? (
                <Button
                  data-host-action="end-round"
                  disabled={hostControlsUnavailable}
                  onClick={() => {
                    endConfirmationRoundIdRef.current = snapshot.round?.id ?? null;
                    setEndConfirmationOpen(true);
                  }}
                  ref={endRoundButtonRef}
                  tone="danger"
                  type="button"
                  variant="outline"
                >
                  End round
                </Button>
              ) : null}
            </div>
            {unresolvedCommand !== null ? (
              <Button
                data-host-action="retry-command"
                disabled={hostAuthorityUnavailable || commandPending}
                onClick={() => void runCommand(unresolvedCommand)}
                type="button"
                variant="outline"
              >
                Retry {commandActionLabel(unresolvedCommand)}
              </Button>
            ) : null}
            {eligibleAbsences.length > 0 ? (
              <div className="absence-overrides">
                <h3>Current player absences</h3>
                <p>An override applies only to this absence. It never resumes calling.</p>
                {eligibleAbsences.map((participant) => {
                  if (participant.presence.status !== "absent") return null;
                  return (
                    <Button
                      data-host-action="override-absence"
                      data-participant-id={participant.id}
                      data-presence-generation={participant.presence.generation}
                      disabled={hostControlsUnavailable}
                      key={participant.id}
                      onClick={() =>
                        void runCommand({
                          type: "override-absence",
                          code,
                          participantId: participant.id,
                          presenceGeneration: participant.presence.generation,
                        })
                      }
                      type="button"
                      variant="outline"
                    >
                      Override absence for {participant.username}
                    </Button>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : null}

        {hasOutcome ? liveGamePanel : null}
        {hasOutcome && roundStage !== "co-winner-window" ? cardPanel : null}

        <section
          aria-labelledby="round-details-heading"
          className="lobby-panel live-game-detail-panel"
        >
          <p className="eyebrow">Calls and pattern</p>
          <h2 id="round-details-heading">Round details</h2>
          <div className="live-game-detail">
            <div>
              <h3>Call history</h3>
              {snapshot.calls.length === 0 ? (
                <p>No balls called yet.</p>
              ) : (
                <ol
                  aria-label="Calls in chronological order, newest at end"
                  className="call-history"
                  onScroll={(event) => {
                    const history = event.currentTarget;
                    followCallHistoryRef.current =
                      history.scrollHeight - history.scrollTop - history.clientHeight <= 24;
                  }}
                  ref={callHistoryRef}
                  tabIndex={0}
                >
                  {snapshot.calls.map((call) => (
                    <li key={call.id}>{ballLabel(call.ball)}</li>
                  ))}
                </ol>
              )}
            </div>
            <div>
              <h3>{patternName ?? "Winning pattern"}</h3>
              {selectedPatternDefinition === undefined ? (
                <p>Pattern preview unavailable.</p>
              ) : (
                <>
                  <div
                    aria-label={`${selectedPatternDefinition.name} pattern ${selectedPatternDefinition.mode === "exact" ? "preview" : "example"}. Filled spaces are required.`}
                    className="pattern-miniature"
                    role="img"
                  >
                    {Array.from(previewMask, (cell, index) => (
                      <span aria-hidden="true" data-required={cell === "#"} key={index} />
                    ))}
                  </div>
                  <span className="pattern-example-label">
                    {selectedPatternDefinition.mode === "exact"
                      ? "Required pattern"
                      : "One possible pattern example"}
                  </span>
                  <p className="pattern-progress">
                    {patternProgress === null
                      ? "Progress is available when your card is active."
                      : `${selectedPatternDefinition.mode === "exact" ? "Progress" : "Closest eligible variation"}: ${patternProgress.satisfiedCellCount} of ${patternProgress.requiredCellCount} required spaces marked.`}
                  </p>
                </>
              )}
            </div>
          </div>
        </section>

        <section aria-labelledby="invite-heading" className="lobby-panel share-panel">
          <p className="eyebrow">Bring everyone in</p>
          <h2 id="invite-heading">Share the lobby</h2>
          <label htmlFor="share-lobby-code">Lobby code to copy</label>
          <input className="share-code" id="share-lobby-code" readOnly ref={codeRef} value={code} />
          <Button onClick={() => void copy(code, codeRef.current, "Lobby code")} type="button">
            Copy Code
          </Button>
          <label htmlFor="share-invite-url">Invite URL to copy</label>
          <input
            className="share-url"
            id="share-invite-url"
            readOnly
            ref={inviteRef}
            value={inviteUrl}
          />
          <div className="share-actions">
            <Button
              disabled={inviteUrl.length === 0}
              onClick={() => void copy(inviteUrl, inviteRef.current, "Invite URL")}
              type="button"
              variant="outline"
            >
              Copy Invite URL
            </Button>
            {nativeShare !== null ? (
              <Button
                disabled={inviteUrl.length === 0}
                onClick={() => {
                  void nativeShare({
                    title: "GameNight Bingo",
                    text: `Join my private Bingo lobby ${code}.`,
                    url: inviteUrl,
                  })
                    .then(() => setShareMessage("Invite sharing opened."))
                    .catch((error: unknown) => {
                      if (error instanceof DOMException && error.name === "AbortError") {
                        setShareMessage("Sharing canceled.");
                      } else {
                        inviteRef.current?.focus();
                        inviteRef.current?.select();
                        setShareMessage(
                          "Sharing failed. Select the invite URL and copy it manually.",
                        );
                      }
                    });
                }}
                type="button"
                variant="outline"
              >
                Share Invite
              </Button>
            ) : null}
          </div>
          <p aria-label="Sharing status" aria-live="polite" className="share-status" role="status">
            {shareMessage}
          </p>
        </section>

        <section aria-labelledby="setup-heading" className="lobby-panel setup-panel">
          <p className="eyebrow">Round setup</p>
          <h2
            className="section-focus-target"
            id="setup-heading"
            ref={setupHeadingRef}
            tabIndex={-1}
          >
            Lobby setup
          </h2>
          <dl className="setup-summary">
            <div>
              <dt>Theme</dt>
              <dd>{themeName ?? snapshot.lobby.themeId}</dd>
            </div>
            <div>
              <dt>Pattern</dt>
              <dd>{patternName ?? snapshot.round?.patternId ?? "Not configured"}</dd>
            </div>
            <div>
              <dt>Call mode</dt>
              <dd>{snapshot.round === null ? "Not configured" : callDescription}</dd>
            </div>
          </dl>

          {hostCanConfigure ? (
            <form aria-label="Host lobby setup" className="host-setup-form" onSubmit={saveSetup}>
              <Select
                disabled={waitingControlsUnavailable}
                id="lobby-pattern"
                label="Winning pattern"
                name="pattern"
                onChange={(event) => {
                  setPatternId(event.currentTarget.value);
                  setSetupDraftDirty(true);
                  commandSessionRef.current = null;
                }}
                required
                value={patternId}
              >
                {patterns.map((pattern) => (
                  <Option key={pattern.id} value={pattern.id}>
                    {patternLabel(pattern, duplicatePatternNames)}
                  </Option>
                ))}
              </Select>
              <Select
                disabled={waitingControlsUnavailable}
                id="lobby-call-mode"
                label="Call mode"
                name="callMode"
                onChange={(event) => {
                  setCallMode(event.currentTarget.value as CallConfiguration["mode"]);
                  setSetupDraftDirty(true);
                  commandSessionRef.current = null;
                }}
                value={callMode}
              >
                <Option value="manual">Manual</Option>
                <Option value="automatic">Automatic</Option>
              </Select>
              {callMode === "automatic" ? (
                <Select
                  disabled={waitingControlsUnavailable}
                  id="lobby-call-interval"
                  label="Call interval"
                  name="callInterval"
                  onChange={(event) => {
                    setInterval(event.currentTarget.value);
                    setSetupDraftDirty(true);
                    commandSessionRef.current = null;
                  }}
                  value={interval}
                >
                  {AUTOMATIC_INTERVALS.map((seconds) => (
                    <Option key={seconds} value={String(seconds)}>
                      {seconds} seconds
                    </Option>
                  ))}
                </Select>
              ) : null}
              <p className="setup-guidance">
                {realtimeAuthorityUncertain
                  ? "Host actions become available after the realtime snapshot is synchronized."
                  : !selfConnected
                    ? "Start becomes available when your authoritative presence is connected."
                    : blockingAbsentPlayer
                      ? "A current player is absent. Reconnect or apply the current absence override before starting."
                      : pendingCommand !== null
                        ? pendingCommand.command.type === "configure"
                          ? "Setup committed. Waiting for the authoritative lobby state."
                          : "Start committed. Waiting for the authoritative lobby state."
                        : setupDirty
                          ? "Save setup before starting the round."
                          : "Setup is saved and the host is connected."}
              </p>
              <div className="host-actions">
                <Button aria-disabled={setupCommandUnavailable} type="submit" variant="outline">
                  Save setup
                </Button>
                <Button
                  aria-disabled={startUnavailable}
                  onClick={() => {
                    if (!startUnavailable) {
                      void runCommand({ type: "start-round", code }, "Starting the first round...");
                    }
                  }}
                  type="button"
                >
                  Start round
                </Button>
                {unresolvedCommand?.type === "start-round" ? (
                  <Button
                    data-host-action="retry-command"
                    disabled={hostAuthorityUnavailable || commandPending}
                    onClick={() => void runCommand(unresolvedCommand)}
                    type="button"
                    variant="outline"
                  >
                    Retry Start round
                  </Button>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="waiting-note">{waitingMessage}</p>
          )}
        </section>

        <section aria-labelledby="participants-heading" className="lobby-panel roster-panel">
          <div className="roster-heading">
            <div>
              <p className="eyebrow">People, not tabs</p>
              <h2 id="participants-heading">Participants</h2>
            </div>
            <strong>{snapshot.participants.length}</strong>
          </div>
          <ul aria-label="Participants" className="participant-list">
            {snapshot.participants.map((participant) => (
              <li key={participant.id}>
                <div>
                  <strong>{participant.username}</strong>
                  {participant.id === snapshot.self.id ? (
                    <span className="you-label">You</span>
                  ) : null}
                </div>
                <div className="participant-states">
                  {participant.role === "host" ? <span>Host</span> : null}
                  <span>{presenceText(participant)}</span>
                  <span>{eligibilityText(participant, snapshot.round !== null)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {endConfirmationOpen ? (
        <dialog
          aria-describedby="end-round-description"
          aria-modal="true"
          aria-labelledby="end-round-heading"
          className="end-round-dialog"
          onCancel={(event) => {
            event.preventDefault();
            endConfirmationRoundIdRef.current = null;
            setRestoreEndRoundFocus(true);
            setEndConfirmationOpen(false);
          }}
          ref={endRoundDialogRef}
        >
          <h2 id="end-round-heading">End this round?</h2>
          <p id="end-round-description">Calling stops immediately. This action cannot be undone.</p>
          {hostAuthorityUnavailable ? (
            <p aria-label="End round availability" aria-live="polite" role="status">
              Host actions are unavailable until authoritative host presence and realtime state are
              ready.
            </p>
          ) : null}
          <div className="host-round-actions">
            <Button
              onClick={() => {
                endConfirmationRoundIdRef.current = null;
                setRestoreEndRoundFocus(true);
                setEndConfirmationOpen(false);
              }}
              ref={endRoundCancelRef}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                hostAuthorityUnavailable ||
                commandPending ||
                pendingCommand !== null ||
                unresolvedCommand !== null
              }
              onClick={() => {
                if (
                  hostAuthorityUnavailable ||
                  commandPendingRef.current ||
                  pendingCommandRef.current !== null ||
                  commandSessionRef.current !== null ||
                  snapshot.round?.id !== endConfirmationRoundIdRef.current
                ) {
                  return;
                }
                endConfirmationRoundIdRef.current = null;
                setEndConfirmationOpen(false);
                setCommandFocusTarget("host-controls");
                void runCommand({ type: "end-round", code });
              }}
              tone="danger"
              type="button"
            >
              End round
            </Button>
          </div>
        </dialog>
      ) : null}
    </main>
  );
}
