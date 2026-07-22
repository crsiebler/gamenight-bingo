export const ACTIVE_LOBBY_EVENT_CHANNEL = "gamenight_active_lobby_events";

export interface ActiveLobbyEventReference {
  readonly lobbyId: string;
  readonly sequence: bigint;
}

export function encodeActiveLobbyEventReference(lobbyId: string, sequence: bigint): string {
  return JSON.stringify({ lobbyId, sequence: sequence.toString() });
}

export function parseActiveLobbyEventReference(payload: string): ActiveLobbyEventReference | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !("lobbyId" in parsed) ||
      !("sequence" in parsed) ||
      typeof parsed.lobbyId !== "string" ||
      parsed.lobbyId.length === 0 ||
      typeof parsed.sequence !== "string" ||
      !/^[1-9]\d*$/.test(parsed.sequence)
    ) {
      return null;
    }
    return { lobbyId: parsed.lobbyId, sequence: BigInt(parsed.sequence) };
  } catch {
    return null;
  }
}
