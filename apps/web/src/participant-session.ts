import { createHash } from "node:crypto";

import { LobbyCodeSchema } from "@gamenight-bingo/contracts";

export const PARTICIPANT_SESSION_COOKIE_NAME = "__Secure-gamenight-bingo-session";

const SESSION_ENTROPY_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SESSION_ISSUANCE_ATTEMPTS = 3;

export type ParticipantSessionStatus = "active" | "disconnected";
export type ParticipantRole = "host" | "player";

export interface NewParticipantSession {
  readonly id: string;
  readonly lobbyId: string;
  readonly participantId: string;
  readonly tokenHash: Uint8Array;
  readonly issuedAt: Date;
}

export interface RecognizedParticipantSession {
  readonly sessionId: string;
  readonly lobbyId: string;
  readonly participantId: string;
  readonly username: string;
  readonly role: ParticipantRole;
  readonly status: ParticipantSessionStatus;
}

export interface ParticipantSessionStore {
  createParticipantSession(
    session: NewParticipantSession,
  ): Promise<"created" | "scope-not-found" | "token-hash-collision">;
  findParticipantSessionByTokenHash(input: {
    readonly lobbyId: string;
    readonly tokenHash: Uint8Array;
  }): Promise<RecognizedParticipantSession | null>;
}

export interface ParticipantSessionCookie {
  readonly name: typeof PARTICIPANT_SESSION_COOKIE_NAME;
  readonly value: string;
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "strict";
  readonly path: string;
}

export interface IssueSameDeviceSessionInput {
  readonly sessionId: string;
  readonly lobbyId: string;
  readonly lobbyCode: string;
  readonly participantId: string;
  readonly issuedAt: Date;
}

export interface ParticipantSessionDependencies {
  readonly randomBytes: (length: number) => Uint8Array;
  readonly store: ParticipantSessionStore;
}

export type IssueSameDeviceSessionResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly lobbyId: string;
      readonly participantId: string;
      readonly cookie: ParticipantSessionCookie;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "PARTICIPANT_SESSION_SCOPE_NOT_FOUND";
        readonly message: "The active lobby participant was not found.";
      };
    };

export type ResolveSameDeviceSessionResult =
  | { readonly status: "new-participant-required" }
  | {
      readonly status: "recognized";
      readonly session: RecognizedParticipantSession;
    };

function hashToken(token: string): Uint8Array {
  return createHash("sha256").update(token, "ascii").digest();
}

function isCanonicalSessionToken(token: string): boolean {
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    return false;
  }

  const decoded = Buffer.from(token, "base64url");
  return decoded.length === SESSION_ENTROPY_BYTES && decoded.toString("base64url") === token;
}

export async function issueSameDeviceSession(
  input: IssueSameDeviceSessionInput,
  dependencies: ParticipantSessionDependencies,
): Promise<IssueSameDeviceSessionResult> {
  const lobbyCode = LobbyCodeSchema.parse(input.lobbyCode);

  for (let attempt = 0; attempt < MAX_SESSION_ISSUANCE_ATTEMPTS; attempt += 1) {
    const entropy = dependencies.randomBytes(SESSION_ENTROPY_BYTES);
    if (entropy.length !== SESSION_ENTROPY_BYTES) {
      throw new RangeError("The random byte source must return the requested number of bytes.");
    }
    const token = Buffer.from(entropy).toString("base64url");
    const persisted = await dependencies.store.createParticipantSession({
      id: input.sessionId,
      lobbyId: input.lobbyId,
      participantId: input.participantId,
      tokenHash: hashToken(token),
      issuedAt: input.issuedAt,
    });

    if (persisted === "scope-not-found") {
      return {
        ok: false,
        error: {
          code: "PARTICIPANT_SESSION_SCOPE_NOT_FOUND",
          message: "The active lobby participant was not found.",
        },
      };
    }
    if (persisted === "created") {
      return {
        ok: true,
        sessionId: input.sessionId,
        lobbyId: input.lobbyId,
        participantId: input.participantId,
        cookie: {
          name: PARTICIPANT_SESSION_COOKIE_NAME,
          value: token,
          httpOnly: true,
          secure: true,
          sameSite: "strict",
          path: `/api/v1/lobbies/${lobbyCode}`,
        },
      };
    }
  }

  throw new Error("Unable to issue participant session.");
}

export async function resolveSameDeviceSession(
  lobbyId: string,
  cookieValue: string | undefined,
  store: ParticipantSessionStore,
): Promise<ResolveSameDeviceSessionResult> {
  if (cookieValue === undefined || !isCanonicalSessionToken(cookieValue)) {
    return { status: "new-participant-required" };
  }

  const session = await store.findParticipantSessionByTokenHash({
    lobbyId,
    tokenHash: hashToken(cookieValue),
  });
  return session === null
    ? { status: "new-participant-required" }
    : { status: "recognized", session };
}
