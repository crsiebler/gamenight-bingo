import { randomIndex } from "./random.js";
import type { CryptographicRandomBytes } from "./random.js";

const LOBBY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LOBBY_CODE_LENGTH = 6;

export function generateLobbyCode(randomBytes: CryptographicRandomBytes): string {
  let code = "";

  for (let index = 0; index < LOBBY_CODE_LENGTH; index += 1) {
    code += LOBBY_CODE_ALPHABET[randomIndex(LOBBY_CODE_ALPHABET.length, randomBytes)];
  }

  return code;
}

export function normalizeLobbyCodeEntry(input: string): string {
  return input.replace(/[a-z]/g, (character) => character.toUpperCase());
}
