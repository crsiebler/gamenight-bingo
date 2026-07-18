import {
  CommandAckSchema,
  ConfigureCommandSchema,
  CONTRACT_SCHEMA_VERSION,
  ErrorSchema,
  MarkCardCommandSchema,
  SnapshotMessageSchema,
  StartRoundCommandSchema,
  type CallConfiguration,
  type CommandAck,
  type Snapshot,
} from "@gamenight-bingo/contracts";

type Requester = (path: string, init?: RequestInit) => Promise<Response>;

export type WaitingLobbyCommand =
  | {
      type: "configure";
      code: string;
      patternId: string;
      callConfiguration: CallConfiguration;
    }
  | { type: "start-round"; code: string };

export type WaitingLobbyCommandAck = Extract<CommandAck, { scope: "active-lobby" }>;
export type MarkCardCommandSelection = { ball: number; code: string };

export class PrivateLobbyFlowError extends Error {
  readonly ambiguous: boolean;
  readonly code: string | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { ambiguous?: boolean; code?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "PrivateLobbyFlowError";
    this.ambiguous = options.ambiguous ?? false;
    this.code = options.code;
    this.retryable = options.retryable ?? true;
  }
}

function ambiguousCommandError(): PrivateLobbyFlowError {
  return new PrivateLobbyFlowError(
    "We could not confirm the server response. Retry to safely check the same command.",
    { ambiguous: true, retryable: true },
  );
}

async function responseValue(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function loadPrivateLobbySnapshot(
  code: string,
  request: Requester = (path, init) => fetch(path, init),
): Promise<Snapshot> {
  let response: Response;
  try {
    response = await request(`/api/v1/lobbies/${code}/snapshot`, {
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new PrivateLobbyFlowError("We could not reach the private lobby. Try again.");
  }
  const value = await responseValue(response);
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(value);
    if (parsed.success && parsed.data.commandId === null) {
      throw new PrivateLobbyFlowError(parsed.data.message, {
        code: parsed.data.code,
        retryable: parsed.data.retryable,
      });
    }
    throw new PrivateLobbyFlowError("We could not confirm the private lobby response.");
  }
  const parsed = SnapshotMessageSchema.safeParse(value);
  if (!parsed.success || parsed.data.snapshot.lobby.code !== code) {
    throw new PrivateLobbyFlowError("We could not confirm the private lobby response.");
  }
  return parsed.data.snapshot;
}

export class WaitingLobbyCommandSession {
  readonly #commandId: string;
  readonly #request: Requester;
  readonly #selection: WaitingLobbyCommand;
  #running: Promise<WaitingLobbyCommandAck> | null = null;

  constructor(
    selection: WaitingLobbyCommand,
    dependencies: { request?: Requester; nextCommandId?: () => string } = {},
  ) {
    this.#selection = selection;
    this.#request = dependencies.request ?? ((path, init) => fetch(path, init));
    this.#commandId = (dependencies.nextCommandId ?? (() => globalThis.crypto.randomUUID()))();
  }

  run(): Promise<WaitingLobbyCommandAck> {
    this.#running ??= this.#runCommand().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #runCommand(): Promise<WaitingLobbyCommandAck> {
    const command =
      this.#selection.type === "configure"
        ? ConfigureCommandSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "configure",
            commandId: this.#commandId,
            patternId: this.#selection.patternId,
            callConfiguration: this.#selection.callConfiguration,
          })
        : StartRoundCommandSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "start-round",
            commandId: this.#commandId,
          });
    const path =
      this.#selection.type === "configure"
        ? `/api/v1/lobbies/${this.#selection.code}/configuration`
        : `/api/v1/lobbies/${this.#selection.code}/rounds/current/start`;
    let response: Response;
    try {
      response = await this.#request(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
    } catch {
      throw ambiguousCommandError();
    }
    const value = await responseValue(response);
    if (!response.ok) {
      const parsedError = ErrorSchema.safeParse(value);
      if (!parsedError.success || parsedError.data.commandId !== this.#commandId) {
        throw ambiguousCommandError();
      }
      throw new PrivateLobbyFlowError(parsedError.data.message, {
        code: parsedError.data.code,
        retryable: parsedError.data.retryable,
      });
    }
    const acknowledgement = CommandAckSchema.safeParse(value);
    if (
      !acknowledgement.success ||
      acknowledgement.data.commandId !== this.#commandId ||
      acknowledgement.data.scope !== "active-lobby"
    ) {
      throw ambiguousCommandError();
    }
    return acknowledgement.data;
  }
}

export class MarkCardCommandSession {
  readonly #commandId: string;
  readonly #request: Requester;
  readonly #selection: MarkCardCommandSelection;
  #running: Promise<CommandAck> | null = null;

  constructor(
    selection: MarkCardCommandSelection,
    dependencies: { request?: Requester; nextCommandId?: () => string } = {},
  ) {
    this.#selection = selection;
    this.#request = dependencies.request ?? ((path, init) => fetch(path, init));
    this.#commandId = (dependencies.nextCommandId ?? (() => globalThis.crypto.randomUUID()))();
  }

  run(): Promise<CommandAck> {
    this.#running ??= this.#runCommand().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #runCommand(): Promise<CommandAck> {
    const command = MarkCardCommandSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      type: "mark-card",
      commandId: this.#commandId,
      ball: this.#selection.ball,
    });
    let response: Response;
    try {
      response = await this.#request(`/api/v1/lobbies/${this.#selection.code}/cards/own/marks`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
    } catch {
      throw ambiguousCommandError();
    }
    const value = await responseValue(response);
    if (!response.ok) {
      const parsedError = ErrorSchema.safeParse(value);
      if (!parsedError.success || parsedError.data.commandId !== this.#commandId) {
        throw ambiguousCommandError();
      }
      throw new PrivateLobbyFlowError(parsedError.data.message, {
        code: parsedError.data.code,
        retryable: parsedError.data.retryable,
      });
    }
    const acknowledgement = CommandAckSchema.safeParse(value);
    if (!acknowledgement.success || acknowledgement.data.commandId !== this.#commandId) {
      throw ambiguousCommandError();
    }
    return acknowledgement.data;
  }
}
