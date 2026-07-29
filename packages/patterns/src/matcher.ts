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

export function calculatePatternProgress(
  pattern: PatternDefinition,
  input: PatternProgressInput,
): PatternProgress {
  const parsedPattern = PatternDefinitionSchema.parse(pattern);
  const calledCells = PatternCardStateSchema.parse(input.calledCells);
  const markedCells = PatternCardStateSchema.parse(input.markedCells);
  const candidates = parsedPattern.masks.map((mask) => {
    const requiredCellIndexes = Array.from(mask.replaceAll("/", ""))
      .map((cell, index) => (cell === "#" && index !== 12 ? index : -1))
      .filter((index) => index >= 0);
    const remainingCellIndexes = requiredCellIndexes.filter(
      (index) => !calledCells[index] || !markedCells[index],
    );
    return { requiredCellIndexes, remainingCellIndexes };
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

export function matchesPattern(pattern: PatternDefinition, cardState: PatternCardState): boolean {
  const satisfiedCells = PatternCardStateSchema.parse(cardState);
  return calculatePatternProgress(pattern, {
    calledCells: satisfiedCells,
    markedCells: satisfiedCells,
  }).complete;
}
