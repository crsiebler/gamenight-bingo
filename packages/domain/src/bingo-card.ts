import { shuffledValues } from "./random.js";
import type { CryptographicRandomBytes } from "./random.js";

export const FREE_BINGO_CELL = "FREE" as const;

export type BingoCardCell = number | typeof FREE_BINGO_CELL;
export type BingoCard = readonly BingoCardCell[];

const CARD_SIZE = 25;
const MAX_ROUND_SIZE = 25;
const MAX_UNIQUE_CARD_ATTEMPTS = 100;

function shuffledRange(
  minimum: number,
  maximum: number,
  randomBytes: CryptographicRandomBytes,
): number[] {
  const values = Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
  return shuffledValues(values, randomBytes);
}

function generateBingoCard(randomBytes: CryptographicRandomBytes): BingoCard {
  const card = Array<BingoCardCell>(CARD_SIZE);

  for (let column = 0; column < 5; column += 1) {
    const minimum = column * 15 + 1;
    const values = shuffledRange(minimum, minimum + 14, randomBytes);
    let valueIndex = 0;

    for (let row = 0; row < 5; row += 1) {
      const cellIndex = row * 5 + column;
      if (cellIndex === 12) {
        card[cellIndex] = FREE_BINGO_CELL;
      } else {
        const value = values[valueIndex];
        if (value === undefined) {
          throw new Error("Unable to generate a complete Bingo card.");
        }
        card[cellIndex] = value;
        valueIndex += 1;
      }
    }
  }

  return card;
}

export function generateBingoCards(
  count: number,
  randomBytes: CryptographicRandomBytes,
): readonly BingoCard[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_ROUND_SIZE) {
    throw new RangeError(`Bingo round size must be an integer from 1 to ${MAX_ROUND_SIZE}.`);
  }

  const cards: BingoCard[] = [];
  const cardKeys = new Set<string>();
  let attemptsForCurrentCard = 0;

  while (cards.length < count) {
    const card = generateBingoCard(randomBytes);
    const key = card.join(",");

    if (cardKeys.has(key)) {
      attemptsForCurrentCard += 1;
      if (attemptsForCurrentCard >= MAX_UNIQUE_CARD_ATTEMPTS) {
        throw new Error("Unable to generate a unique Bingo card for every round participant.");
      }
      continue;
    }

    cards.push(card);
    cardKeys.add(key);
    attemptsForCurrentCard = 0;
  }

  return cards;
}

export function isBingoCardCellSatisfied(
  cell: BingoCardCell,
  markedBalls: ReadonlySet<number>,
): boolean {
  return cell === FREE_BINGO_CELL || markedBalls.has(cell);
}
