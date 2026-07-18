"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

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
import { BingoCard, type BingoCardCell } from "@gamenight-bingo/ui";

import { Button, LinkButton, Option } from "@/atoms";
import { Select } from "@/molecules";
import { THEME_OPTIONS } from "@/organisms";
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
  return pending.command.type === "configure"
    ? snapshot.round?.patternId === pending.command.patternId &&
        callConfigurationMatches(
          snapshot.round.callConfiguration,
          pending.command.callConfiguration,
        )
    : snapshot.round !== null && snapshot.round.stage !== "waiting";
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
    key: string;
    runner: ReturnType<NonNullable<PrivateLobbyPageProps["createCommandSession"]>>;
  } | null>(null);
  const commandPendingRef = useRef(false);
  const markCommandPendingRef = useRef(false);
  const markCommandSessionRef = useRef<{
    ball: number;
    cardId: string;
    runner: ReturnType<NonNullable<PrivateLobbyPageProps["createMarkCommandSession"]>>;
  } | null>(null);
  const loadGenerationRef = useRef(0);
  const refreshPendingRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<Snapshot | null> | null>(null);
  const pendingCommandRef = useRef<PendingCommandReconciliation | null>(null);
  const pendingMarkRef = useRef<PendingMarkReconciliation | null>(null);
  const unresolvedMarkRef = useRef<UnresolvedMark | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const liveConnectionRef = useRef<PrivateLobbyRealtimeConnection | null>(null);
  const resyncRequestedRef = useRef(false);
  const recoveringRef = useRef(false);
  const callHistoryRef = useRef<HTMLOListElement>(null);
  const followCallHistoryRef = useRef(true);
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
  const [resolvedOrigin, setResolvedOrigin] = useState(origin ?? "");
  const [nativeShare, setNativeShare] = useState<NonNullable<typeof shareInvite> | null>(null);
  const [connectionState, setConnectionState] =
    useState<PrivateLobbyConnectionState>("snapshot-syncing");
  const [callAnnouncement, setCallAnnouncement] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());

  function setSetupDraftDirty(dirty: boolean) {
    setupDirtyRef.current = dirty;
    setSetupDirty(dirty);
  }

  function reconcilePendingState(next: Snapshot): PendingCommandReconciliation | null {
    const pending = pendingCommandRef.current;
    const confirmedCommand =
      pending !== null && snapshotConfirmsCommand(next, pending) ? pending : null;
    if (confirmedCommand !== null) {
      pendingCommandRef.current = null;
      setPendingCommand(null);
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
    return confirmedCommand;
  }

  async function refreshSnapshot(
    message = "Loading private lobby...",
    options: { mandatory?: boolean; syncSetup?: boolean } = {},
  ): Promise<Snapshot | null> {
    if (refreshPendingRef.current) {
      if (options.mandatory !== true) return refreshPromiseRef.current;
      await refreshPromiseRef.current;
    }

    const refresh = (async () => {
      refreshPendingRef.current = true;
      const generation = ++loadGenerationRef.current;
      setSnapshotPending(true);
      setSnapshotMessage(message);
      try {
        const received = await loadSnapshot(code);
        if (loadGenerationRef.current !== generation) return null;
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
        const confirmedCommand = reconcilePendingState(next);
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
      setConnectionState("snapshot-syncing");
      liveConnectionRef.current?.requestResync(lastEventSequence);
    };
    const handlers: PrivateLobbyRealtimeHandlers = {
      onConnectionState(state) {
        if (state === "offline" || state === "reconnecting") recoveringRef.current = true;
        if (state === "expired") {
          snapshotRef.current = null;
          setSnapshot(null);
          setSnapshotErrorCode("UNAUTHORIZED");
          setSnapshotErrorRetryable(false);
          setSnapshotMessage(
            "Your private lobby session is not active on this device. Join or rejoin to continue.",
          );
        }
        setConnectionState(state);
      },
      onLobbyEvent(event) {
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
        const requiresAutomaticTimer =
          next.round?.stage === "active" && next.round.callConfiguration.mode === "automatic";
        if (event.type === "call") {
          setCallAnnouncement(`New call: ${ballLabel(event.call.ball)}`);
        }
        if (requiresAutomaticTimer && (event.type === "call" || event.type === "stage")) {
          requestResync(event.eventSequence);
        }
      },
      onPrivateEvent(event: ParticipantPrivateEvent) {
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
        reconcilePendingState(next);
      },
      onSnapshot(next) {
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
        const confirmedCommand = reconcilePendingState(accepted);
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
        if (roundChanged) followCallHistoryRef.current = true;
        setConnectionState(recovering ? "recovered" : "connected");
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

  async function runCommand(command: WaitingLobbyCommand, pendingMessage: string) {
    if (commandPendingRef.current) return;
    commandPendingRef.current = true;
    const key = JSON.stringify(command);
    if (commandSessionRef.current?.key !== key) {
      commandSessionRef.current = { key, runner: createCommandSession(command) };
    }
    setCommandPending(true);
    setCommandMessage(pendingMessage);
    let acknowledgement: WaitingLobbyCommandAck;
    try {
      acknowledgement = await commandSessionRef.current.runner.run();
      commandSessionRef.current = null;
    } catch (error) {
      const flowError =
        error instanceof PrivateLobbyFlowError
          ? error
          : new PrivateLobbyFlowError("We could not confirm the command response.", {
              ambiguous: true,
            });
      if (!flowError.ambiguous && !flowError.retryable) commandSessionRef.current = null;
      setCommandMessage(flowError.message);
      commandPendingRef.current = false;
      setCommandPending(false);
      return;
    }

    const pending = { command, eventSequence: acknowledgement.eventSequence };
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
      setCommandMessage(command.type === "configure" ? "Lobby setup saved." : "Round started.");
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
    if (commandPendingRef.current || pendingCommandRef.current !== null) return;
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

  const themeName = THEME_OPTIONS.find((theme) => theme.id === snapshot.lobby.themeId)?.name;
  const hostCanConfigure = snapshot.self.role === "host" && snapshot.round?.stage === "waiting";
  const selfConnected = snapshot.self.presence.status === "connected";
  const blockingAbsentPlayer = snapshot.participants.some(
    (participant) =>
      participant.roundEligibility === "playing" &&
      participant.presence.status === "absent" &&
      !participant.presence.overridden,
  );
  const waitingControlsUnavailable = commandPending || pendingCommand !== null;
  const startUnavailable =
    waitingControlsUnavailable || setupDirty || !selfConnected || blockingAbsentPlayer;
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

  const waitingMessage =
    snapshot.round === null
      ? "The host is preparing the first round."
      : snapshot.self.roundEligibility === "waiting"
        ? "You are queued for the next round and will not play in the pending round."
        : snapshot.round.stage === "waiting"
          ? "Waiting for the host to start the round."
          : "The round has started.";
  const cardUnavailableReason =
    unresolvedMark !== null && snapshot.ownCard?.id === unresolvedMark.cardId
      ? `the ${cardBallLabel(snapshot, unresolvedMark.ball)} mark needs confirmation`
      : snapshot.round === null || snapshot.round.stage === "waiting"
        ? "the round has not started"
        : snapshot.round.stage === "result"
          ? "the round result is being shown"
          : snapshot.round.stage === "ended"
            ? "the round has ended"
            : undefined;
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
  const coWinnerAnnouncement =
    snapshot.round?.stage === "co-winner-window" ? "Co-winner window open." : null;
  const graceAnnouncement = snapshot.participants.some(
    ({ presence }) => presence.status === "grace",
  )
    ? "A participant is in the reconnect grace period."
    : null;
  const gameStatusAnnouncement = [
    enableRealtime ? connectionLabel : null,
    pauseAnnouncement,
    coWinnerAnnouncement,
    graceAnnouncement,
  ]
    .filter((message) => message !== null)
    .join(" ");

  return (
    <main aria-busy={snapshotPending} className="private-lobby-shell">
      <header className="lobby-masthead">
        <div>
          <p className="eyebrow">Private game room</p>
          <h1>Lobby {code}</h1>
          <p>
            Signed in as <strong>{snapshot.self.username}</strong>
            {snapshot.self.role === "host" ? " (host)" : ""}.
          </p>
        </div>
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

      <div className="private-lobby-grid">
        <section
          aria-labelledby="live-game-heading"
          className="lobby-panel live-game-panel"
          role="region"
        >
          <div className="live-game-heading">
            <div>
              <p className="eyebrow">On the board</p>
              <h2 id="live-game-heading">Live game status</h2>
            </div>
            {enableRealtime ? (
              <strong className="connection-state" data-state={connectionState}>
                {connectionLabel}
              </strong>
            ) : null}
          </div>
          <div className="live-game-summary">
            <div className="current-call">
              <span>Current call</span>
              <strong>{latestCall === undefined ? "Waiting" : ballLabel(latestCall.ball)}</strong>
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
              <strong>Co-winner window open</strong>
              <span>Calling is paused while completions from the latest call are confirmed.</span>
            </div>
          ) : null}
          {snapshot.participants.some(({ presence }) => presence.status === "grace") ? (
            <p className="grace-status">A participant is in the reconnect grace period.</p>
          ) : null}
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
            aria-label="New call announcement"
            aria-live="polite"
            className="call-announcement"
            role="status"
          >
            {callAnnouncement}
          </p>
        </section>

        <section aria-labelledby="card-heading" className="lobby-panel card-panel">
          <p className="eyebrow">Your numbers</p>
          <h2 id="card-heading">Your card</h2>
          {snapshot.ownCard === null ? (
            <p className="waiting-note">
              Your card is unavailable while you wait for the next round.
            </p>
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
          {unresolvedMark !== null && snapshot.ownCard?.id === unresolvedMark.cardId ? (
            <Button
              onClick={() => void markCard(unresolvedMark.ball)}
              type="button"
              variant="outline"
            >
              Retry {cardBallLabel(snapshot, unresolvedMark.ball)} mark
            </Button>
          ) : null}
        </section>

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
          <h2 id="setup-heading">Lobby setup</h2>
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
                {!selfConnected
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
                <Button aria-disabled={waitingControlsUnavailable} type="submit" variant="outline">
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
              </div>
              <p aria-live="polite" className="command-status">
                {commandMessage}
              </p>
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
    </main>
  );
}
