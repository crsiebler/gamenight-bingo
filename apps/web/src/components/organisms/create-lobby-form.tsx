"use client";

import { useRef, useState, type FormEvent } from "react";

import type { AutomaticCallInterval, CallConfiguration } from "@gamenight-bingo/contracts";
import { themeCatalog } from "@gamenight-bingo/themes";

import { Button, LinkButton, Option } from "@/atoms";
import { Input, Select } from "@/molecules";
import {
  CreateLobbyFlowError,
  CreateLobbyFlowSession,
  type CreateLobbyFlowResult,
  type CreateLobbySelection,
} from "@/lib/create-lobby-flow";

export const THEME_OPTIONS = themeCatalog;

const AUTOMATIC_INTERVALS = [5, 10, 30, 60, 120] as const;

type PatternOption = {
  category: "standard" | "shape" | "letter" | "number" | "christmas";
  id: string;
  name: string;
};

const PATTERN_CATEGORIES = [
  { id: "standard", label: "Standard patterns", optionLabel: "Standard" },
  { id: "shape", label: "Shape patterns", optionLabel: "Shape" },
  { id: "letter", label: "Letter patterns", optionLabel: "Letter" },
  { id: "number", label: "Number patterns", optionLabel: "Number" },
  { id: "christmas", label: "Christmas patterns", optionLabel: "Christmas" },
] as const;

type CreateLobbyRunner = {
  readonly hasCreatedLobby: boolean;
  run(): Promise<CreateLobbyFlowResult>;
};

export type CreateLobbySessionFactory = (selection: CreateLobbySelection) => CreateLobbyRunner;

type CreateLobbyFormProps = {
  patterns: readonly PatternOption[];
  createSession?: CreateLobbySessionFactory;
};

const defaultCreateSession: CreateLobbySessionFactory = (selection) =>
  new CreateLobbyFlowSession(selection);

function intervalFromValue(value: string): AutomaticCallInterval {
  const interval = Number(value);
  if (!AUTOMATIC_INTERVALS.includes(interval as AutomaticCallInterval)) {
    return 30;
  }
  return interval as AutomaticCallInterval;
}

