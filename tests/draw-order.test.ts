import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { commitNextDrawPosition, generateDrawOrder } from "../packages/domain/src/index.js";
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

const SORTED_BALLS = Array.from({ length: 75 }, (_, index) => index + 1);

describe("Bingo draw order", () => {
  it("shuffles every 75-ball number exactly once", () => {
    const order = generateDrawOrder(createSeededRandomBytes(12345));

    expect(order).toHaveLength(75);
    expect(new Set(order).size).toBe(75);
    expect([...order].sort((left, right) => left - right)).toEqual(SORTED_BALLS);
  });

  it("produces deterministic orders from deterministic random bytes", () => {
    expect(generateDrawOrder(createSeededRandomBytes(42))).toEqual(
      generateDrawOrder(createSeededRandomBytes(42)),
    );
  });

  it("commits exactly one next position without exposing future positions", () => {
    const order = generateDrawOrder(createSeededRandomBytes(7));
    const result = commitNextDrawPosition(order, 0);

    expect(result).toEqual({
      ok: true,
      ball: order[0],
      position: 1,
      committedCount: 1,
    });
    expect(Object.keys(result)).not.toContain("drawOrder");
    expect(Object.keys(result)).not.toContain("remainingBalls");
  });

  it("returns a stable error after all positions are committed", () => {
    const order = generateDrawOrder(createSeededRandomBytes(9));

    expect(commitNextDrawPosition(order, 75)).toEqual({
      ok: false,
      error: {
        code: "DRAW_ORDER_EXHAUSTED",
        message: "No uncalled balls remain in the draw order.",
      },
    });
    expect(commitNextDrawPosition(order, 75)).toEqual(commitNextDrawPosition(order, 75));
  });

  it("commits all positions without repeats or skips", () => {
    const order = generateDrawOrder(createSeededRandomBytes(11));
    const committedBalls: number[] = [];

    for (let committedCount = 0; committedCount < 75; committedCount += 1) {
      const result = commitNextDrawPosition(order, committedCount);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.position).toBe(committedCount + 1);
        expect(result.committedCount).toBe(committedCount + 1);
        committedBalls.push(result.ball);
      }
    }

    expect(committedBalls).toEqual(order);
  });

  it("rejects invalid committed positions instead of treating them as exhaustion", () => {
    const order = generateDrawOrder(createSeededRandomBytes(13));

    expect(() => commitNextDrawPosition(order, -1)).toThrow(RangeError);
    expect(() => commitNextDrawPosition(order, 1.5)).toThrow(RangeError);
    expect(() => commitNextDrawPosition(order, 76)).toThrow(RangeError);
  });

  it("rejects the first byte outside the unbiased 75-way range", () => {
    let requests = 0;
    const boundaryBytes: CryptographicRandomBytes = (length) => {
      requests += 1;
      const value = requests === 1 ? 225 : requests === 2 ? 224 : 0;
      return new Uint8Array(length).fill(value);
    };

    const order = generateDrawOrder(boundaryBytes);

    expect(requests).toBe(75);
    expect(order[74]).toBe(75);
  });

  it("fails safely when random bytes cannot produce an unbiased index", () => {
    let requests = 0;
    const rejectedBytes: CryptographicRandomBytes = () => {
      requests += 1;
      return Uint8Array.of(255);
    };

    expect(() => generateDrawOrder(rejectedBytes)).toThrow(
      "Unable to sample an unbiased random index.",
    );
    expect(requests).toBe(256);
  });

  it("maintains permutation invariants across generated seeds", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const order = generateDrawOrder(createSeededRandomBytes(seed));

        expect(order).toHaveLength(75);
        expect(new Set(order).size).toBe(75);
        expect([...order].sort((left, right) => left - right)).toEqual(SORTED_BALLS);
      }),
      { numRuns: 100 },
    );
  });
});
