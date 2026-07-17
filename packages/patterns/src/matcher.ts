import { z } from "zod";

import { PatternDefinitionSchema, type PatternDefinition } from "./catalog.js";

export const PatternCardStateSchema = z.array(z.boolean()).length(25);

export type PatternCardState = z.infer<typeof PatternCardStateSchema>;

export function matchesPattern(pattern: PatternDefinition, cardState: PatternCardState): boolean {
  const parsedPattern = PatternDefinitionSchema.parse(pattern);
  const satisfiedCells = PatternCardStateSchema.parse(cardState);

  return parsedPattern.masks.some((mask) => {
    const requiredCells = mask.replaceAll("/", "");
    return Array.from(requiredCells).every(
      (cell, index) => cell === "." || index === 12 || satisfiedCells[index] === true,
    );
  });
}