export function CreateLobbyForm({
  patterns,
  createSession = defaultCreateSession,
}: CreateLobbyFormProps) {
  const hostNameRef = useRef<HTMLInputElement>(null);
  const themeRef = useRef<HTMLSelectElement>(null);
  const activeSessionRef = useRef<CreateLobbyRunner | null>(null);
  const [username, setUsername] = useState("");
  const [themeId, setThemeId] = useState("");
  const [patternId, setPatternId] = useState("standard-one-line");
  const [callMode, setCallMode] = useState<CallConfiguration["mode"]>("manual");
  const [interval, setInterval] = useState("30");
  const [hostNameError, setHostNameError] = useState<string | undefined>();
  const [themeError, setThemeError] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [locked, setLocked] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(true);
  const [result, setResult] = useState<CreateLobbyFlowResult | null>(null);

  const fieldsDisabled = submitting || locked || result !== null;
  const duplicatePatternNames = new Set(
    patterns.map(({ name }) => name).filter((name, index, names) => names.indexOf(name) !== index),
  );

  function resetUnstartedSession() {
    if (activeSessionRef.current?.hasCreatedLobby === true) return;
    activeSessionRef.current = null;
    setLocked(false);
    setRetryAvailable(true);
    setMessage("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextHostNameError = username.trim().length === 0 ? "Enter a host name." : undefined;
    const nextThemeError = themeId.length === 0 ? "Choose a theme." : undefined;
    setHostNameError(nextHostNameError);
    setThemeError(nextThemeError);
    if (nextHostNameError !== undefined) {
      hostNameRef.current?.focus();
      return;
    }
    if (nextThemeError !== undefined) {
      themeRef.current?.focus();
      return;
    }

    const callConfiguration: CallConfiguration =
      callMode === "manual"
        ? { mode: "manual" }
        : { mode: "automatic", intervalSeconds: intervalFromValue(interval) };
    activeSessionRef.current ??= createSession({
      username,
      themeId,
      patternId,
      callConfiguration,
    });
    setSubmitting(true);
    setRetryAvailable(true);
    setMessage("Creating your private lobby...");
    try {
      const created = await activeSessionRef.current.run();
      setResult(created);
      setLocked(true);
      setMessage(`Lobby ${created.code} is ready for ${created.username}.`);
    } catch (error) {
      const flowError =
        error instanceof CreateLobbyFlowError
          ? error
          : new CreateLobbyFlowError("The server response could not be confirmed.", {
              ambiguous: true,
              retryable: true,
            });
      const retainSession = activeSessionRef.current.hasCreatedLobby || flowError.ambiguous;
      setLocked(retainSession);
      setRetryAvailable(flowError.retryable);
      if (!retainSession) activeSessionRef.current = null;
      setMessage(
        flowError.retryable
          ? retainSession
            ? `${activeSessionRef.current?.hasCreatedLobby === true ? "Your lobby exists, but setup did not finish." : "We could not confirm whether the lobby was created."} ${flowError.message}`
            : flowError.message
          : retainSession
            ? `Setup cannot continue in this browser session. ${flowError.message} Reload to create a new lobby.`
            : `${flowError.message} Edit your setup and try again.`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      aria-label="Create a private lobby"
      className="create-form"
      noValidate
      onSubmit={handleSubmit}
    >
      <div className="form-heading">
        <p className="eyebrow">Host setup</p>
        <h2>Build your game</h2>
        <p>Choose the mood and pace now. You can invite players after the lobby is ready.</p>
      </div>

      <Input
        autoComplete="nickname"
        disabled={fieldsDisabled}
        errorMessage={hostNameError}
        id="host-name"
        label="Host name"
        maxLength={128}
        name="hostName"
        onChange={(event) => {
          setUsername(event.currentTarget.value);
          setHostNameError(undefined);
          resetUnstartedSession();
        }}
        ref={hostNameRef}
        required
        value={username}
      />

      <Select
        disabled={fieldsDisabled}
        errorMessage={themeError}
        id="theme"
        label="Theme"
        name="theme"
        onChange={(event) => {
          setThemeId(event.currentTarget.value);
          setThemeError(undefined);
          resetUnstartedSession();
        }}
        ref={themeRef}
        required
        value={themeId}
      >
        <Option disabled value="">
          Choose a theme
        </Option>
        {THEME_OPTIONS.map((theme) => (
          <Option key={theme.id} value={theme.id}>
            {theme.name}
          </Option>
        ))}
      </Select>

      <Select
        disabled={fieldsDisabled}
        id="pattern"
        label="Winning pattern"
        name="pattern"
        onChange={(event) => {
          setPatternId(event.currentTarget.value);
          resetUnstartedSession();
        }}
        required
        value={patternId}
      >
        {PATTERN_CATEGORIES.map((category) => {
          const categoryPatterns = patterns.filter((pattern) => pattern.category === category.id);
          return categoryPatterns.length > 0 ? (
            <optgroup key={category.id} label={category.label}>
              {categoryPatterns.map((pattern) => (
                <Option key={pattern.id} value={pattern.id}>
                  {duplicatePatternNames.has(pattern.name)
                    ? `${pattern.name} (${category.optionLabel})`
                    : pattern.name}
                </Option>
              ))}
            </optgroup>
          ) : null;
        })}
      </Select>

      <Select
        description="Manual waits for the host. Automatic calls on the selected interval."
        disabled={fieldsDisabled}
        id="call-mode"
        label="Call mode"
        name="callMode"
        onChange={(event) => {
          setCallMode(event.currentTarget.value as CallConfiguration["mode"]);
          resetUnstartedSession();
        }}
        required
        value={callMode}
      >
        <Option value="manual">Manual</Option>
        <Option value="automatic">Automatic</Option>
      </Select>

      {callMode === "automatic" ? (
        <Select
          disabled={fieldsDisabled}
          id="call-interval"
          label="Call interval"
          name="callInterval"
          onChange={(event) => {
            setInterval(event.currentTarget.value);
            resetUnstartedSession();
          }}
          required
          value={interval}
        >
          {AUTOMATIC_INTERVALS.map((seconds) => (
            <Option key={seconds} value={String(seconds)}>
              {seconds} seconds
            </Option>
          ))}
        </Select>
      ) : null}

      {result === null && retryAvailable ? (
        <Button disabled={submitting} type="submit">
          {submitting ? "Creating lobby..." : locked ? "Retry setup" : "Create lobby"}
        </Button>
      ) : null}

      <div aria-live="polite" className="form-status" role="status">
        {message}
      </div>

      {result !== null ? (
        <section aria-label="Lobby created" className="lobby-ready">
          <span>Your lobby code</span>
          <strong>{result.code}</strong>
          <p>Open the private lobby to invite players and start the round.</p>
          <LinkButton href={`/lobbies/${result.code}`}>Open lobby</LinkButton>
        </section>
      ) : null}
    </form>
  );
}
