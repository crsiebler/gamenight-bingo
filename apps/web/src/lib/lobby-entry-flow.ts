import {
  CONTRACT_SCHEMA_VERSION,
  ErrorSchema,
  JoinLobbyRequestSchema,
  LobbyCodeSchema,
  LobbyEntryResponseSchema,
  RejoinLobbyRequestSchema,
  SameDeviceSessionStatusResponseSchema,
  type ErrorCode,
  type LobbyEntryResponse,
  type SameDeviceSessionStatusResponse,
} from "@gamenight-bingo/contracts";

export type LobbyEntrySelection =
  | { readonly action: "join"; readonly code: string; readonly username: string }
  | { readonly action: "rejoin"; readonly code: string };

type Requester = (path: string, init?: RequestInit) => Promise<Response>;

type LobbyEntryFlowDependencies = {
  nextCommandId?: () => string;
  request?: Requester;
};

type SessionLookupDependencies = {
  request?: Requester;
};

const defaultRequest: Requester = (path, init) => fetch(path, init);

export class LobbyEntryFlowError extends Error {
  readonly ambiguous: boolean;
  readonly code: ErrorCode | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      readonly ambiguous: boolean;
      readonly code?: ErrorCode | null;
      readonly retryable: boolean;
    },
  ) {
    super(message);
    this.name = "LobbyEntryFlowError";
    this.ambiguous = options.ambiguous;
    this.code = options.code ?? null;
    this.retryable = options.retryable;
  }
}

function defaultCommandId(): string {
  return globalThis.crypto.randomUUID();
}

function ambiguousMutationError(): LobbyEntryFlowError {
  return new LobbyEntryFlowError(
    "We could not confirm the server response. Try again to safely replay the same request.",
    { ambiguous: true, retryable: true },
  );
}

function correlatedMutationError(value: unknown, commandId: string): LobbyEntryFlowError {
  const parsed = ErrorSchema.safeParse(value);
  if (!parsed.success || parsed.data.commandId !== commandId) return ambiguousMutationError();
  return new LobbyEntryFlowError(parsed.data.message, {
    ambiguous: false,
    code: parsed.data.code,
    retryable: parsed.data.retryable,
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function lookupSameDeviceSession(
  code: string,
  dependencies: SessionLookupDependencies = {},
): Promise<SameDeviceSessionStatusResponse> {
  const lobbyCode = LobbyCodeSchema.parse(code);
  let response: Response;
  try {
    response = await (dependencies.request ?? defaultRequest)(
      `/api/v1/lobbies/${lobbyCode}/session`,
      { credentials: "same-origin", method: "GET" },
    );
  } catch {
    throw new LobbyEntryFlowError("We could not check that lobby. Try again.", {
      ambiguous: false,
      retryable: true,
    });
  }
  const value = await readJson(response);
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(value);
    const message =
      parsed.success && parsed.data.code === "NOT_FOUND"
        ? "We couldn't find a lobby with that code. Check the code and try again."
        : parsed.success
          ? parsed.data.message
          : "We could not check that lobby. Try again.";
    throw new LobbyEntryFlowError(message, {
      ambiguous: false,
      code: parsed.success ? parsed.data.code : null,
      retryable: parsed.success ? parsed.data.retryable : true,
    });
  }
  const parsed = SameDeviceSessionStatusResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new LobbyEntryFlowError("We could not verify that lobby. Try again.", {
      ambiguous: false,
      retryable: true,
    });
  }
  return parsed.data;
}

export class LobbyEntryFlowSession {
  readonly #commandId: string;
  readonly #request: Requester;
  readonly #selection: LobbyEntrySelection;
  #running: Promise<LobbyEntryResponse> | null = null;

  constructor(selection: LobbyEntrySelection, dependencies: LobbyEntryFlowDependencies = {}) {
    this.#selection = selection;
    this.#request = dependencies.request ?? defaultRequest;
    this.#commandId = (dependencies.nextCommandId ?? defaultCommandId)();
  }

  run(): Promise<LobbyEntryResponse> {
    this.#running ??= this.#submit().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #submit(): Promise<LobbyEntryResponse> {
    const code = LobbyCodeSchema.parse(this.#selection.code);
    const command =
      this.#selection.action === "join"
        ? JoinLobbyRequestSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            commandId: this.#commandId,
            username: this.#selection.username,
          })
        : RejoinLobbyRequestSchema.parse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            commandId: this.#commandId,
          });
    const path =
      this.#selection.action === "join"
        ? `/api/v1/lobbies/${code}/participants`
        : `/api/v1/lobbies/${code}/session/rejoin`;
    let response: Response;
    try {
      response = await this.#request(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
    } catch {
      throw ambiguousMutationError();
    }
    const value = await readJson(response);
    if (!response.ok) throw correlatedMutationError(value, this.#commandId);
    const parsed = LobbyEntryResponseSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.commandId !== this.#commandId ||
      parsed.data.lobby.code !== code
    ) {
      throw ambiguousMutationError();
    }
    if (this.#selection.action === "join" && parsed.data.idempotentReplay) {
      let status: SameDeviceSessionStatusResponse;
      try {
        status = await lookupSameDeviceSession(code, { request: this.#request });
      } catch {
        throw ambiguousMutationError();
      }
      if (
        status.status !== "active" ||
        status.role !== "player" ||
        status.username !== parsed.data.participant.username
      ) {
        throw new LobbyEntryFlowError(
          "This browser did not receive the private session. Edit your name to join as a new participant.",
          { ambiguous: false, code: "UNAUTHORIZED", retryable: false },
        );
      }
    }
    return parsed.data;
  }
}
