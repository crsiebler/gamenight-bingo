"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  LobbyEntryResponse,
  SameDeviceSessionStatusResponse,
} from "@gamenight-bingo/contracts";
import { LobbyCodeSchema } from "@gamenight-bingo/contracts";
import { normalizeLobbyCodeEntry, normalizeUsername } from "@gamenight-bingo/domain";

import { Button } from "@/atoms";
import { Input } from "@/molecules";
import {
  LobbyEntryFlowError,
  LobbyEntryFlowSession,
  lookupSameDeviceSession,
  type LobbyEntrySelection,
} from "@/lib";

export type SessionStatusLookup = (code: string) => Promise<SameDeviceSessionStatusResponse>;

export type LobbyEntrySessionFactory = (selection: LobbyEntrySelection) => {
  run(): Promise<LobbyEntryResponse>;
};

type JoinLobbyFormProps = {
  createEntrySession?: LobbyEntrySessionFactory;
  initialLobbyCode?: string;
  lookupSession?: SessionStatusLookup;
};

type AuthoritativeStatusHandlers = {
  retireRejoin(): void;
  update(status: SameDeviceSessionStatusResponse): void;
};

const defaultCreateEntrySession: LobbyEntrySessionFactory = (selection) =>
  new LobbyEntryFlowSession(selection);

function isExpiredRejoin(status: SameDeviceSessionStatusResponse): boolean {
  return status.status === "rejoin-available" && Date.parse(status.rejoinUntil) <= Date.now();
}

function applyAuthoritativeStatus(
  status: SameDeviceSessionStatusResponse,
  handlers: AuthoritativeStatusHandlers,
) {
  const nextStatus = isExpiredRejoin(status)
    ? {
        schemaVersion: 1 as const,
        type: "same-device-session-status" as const,
        status: "new-participant-required" as const,
      }
    : status;
  if (nextStatus.status !== "rejoin-available") handlers.retireRejoin();
  handlers.update(nextStatus);
}

