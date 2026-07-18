import { io } from "socket.io-client";

import {
  ActiveLobbyEventSchema,
  CONTRACT_SCHEMA_VERSION,
  ErrorSchema,
  ParticipantPrivateEventSchema,
  RealtimeTicketResponseSchema,
  SnapshotMessageSchema,
  type ActiveLobbyEvent,
  type ParticipantPrivateEvent,
  type Snapshot,
} from "@gamenight-bingo/contracts";

export type PrivateLobbyConnectionState =
  "connected" | "expired" | "offline" | "reconnecting" | "recovered" | "snapshot-syncing";

export type PrivateLobbyRealtimeHandlers = {
  onConnectionState(state: PrivateLobbyConnectionState): void;
  onLobbyEvent(event: ActiveLobbyEvent): void;
  onPrivateEvent?(event: ParticipantPrivateEvent): void;
  onSnapshot(snapshot: Snapshot): void;
};

export type PrivateLobbyRealtimeConnection = {
  close(): void;
  requestResync(lastEventSequence: number | null): void;
};

type RealtimeSocket = {
  close(): void;
  emit(event: string, payload: unknown): void;
  on(event: string, listener: (...arguments_: unknown[]) => void): void;
};

type SocketOptions = {
  auth: { schemaVersion: typeof CONTRACT_SCHEMA_VERSION; ticket: string };
  reconnection: false;
  transports: ["websocket"];
};

export type PrivateLobbyRealtimeOptions = {
  code: string;
  handlers: PrivateLobbyRealtimeHandlers;
  serverUrl?: string;
  issueTicket?: (code: string) => Promise<string>;
  createSocket?: (serverUrl: string | undefined, options: SocketOptions) => RealtimeSocket;
  scheduleRetry?: (retry: () => void, delayMilliseconds: number) => unknown;
  cancelRetry?: (handle: unknown) => void;
};

export async function parseRealtimeTicketResponse(response: Response): Promise<string> {
  if (!response.ok) {
    let code: string | undefined;
    let retryable = true;
    try {
      const parsed = ErrorSchema.safeParse(await response.json());
      if (parsed.success) {
        code = parsed.data.code;
        retryable = parsed.data.retryable;
      }
    } catch {
      // An unreadable response is ambiguous and safe to retry with a fresh ticket request.
    }
    throw Object.assign(new Error("A realtime connection ticket could not be issued."), {
      ...(code === undefined ? {} : { code }),
      retryable,
    });
  }
  return RealtimeTicketResponseSchema.parse(await response.json()).ticket;
}

async function issueRealtimeTicket(code: string): Promise<string> {
  const response = await fetch(`/api/v1/lobbies/${encodeURIComponent(code)}/realtime-ticket`, {
    body: JSON.stringify({ schemaVersion: CONTRACT_SCHEMA_VERSION }),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return parseRealtimeTicketResponse(response);
}

function parseSocketError(error: unknown) {
  const candidate =
    typeof error === "object" && error !== null && "data" in error ? error.data : error;
  return ErrorSchema.safeParse(candidate);
}

function isExpiredErrorCode(code: string): boolean {
  return code === "UNAUTHORIZED" || code === "NOT_FOUND" || code === "LOBBY_EXPIRED";
}

function terminalTicketState(error: unknown): "expired" | "offline" | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("retryable" in error) ||
    error.retryable !== false
  ) {
    return null;
  }
  return "code" in error && typeof error.code === "string" && isExpiredErrorCode(error.code)
    ? "expired"
    : "offline";
}

const createRealtimeSocket = (serverUrl: string | undefined, options: SocketOptions) =>
  io(serverUrl, options) as RealtimeSocket;

