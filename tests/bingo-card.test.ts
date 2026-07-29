import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { generateBingoCards, isBingoCardCellSatisfied } from "../packages/domain/src/index.js";
import type { CryptographicRandomBytes } from "../packages/domain/src/index.js";

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

function expectValidCard(card: readonly (number | "FREE")[]) {
  expect(card).toHaveLength(25);
  expect(card[12]).toBe("FREE");

  for (let column = 0; column < 5; column += 1) {
    const values = card.filter(
      (cell, index): cell is number => index % 5 === column && cell !== "FREE",
    );
    const minimum = column * 15 + 1;

    expect(values).toHaveLength(column === 2 ? 4 : 5);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => value >= minimum && value <= minimum + 14)).toBe(true);
  }
}

describe("Bingo card generation", () => {
  it("generates a valid 75-ball card from injected random bytes", () => {
    const [card] = generateBingoCards(1, createSeededRandomBytes(12345));

    expect(card).toBeDefined();
    expectValidCard(card ?? []);
  });

  it("produces deterministic cards for a deterministic random source", () => {
    expect(generateBingoCards(3, createSeededRandomBytes(42))).toEqual(
      generateBingoCards(3, createSeededRandomBytes(42)),
    );
  });

  it("treats the free center as satisfied without a mark", () => {
    const markedBalls = new Set([7]);

    expect(isBingoCardCellSatisfied("FREE", markedBalls)).toBe(true);
    expect(isBingoCardCellSatisfied(7, markedBalls)).toBe(true);
    expect(isBingoCardCellSatisfied(8, markedBalls)).toBe(false);
  });

  it("rejects round sizes outside the supported participant limit", () => {
    const randomBytes = createSeededRandomBytes(1);

    expect(() => generateBingoCards(0, randomBytes)).toThrow(RangeError);
    expect(() => generateBingoCards(1.5, randomBytes)).toThrow(RangeError);
    expect(() => generateBingoCards(26, randomBytes)).toThrow(RangeError);
  });

  it("fails instead of returning duplicate cards from a repeating source", () => {
    const repeatingBytes: CryptographicRandomBytes = (length) => new Uint8Array(length);

    expect(() => generateBingoCards(2, repeatingBytes)).toThrow(
      "Unable to generate a unique Bingo card for every round participant.",
    );
  });

  it("fails when random bytes cannot produce an unbiased index", () => {
    let requests = 0;
    const rejectedBytes: CryptographicRandomBytes = () => {
      requests += 1;
      return requests <= 256 ? Uint8Array.of(255) : new Uint8Array();
    };

    expect(() => generateBingoCards(1, rejectedBytes)).toThrow(
      "Unable to sample an unbiased random index.",
    );
    expect(requests).toBe(256);
  });

  it("maintains card and round uniqueness invariants across generated inputs", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 25 }), (seed, roundSize) => {
        const cards = generateBingoCards(roundSize, createSeededRandomBytes(seed));

        expect(cards).toHaveLength(roundSize);
        cards.forEach(expectValidCard);
        expect(new Set(cards.map((card) => card.join(","))).size).toBe(roundSize);
      }),
      { numRuns: 100 },
    );
  });
});
