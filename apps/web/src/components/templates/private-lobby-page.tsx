"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  AutomaticCallInterval,
  CallConfiguration,
  ParticipantSummary,
  Snapshot,
} from "@gamenight-bingo/contracts";

import { Button, LinkButton, Option } from "@/atoms";
import { Select } from "@/molecules";
import { THEME_OPTIONS } from "@/organisms";
import {
  PrivateLobbyFlowError,
  WaitingLobbyCommandSession,
  loadPrivateLobbySnapshot,
  type WaitingLobbyCommand,
  type WaitingLobbyCommandAck,
} from "@/lib/private-lobby-flow";

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
};

type PendingCommandReconciliation = {
  command: WaitingLobbyCommand;
  eventSequence: WaitingLobbyCommandAck["eventSequence"];
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

export function PrivateLobbyPage({
  code,
  patterns,
  loadSnapshot = loadPrivateLobbySnapshot,
  copyText,
  shareInvite,
  origin,
  createCommandSession = defaultCreateCommandSession,
}: PrivateLobbyPageProps) {
  const codeRef = useRef<HTMLInputElement>(null);
  const inviteRef = useRef<HTMLInputElement>(null);
  const commandSessionRef = useRef<{
    key: string;
    runner: ReturnType<NonNullable<PrivateLobbyPageProps["createCommandSession"]>>;
  } | null>(null);
  const commandPendingRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const refreshPendingRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<Snapshot | null> | null>(null);
  const pendingCommandRef = useRef<PendingCommandReconciliation | null>(null);
  const setupDirtyRef = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotMessage, setSnapshotMessage] = useState("Loading private lobby...");
  const [snapshotErrorCode, setSnapshotErrorCode] = useState<string | undefined>();
  const [snapshotErrorRetryable, setSnapshotErrorRetryable] = useState(true);
  const [snapshotPending, setSnapshotPending] = useState(true);
  const [shareMessage, setShareMessage] = useState("");
  const [commandMessage, setCommandMessage] = useState("");
  const [commandPending, setCommandPending] = useState(false);
  const [patternId, setPatternId] = useState("");
  const [callMode, setCallMode] = useState<CallConfiguration["mode"]>("manual");
  const [interval, setInterval] = useState("30");
  const [setupDirty, setSetupDirty] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<PendingCommandReconciliation | null>(null);
  const [resolvedOrigin, setResolvedOrigin] = useState(origin ?? "");
  const [nativeShare, setNativeShare] = useState<NonNullable<typeof shareInvite> | null>(null);

  function setSetupDraftDirty(dirty: boolean) {
    setupDirtyRef.current = dirty;
    setSetupDirty(dirty);
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
        const next = await loadSnapshot(code);
        if (loadGenerationRef.current !== generation) return null;
        setSnapshot(next);
        const pending = pendingCommandRef.current;
        const pendingConfirmed = pending !== null && snapshotConfirmsCommand(next, pending);
        if (
          options.syncSetup === true ||
          snapshot === null ||
          !setupDirtyRef.current ||
          (pendingConfirmed && pending.command.type === "configure")
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
        if (pendingConfirmed) {
          pendingCommandRef.current = null;
          setPendingCommand(null);
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
  const patternName =
    selectedPattern === undefined
      ? undefined
      : patternLabel(selectedPattern, duplicatePatternNames);
  const callDescription =
    snapshot.round?.callConfiguration.mode === "automatic"
      ? `Automatic every ${snapshot.round.callConfiguration.intervalSeconds} seconds`
      : "Manual calling";

  const waitingMessage =
    snapshot.round === null
      ? "The host is preparing the first round."
      : snapshot.self.roundEligibility === "waiting"
        ? "You are queued for the next round and will not play in the pending round."
        : snapshot.round.stage === "waiting"
          ? "Waiting for the host to start the round."
          : "The round has started.";

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
          <p aria-live="polite" className="share-status" role="status">
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
