export type CryptographicRandomBytes = (length: number) => Uint8Array;

const BYTE_VALUE_COUNT = 256;
const MAX_RANDOM_INDEX_ATTEMPTS = 256;

export function randomIndex(maxExclusive: number, randomBytes: CryptographicRandomBytes): number {
  const unbiasedLimit = BYTE_VALUE_COUNT - (BYTE_VALUE_COUNT % maxExclusive);

  for (let attempt = 0; attempt < MAX_RANDOM_INDEX_ATTEMPTS; attempt += 1) {
    const bytes = randomBytes(1);
    if (bytes.length !== 1) {
      throw new RangeError("The random byte source must return the requested number of bytes.");
    }

    const value = bytes[0];
    if (value !== undefined && value < unbiasedLimit) {
      return value % maxExclusive;
    }
  }

  throw new Error("Unable to sample an unbiased random index.");
}

export function shuffledValues<T>(
  values: readonly T[],
  randomBytes: CryptographicRandomBytes,
): T[] {
  const shuffled = [...values];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, randomBytes);
    const current = shuffled[index];
    const selected = shuffled[swapIndex];
    if (current === undefined || selected === undefined) {
      throw new Error("Unable to shuffle values.");
    }
    shuffled[index] = selected;
    shuffled[swapIndex] = current;
  }

  return shuffled;
}
