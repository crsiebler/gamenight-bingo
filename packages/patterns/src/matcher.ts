import { z } from "zod";

import { PatternDefinitionSchema, type PatternDefinition } from "./catalog.js";

export const PatternCardStateSchema = z.array(z.boolean()).length(25);

export type PatternCardState = z.infer<typeof PatternCardStateSchema>;

export interface PatternProgress {
  readonly complete: boolean;
  readonly requiredCellCount: number;
  readonly satisfiedCellCount: number;
  readonly remainingRequiredCellCount: number;
  readonly nearWinCellIndex: number | null;
}

export interface PatternProgressInput {
  readonly calledCells: PatternCardState;
  readonly markedCells: PatternCardState;
}

export interface LatestCallPatternAttributionInput extends PatternProgressInput {
  readonly priorMarkedCells: PatternCardState;
  readonly latestCalledCellIndex: number | null;
}

function requiredCellIndexes(mask: string): number[] {
  return Array.from(mask.replaceAll("/", ""))
    .map((cell, index) => (cell === "#" && index !== 12 ? index : -1))
    .filter((index) => index >= 0);
}

export function calculatePatternProgress(
  pattern: PatternDefinition,
  input: PatternProgressInput,
): PatternProgress {
  const parsedPattern = PatternDefinitionSchema.parse(pattern);
  const calledCells = PatternCardStateSchema.parse(input.calledCells);
  const markedCells = PatternCardStateSchema.parse(input.markedCells);
  const candidates = parsedPattern.masks.map((mask) => {
    const requiredIndexes = requiredCellIndexes(mask);
    const remainingCellIndexes = requiredIndexes.filter(
      (index) => !calledCells[index] || !markedCells[index],
    );
    return { requiredCellIndexes: requiredIndexes, remainingCellIndexes };
  });
  const selected = candidates.reduce((best, candidate) =>
    candidate.remainingCellIndexes.length < best.remainingCellIndexes.length ? candidate : best,
  );
  const complete = selected.remainingCellIndexes.length === 0;
  const nearWinCandidate =
    !complete &&
    selected.remainingCellIndexes.length === 1 &&
    calledCells[selected.remainingCellIndexes[0]!] === true &&
    markedCells[selected.remainingCellIndexes[0]!] === false
      ? selected
      : undefined;

  return {
    complete,
    requiredCellCount: selected.requiredCellIndexes.length,
    satisfiedCellCount: selected.requiredCellIndexes.length - selected.remainingCellIndexes.length,
    remainingRequiredCellCount: selected.remainingCellIndexes.length,
    nearWinCellIndex: nearWinCandidate?.remainingCellIndexes[0] ?? null,
  };
}

export function isPatternCompletionAttributableToLatestCall(
  pattern: PatternDefinition,
  input: LatestCallPatternAttributionInput,
): boolean {
  const parsedPattern = PatternDefinitionSchema.parse(pattern);
  const calledCells = PatternCardStateSchema.parse(input.calledCells);
  const priorMarkedCells = PatternCardStateSchema.parse(input.priorMarkedCells);
  const markedCells = PatternCardStateSchema.parse(input.markedCells);
  const latestCalledCellIndex = z
    .number()
    .int()
    .min(0)
    .max(24)
    .nullable()
    .parse(input.latestCalledCellIndex);
  const candidates = parsedPattern.masks.map(requiredCellIndexes);
  const isComplete = (
    requiredIndexes: readonly number[],
    marks: PatternCardState,
    unavailableCellIndex: number | null = null,
  ) =>
    requiredIndexes.every(
      (index) =>
        index !== unavailableCellIndex && calledCells[index] === true && marks[index] === true,
    );

  if (
    latestCalledCellIndex === null ||
    latestCalledCellIndex === 12 ||
    candidates.some((requiredIndexes) => isComplete(requiredIndexes, priorMarkedCells))
  ) {
    return false;
  }

  return candidates.some(
    (requiredIndexes) =>
      isComplete(requiredIndexes, markedCells) &&
      !isComplete(requiredIndexes, markedCells, latestCalledCellIndex),
  );
}

export function matchesPattern(pattern: PatternDefinition, cardState: PatternCardState): boolean {
  const satisfiedCells = PatternCardStateSchema.parse(cardState);
  return calculatePatternProgress(pattern, {
    calledCells: satisfiedCells,
    markedCells: satisfiedCells,
  }).complete;
}