export function JoinLobbyForm({
  createEntrySession = defaultCreateEntrySession,
  initialLobbyCode = "",
  lookupSession = lookupSameDeviceSession,
}: JoinLobbyFormProps) {
  const codeRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const rejoinButtonRef = useRef<HTMLButtonElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const focusTransferAllowedRef = useRef(false);
  const activeSessionRef = useRef<{
    key: string;
    runner: ReturnType<LobbyEntrySessionFactory>;
  } | null>(null);
  const lookupGenerationRef = useRef(0);
  const [code, setCode] = useState(() => normalizeLobbyCodeEntry(initialLobbyCode));
  const [checkedCode, setCheckedCode] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SameDeviceSessionStatusResponse | null>(null);
  const [username, setUsername] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>();
  const [usernameError, setUsernameError] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [entryLocked, setEntryLocked] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(true);
  const [result, setResult] = useState<LobbyEntryResponse | null>(null);

  useEffect(() => {
    if (pending) return;
    const activeElement = document.activeElement;
    const focusRemainsInForm = formRef.current?.contains(activeElement) ?? false;
    const focusWasRemovedFromForm =
      activeElement === document.body && focusTransferAllowedRef.current;
    focusTransferAllowedRef.current = false;
    if (!focusRemainsInForm && !focusWasRemovedFromForm) return;
    if (sessionStatus?.status === "new-participant-required") usernameRef.current?.focus();
    if (sessionStatus?.status === "rejoin-available") rejoinButtonRef.current?.focus();
  }, [pending, sessionStatus]);

  useEffect(() => {
    if (
      sessionStatus?.status !== "rejoin-available" ||
      checkedCode === null ||
      pending ||
      result !== null
    ) {
      return;
    }
    const delay = Math.max(0, Date.parse(sessionStatus.rejoinUntil) - Date.now());
    const timer = window.setTimeout(() => {
      const generation = ++lookupGenerationRef.current;
      focusTransferAllowedRef.current = formRef.current?.contains(document.activeElement) ?? false;
      setSessionStatus(null);
      setPending(true);
      setMessage("The rejoin window ended. Checking the lobby...");
      void lookupSession(checkedCode)
        .then((status) => {
          if (lookupGenerationRef.current !== generation) return;
          applyAuthoritativeStatus(status, {
            retireRejoin: () => {
              activeSessionRef.current = null;
              setEntryLocked(false);
              setRetryAvailable(true);
            },
            update: setSessionStatus,
          });
          setMessage("");
        })
        .catch((error: unknown) => {
          if (lookupGenerationRef.current !== generation) return;
          setMessage(
            error instanceof LobbyEntryFlowError
              ? error.message
              : "We could not refresh that lobby. Try again.",
          );
        })
        .finally(() => {
          if (lookupGenerationRef.current === generation) setPending(false);
        });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [checkedCode, lookupSession, pending, result, sessionStatus]);

  function resetEntryState() {
    lookupGenerationRef.current += 1;
    activeSessionRef.current = null;
    setCheckedCode(null);
    setSessionStatus(null);
    setUsername("");
    setUsernameError(undefined);
    setMessage("");
    setEntryLocked(false);
    setRetryAvailable(true);
    setResult(null);
  }

  async function findLobby() {
    const parsedCode = LobbyCodeSchema.safeParse(code);
    if (!parsedCode.success) {
      setCodeError("Enter a valid six-character lobby code.");
      codeRef.current?.focus();
      return;
    }
    const generation = ++lookupGenerationRef.current;
    setCodeError(undefined);
    setPending(true);
    setMessage("Checking that lobby...");
    try {
      const status = await lookupSession(parsedCode.data);
      if (lookupGenerationRef.current !== generation) return;
      setCheckedCode(parsedCode.data);
      applyAuthoritativeStatus(status, {
        retireRejoin: () => {
          activeSessionRef.current = null;
          setEntryLocked(false);
          setRetryAvailable(true);
        },
        update: setSessionStatus,
      });
      setMessage("");
    } catch (error) {
      if (lookupGenerationRef.current !== generation) return;
      setMessage(
        error instanceof LobbyEntryFlowError
          ? error.message
          : "We could not check that lobby. Try again.",
      );
    } finally {
      if (lookupGenerationRef.current === generation) setPending(false);
    }
  }

  async function enterLobby(selection: LobbyEntrySelection) {
    const sessionKey = JSON.stringify(selection);
    if (activeSessionRef.current?.key !== sessionKey) {
      activeSessionRef.current = {
        key: sessionKey,
        runner: createEntrySession(selection),
      };
    }
    setPending(true);
    setMessage(selection.action === "join" ? "Joining the lobby..." : "Rejoining the lobby...");
    try {
      const entry = await activeSessionRef.current.runner.run();
      setResult(entry);
      setEntryLocked(true);
      setRetryAvailable(false);
      setMessage(
        entry.participant.roundEligibility === "waiting"
          ? `${entry.participant.username} joined ${entry.lobby.code} and is waiting to play next round.`
          : `${entry.participant.username} joined ${entry.lobby.code} and is ready to play.`,
      );
    } catch (error) {
      const flowError =
        error instanceof LobbyEntryFlowError
          ? error
          : new LobbyEntryFlowError("We could not confirm the server response.", {
              ambiguous: true,
              retryable: true,
            });
      if (selection.action === "rejoin" && flowError.code === "UNAUTHORIZED") {
        activeSessionRef.current = null;
        setEntryLocked(false);
        setRetryAvailable(true);
        setSessionStatus({
          schemaVersion: 1,
          type: "same-device-session-status",
          status: "new-participant-required",
        });
        setMessage("That rejoin window has ended. Join as a new participant.");
      } else {
        setEntryLocked(flowError.ambiguous);
        setRetryAvailable(flowError.retryable);
        if (!flowError.ambiguous) activeSessionRef.current = null;
        setMessage(flowError.message);
      }
    } finally {
      setPending(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (formRef.current?.contains(document.activeElement)) {
      focusTransferAllowedRef.current = true;
    }
    if (pending || result !== null) return;
    if (sessionStatus === null || checkedCode === null) {
      await findLobby();
      return;
    }
    if (sessionStatus.status === "new-participant-required") {
      const normalized = normalizeUsername(username);
      if (!normalized.ok) {
        setUsernameError(normalized.error.message);
        usernameRef.current?.focus();
        return;
      }
      setUsername(normalized.username);
      setUsernameError(undefined);
      await enterLobby({ action: "join", code: checkedCode, username: normalized.username });
      return;
    }
    if (sessionStatus.status === "rejoin-available") {
      await enterLobby({ action: "rejoin", code: checkedCode });
    }
  }

  const codeDisabled = pending || entryLocked || result !== null;
  const showFind = sessionStatus === null && result === null;

  return (
    <form
      aria-label="Join a private lobby"
      className="join-form"
      noValidate
      onSubmit={handleSubmit}
      ref={formRef}
    >
      <div className="form-heading">
        <p className="eyebrow">Have a code?</p>
        <h2>Join the game</h2>
        <p>
          Enter the six-character code from your host. The code finds the lobby; it is not your
          identity.
        </p>
      </div>
      <Input
        autoCapitalize="characters"
        autoComplete="off"
        disabled={codeDisabled}
        errorMessage={codeError}
        id="lobby-code"
        label="Lobby code"
        maxLength={6}
        name="lobbyCode"
        onChange={(event) => {
          setCode(normalizeLobbyCodeEntry(event.currentTarget.value));
          setCodeError(undefined);
          resetEntryState();
        }}
        ref={codeRef}
        required
        value={code}
      />

      {sessionStatus?.status === "new-participant-required" && result === null ? (
        <Input
          autoComplete="nickname"
          disabled={pending || entryLocked}
          errorMessage={usernameError}
          id="player-name"
          label="Player name"
          maxLength={128}
          name="playerName"
          onChange={(event) => {
            setUsername(event.currentTarget.value);
            setUsernameError(undefined);
            setMessage("");
            if (!entryLocked) {
              activeSessionRef.current = null;
              setRetryAvailable(true);
            }
          }}
          ref={usernameRef}
          required
          value={username}
        />
      ) : null}

      {showFind ? (
        <Button
          disabled={pending}
          onClick={() => {
            focusTransferAllowedRef.current = true;
          }}
          type="submit"
        >
          {pending ? "Finding lobby..." : "Find lobby"}
        </Button>
      ) : sessionStatus?.status === "new-participant-required" &&
        result === null &&
        retryAvailable ? (
        <Button
          disabled={pending}
          onClick={() => {
            focusTransferAllowedRef.current = true;
          }}
          type="submit"
        >
          {pending ? "Joining lobby..." : entryLocked ? "Retry join" : "Join lobby"}
        </Button>
      ) : sessionStatus?.status === "rejoin-available" && result === null ? (
        <Button
          disabled={pending}
          onClick={() => {
            focusTransferAllowedRef.current = true;
          }}
          ref={rejoinButtonRef}
          type="submit"
        >
          {pending ? "Rejoining lobby..." : `Rejoin as ${sessionStatus.username}`}
        </Button>
      ) : null}

      <div aria-live="polite" className="form-status" role="status">
        {sessionStatus?.status === "active" && message.length === 0
          ? `This device is already active as ${sessionStatus.username}.`
          : message}
      </div>
    </form>
  );
}
