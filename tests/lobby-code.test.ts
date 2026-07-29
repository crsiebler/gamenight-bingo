import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { generateLobbyCode, normalizeLobbyCodeEntry } from "../packages/domain/src/index.js";
import type { CryptographicRandomBytes } from "../packages/domain/src/index.js";

const LOBBY_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

function createSeededRandomBytes(seed: number): CryptographicRandomBytes {
  let state = seed === 0 ? 0x9e3779b9 : seed >>> 0;

  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

describe("lobby codes", () => {
  it("generates six-character codes from the unambiguous uppercase alphabet", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        expect(generateLobbyCode(createSeededRandomBytes(seed))).toMatch(LOBBY_CODE_PATTERN);
      }),
      { numRuns: 200 },
    );
  });

  it("maps injected random bytes deterministically without ambiguous characters", () => {
    let value = 0;
    const randomBytes: CryptographicRandomBytes = (length) => {
      const bytes = new Uint8Array(length).fill(value * 33);
      value += 1;
      return bytes;
    };

    expect(generateLobbyCode(randomBytes)).toBe("ABCDEF");
  });

  it("rejects a random source that returns the wrong byte count", () => {
    expect(() => generateLobbyCode(() => new Uint8Array())).toThrow(RangeError);
  });

  it("normalizes lowercase and mixed-case entry without accepting other changes", () => {
    expect(normalizeLobbyCodeEntry("ab2x9z")).toBe("AB2X9Z");
    expect(normalizeLobbyCodeEntry("aB2x9Z")).toBe("AB2X9Z");
    expect(normalizeLobbyCodeEntry(" ab2x9z ")).toBe(" AB2X9Z ");
    expect(normalizeLobbyCodeEntry("ab0o1i")).toBe("AB0O1I");
    expect(normalizeLobbyCodeEntry("ſbcdef")).toBe("ſBCDEF");
  });
});