export function connectPrivateLobbyRealtime(
  options: PrivateLobbyRealtimeOptions,
): PrivateLobbyRealtimeConnection {
  const issueTicket = options.issueTicket ?? issueRealtimeTicket;
  const createSocket = options.createSocket ?? createRealtimeSocket;
  const scheduleRetry = options.scheduleRetry ?? ((retry, delay) => setTimeout(retry, delay));
  const cancelRetry = options.cancelRetry ?? ((handle) => clearTimeout(handle as number));
  let closed = false;
  let terminal = false;
  let currentSocket: RealtimeSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let retryHandle: unknown = null;
  let retryAttempt = 0;

  const clearHeartbeat = () => {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
  };
  const failClosed = (socket: RealtimeSocket, state: "expired" | "offline" = "offline") => {
    if (socket !== currentSocket) return;
    terminal = true;
    currentSocket = null;
    clearHeartbeat();
    options.handlers.onConnectionState(state);
    socket.close();
  };

  const scheduleReconnect = () => {
    if (closed || terminal || retryHandle !== null) return;
    options.handlers.onConnectionState("offline");
    const delay = Math.min(1_000 * 2 ** retryAttempt, 10_000);
    retryAttempt += 1;
    retryHandle = scheduleRetry(() => {
      retryHandle = null;
      void connect(true);
    }, delay);
  };

  async function connect(reconnecting: boolean) {
    if (closed || terminal) return;
    options.handlers.onConnectionState(reconnecting ? "reconnecting" : "snapshot-syncing");
    let ticket: string;
    try {
      ticket = await issueTicket(options.code);
    } catch (error) {
      const terminalState = terminalTicketState(error);
      if (terminalState !== null) {
        terminal = true;
        options.handlers.onConnectionState(terminalState);
        return;
      }
      scheduleReconnect();
      return;
    }
    if (closed || terminal) return;

    const socket = createSocket(options.serverUrl, {
      auth: { schemaVersion: CONTRACT_SCHEMA_VERSION, ticket },
      reconnection: false,
      transports: ["websocket"],
    });
    currentSocket = socket;
    socket.on("connect", () => {
      if (socket !== currentSocket || closed || terminal) return;
      options.handlers.onConnectionState("snapshot-syncing");
      clearHeartbeat();
      heartbeat = setInterval(() => {
        if (socket === currentSocket && !closed && !terminal) {
          socket.emit("v1:command", {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            type: "heartbeat",
          });
        }
      }, 30_000);
    });
    socket.on("v1:snapshot", (message) => {
      if (socket !== currentSocket || closed || terminal) return;
      const parsed = SnapshotMessageSchema.safeParse(message);
      if (!parsed.success) {
        failClosed(socket);
        return;
      }
      retryAttempt = 0;
      options.handlers.onSnapshot(parsed.data.snapshot);
    });
    socket.on("v1:lobby-event", (event) => {
      if (socket !== currentSocket || closed || terminal) return;
      const parsed = ActiveLobbyEventSchema.safeParse(event);
      if (!parsed.success) {
        failClosed(socket);
        return;
      }
      options.handlers.onLobbyEvent(parsed.data);
    });
    socket.on("v1:private-event", (event) => {
      if (socket !== currentSocket || closed || terminal) return;
      const parsed = ParticipantPrivateEventSchema.safeParse(event);
      if (!parsed.success) {
        failClosed(socket);
        return;
      }
      options.handlers.onPrivateEvent?.(parsed.data);
    });
    socket.on("v1:error", (error) => {
      if (socket !== currentSocket || closed || terminal) return;
      const parsed = ErrorSchema.safeParse(error);
      if (!parsed.success || !parsed.data.retryable) {
        failClosed(
          socket,
          parsed.success && isExpiredErrorCode(parsed.data.code) ? "expired" : "offline",
        );
        return;
      }
      currentSocket = null;
      clearHeartbeat();
      socket.close();
      scheduleReconnect();
    });
    socket.on("connect_error", (error) => {
      if (socket !== currentSocket || closed || terminal) return;
      const parsed = parseSocketError(error);
      if (parsed.success && !parsed.data.retryable) {
        failClosed(socket, isExpiredErrorCode(parsed.data.code) ? "expired" : "offline");
        return;
      }
      currentSocket = null;
      clearHeartbeat();
      socket.close();
      scheduleReconnect();
    });
    socket.on("disconnect", () => {
      if (socket !== currentSocket || closed || terminal) return;
      currentSocket = null;
      clearHeartbeat();
      socket.close();
      scheduleReconnect();
    });
  }

  void connect(false);
  return {
    close() {
      if (closed) return;
      closed = true;
      clearHeartbeat();
      if (retryHandle !== null) cancelRetry(retryHandle);
      retryHandle = null;
      currentSocket?.close();
      currentSocket = null;
    },
    requestResync(lastEventSequence) {
      currentSocket?.emit("v1:command", {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        type: "resync",
        lastEventSequence,
      });
    },
  };
}
