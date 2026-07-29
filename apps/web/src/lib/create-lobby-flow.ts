import {
  CONTRACT_SCHEMA_VERSION,
  CreateLobbyRequestSchema,
  ErrorSchema,
  LobbyEntryResponseSchema,
  type CallConfiguration,
  type LobbyEntryResponse,
} from "@gamenight-bingo/contracts";

import { MUTATION_REQUEST_HEADERS } from "../http-security.js";

export type CreateLobbySelection = {
  username: string;
  themeId: string;
  patternId: string;
  callConfiguration: CallConfiguration;
};

export type CreateLobbyFlowResult = CreateLobbySelection & {
  code: string;
};

type Requester = (path: string, init?: RequestInit) => Promise<Response>;

type CreateLobbyFlowDependencies = {
  request?: Requester;
  nextCommandId?: () => string;
};

const defaultRequest: Requester = (path, init) => fetch(path, init);

export class CreateLobbyFlowError extends Error {
  readonly ambiguous: boolean;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly ambiguous: boolean; readonly retryable: boolean },
  ) {
    super(message);
    this.name = "CreateLobbyFlowError";
    this.ambiguous = options.ambiguous;
    this.retryable = options.retryable;
  }
}

function defaultCommandId(): string {
  return globalThis.crypto.randomUUID();
}

function ambiguousResponseError(): CreateLobbyFlowError {
  return new CreateLobbyFlowError(
    "We could not confirm the server response. Retry creation to safely check the same command.",
    { ambiguous: true, retryable: true },
  );
}

function contractError(value: unknown, expectedCommandId: string): CreateLobbyFlowError {
  const parsed = ErrorSchema.safeParse(value);
  if (!parsed.success || parsed.data.commandId !== expectedCommandId) {
    return ambiguousResponseError();
  }
  return new CreateLobbyFlowError(parsed.data.message, {
    ambiguous: false,
    retryable: parsed.data.retryable,
  });
}

export class CreateLobbyFlowSession {
  readonly #selection: CreateLobbySelection;
  readonly #request: Requester;
  readonly #commandId: string;
  #entry: LobbyEntryResponse | null = null;
  #running: Promise<CreateLobbyFlowResult> | null = null;

  constructor(selection: CreateLobbySelection, dependencies: CreateLobbyFlowDependencies = {}) {
    const nextCommandId = dependencies.nextCommandId ?? defaultCommandId;
    this.#selection = selection;
    this.#request = dependencies.request ?? defaultRequest;
    this.#commandId = nextCommandId();
  }

  get hasCreatedLobby(): boolean {
    return this.#entry !== null;
  }

  run(): Promise<CreateLobbyFlowResult> {
    this.#running ??= this.#run().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #post(path: string, body: unknown, expectedCommandId: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#request(path, {
        method: "POST",
        credentials: "same-origin",
        headers: MUTATION_REQUEST_HEADERS,
        body: JSON.stringify(body),
      });
    } catch {
      throw ambiguousResponseError();
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      if (response.ok) throw ambiguousResponseError();
      throw contractError(null, expectedCommandId);
    }
    if (!response.ok) throw contractError(value, expectedCommandId);
    return value;
  }

  async #run(): Promise<CreateLobbyFlowResult> {
    if (this.#entry === null) {
      const command = CreateLobbyRequestSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        commandId: this.#commandId,
        username: this.#selection.username,
        themeId: this.#selection.themeId,
        patternId: this.#selection.patternId,
        callConfiguration: this.#selection.callConfiguration,
      });
      const parsed = LobbyEntryResponseSchema.safeParse(
        await this.#post("/api/v1/lobbies", command, this.#commandId),
      );
      if (!parsed.success || parsed.data.commandId !== this.#commandId) {
        throw ambiguousResponseError();
      }
      this.#entry = parsed.data;
    }

    const code = this.#entry.lobby.code;
    return {
      ...this.#selection,
      code,
      username: this.#entry.participant.username,
      themeId: this.#entry.lobby.themeId,
    };
  }
}
