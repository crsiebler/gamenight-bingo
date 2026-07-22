import { shuffledValues } from "./random.js";
import type { CryptographicRandomBytes } from "./random.js";

export type DrawOrder = readonly number[];

export type DrawPositionResult =
  | {
      readonly ok: true;
      readonly ball: number;
      readonly position: number;
      readonly committedCount: number;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "DRAW_ORDER_EXHAUSTED";
        readonly message: "No uncalled balls remain in the draw order.";
      };
    };

const BALL_COUNT = 75;
const DRAW_ORDER_EXHAUSTED = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "DRAW_ORDER_EXHAUSTED",
    message: "No uncalled balls remain in the draw order.",
  }),
}) satisfies DrawPositionResult;

export function generateDrawOrder(randomBytes: CryptographicRandomBytes): DrawOrder {
  const balls = Array.from({ length: BALL_COUNT }, (_, index) => index + 1);
  return Object.freeze(shuffledValues(balls, randomBytes));
}

export function commitNextDrawPosition(
  drawOrder: DrawOrder,
  committedCount: number,
): DrawPositionResult {
  if (!Number.isInteger(committedCount) || committedCount < 0 || committedCount > BALL_COUNT) {
    throw new RangeError(`Committed draw count must be an integer from 0 to ${BALL_COUNT}.`);
  }

  if (committedCount === BALL_COUNT) {
    return DRAW_ORDER_EXHAUSTED;
  }

  const ball = drawOrder[committedCount];
  if (ball === undefined) {
    throw new RangeError("The draw order does not contain the next position.");
  }

  return {
    ok: true,
    ball,
    position: committedCount + 1,
    committedCount: committedCount + 1,
  };
}
