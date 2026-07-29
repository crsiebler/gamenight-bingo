import type { PatternDefinition } from "./catalog.js";
import {
  createChristmasPatternPreviews,
  createLetterPatternPreviews,
  createNumberPatternPreviews,
  createShapePatternPreviews,
  type PatternPreview,
  type PatternPreviewSourceFile,
} from "./previews.js";

export type PatternCatalogSourceDisposition =
  "exact-mask-match" | "flexible-rule-example" | "source-alias";

export interface PatternCatalogSourceDiagram {
  readonly sourceFile: PatternPreviewSourceFile;
  readonly reference: string;
  readonly sourceName: string;
  readonly runtimeId: string;
  readonly disposition: PatternCatalogSourceDisposition;
  readonly mask: string;
}

export interface PatternCatalogAuditInput {
  readonly patterns: readonly PatternDefinition[];
  readonly sourceDiagrams: readonly PatternCatalogSourceDiagram[];
  readonly goldenPreviews: readonly PatternPreview[];
  readonly approvedMasks: Readonly<Record<string, string>>;
  readonly distinctIdGroups: readonly (readonly string[])[];
}

export type PatternCatalogAuditIssueCode =
  "missing-source" | "invalid-id" | "alias-mismatch" | "parity-mismatch" | "golden-mismatch";

export interface PatternCatalogAuditIssue {
  readonly code: PatternCatalogAuditIssueCode;
  readonly message: string;
}

const sourceFileByReviewCategory = {
  Shape: "shapes-bingo-patterns.pdf",
  Letter: "letter-bingo-patterns.pdf",
  Number: "number-bingo-patterns.pdf",
  Christmas: "christmas-bingo-patterns.pdf",
} as const satisfies Record<string, PatternPreviewSourceFile>;

const sourceDispositions = new Set<PatternCatalogSourceDisposition>([
  "exact-mask-match",
  "flexible-rule-example",
  "source-alias",
]);

const sourceDispositionByMode = {
  exact: "exact-mask-match",
  "flexible-example": "flexible-rule-example",
  alias: "source-alias",
} as const satisfies Record<string, PatternCatalogSourceDisposition>;

function diagramKey(sourceFile: PatternPreviewSourceFile, reference: string): string {
  return `${sourceFile}:${reference}`;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function markdownCells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim().replaceAll("`", ""));
}

function isTableHeader(cells: readonly string[]): boolean {
  return cells[0] === "Reference" || /^-+$/.test(cells[0] ?? "");
}

export function parsePatternCatalogSourceDiagrams(markdown: string): PatternCatalogSourceDiagram[] {
  const inventory = new Map<
    string,
    Pick<
      PatternCatalogSourceDiagram,
      "sourceFile" | "reference" | "sourceName" | "disposition" | "mask"
    >
  >();
  const reviews = new Map<
    string,
    Pick<PatternCatalogSourceDiagram, "runtimeId" | "sourceName" | "disposition">
  >();
  let inventorySourceFile: PatternPreviewSourceFile | undefined;
  let reviewSourceFile: PatternPreviewSourceFile | undefined;

  for (const line of markdown.split("\n")) {
    const sourceHeading = line.match(/^### `docs\/(.+\.pdf)`$/)?.[1];
    if (
      sourceHeading &&
      Object.values(sourceFileByReviewCategory).includes(sourceHeading as PatternPreviewSourceFile)
    ) {
      inventorySourceFile = sourceHeading as PatternPreviewSourceFile;
      reviewSourceFile = undefined;
      continue;
    }

    const reviewCategory = line.match(
      /^### (Shape|Letter|Number|Christmas) Cell Review Records$/,
    )?.[1] as keyof typeof sourceFileByReviewCategory | undefined;
    if (reviewCategory) {
      inventorySourceFile = undefined;
      reviewSourceFile = sourceFileByReviewCategory[reviewCategory];
      continue;
    }

    if (/^#{2,3} /.test(line)) {
      inventorySourceFile = undefined;
      reviewSourceFile = undefined;
      continue;
    }
    if (!line.startsWith("|") || (!inventorySourceFile && !reviewSourceFile)) continue;

    const cells = markdownCells(line);
    if (isTableHeader(cells)) continue;

    if (inventorySourceFile) {
      const [reference, sourceName, mode, catalogName, mask] = cells;
      const disposition = sourceDispositionByMode[mode as keyof typeof sourceDispositionByMode];
      if (
        cells.length !== 5 ||
        !reference ||
        !/^p1\/d\d{2}$/.test(reference) ||
        !sourceName ||
        !disposition ||
        !catalogName ||
        !mask ||
        !/^[#.]{5}(?:\/[#.]{5}){4}$/.test(mask)
      ) {
        throw new Error(`Invalid source inventory row: ${line}`);
      }

      const key = diagramKey(inventorySourceFile, reference);
      if (inventory.has(key)) throw new Error(`Duplicate source inventory row: ${key}.`);
      inventory.set(key, {
        sourceFile: inventorySourceFile,
        reference,
        sourceName,
        disposition,
        mask,
      });
      continue;
    }

    const [reference, sourceName, runtimeId, disposition, cellsReviewed] = cells;
    if (
      cells.length !== 5 ||
      !reference ||
      !/^p1\/d\d{2}$/.test(reference) ||
      !sourceName ||
      !runtimeId ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(runtimeId) ||
      !sourceDispositions.has(disposition as PatternCatalogSourceDisposition) ||
      cellsReviewed !== "25/25"
    ) {
      throw new Error(`Invalid source review row: ${line}`);
    }

    const key = diagramKey(reviewSourceFile!, reference);
    if (reviews.has(key)) throw new Error(`Duplicate source review row: ${key}.`);
    reviews.set(key, {
      runtimeId,
      sourceName,
      disposition: disposition as PatternCatalogSourceDisposition,
    });
  }

  for (const key of inventory.keys()) {
    if (!reviews.has(key)) throw new Error(`Missing source review for ${key}.`);
  }
  for (const key of reviews.keys()) {
    if (!inventory.has(key)) throw new Error(`Missing source inventory row for ${key}.`);
  }

  return [...reviews].map(([key, review]) => {
    const source = inventory.get(key)!;
    if (review.sourceName !== source.sourceName || review.disposition !== source.disposition) {
      throw new Error(`Source inventory and review differ for ${key}.`);
    }
    return {
      sourceFile: source.sourceFile,
      reference: source.reference,
      sourceName: source.sourceName,
      runtimeId: review.runtimeId,
      disposition: review.disposition,
      mask: source.mask,
    };
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]),
  );
}

function expectedGoldenPreviews(patterns: readonly PatternDefinition[]): PatternPreview[] {
  return [
    ...createShapePatternPreviews(patterns),
    ...createLetterPatternPreviews(patterns),
    ...createNumberPatternPreviews(patterns),
    ...createChristmasPatternPreviews(patterns),
  ];
}

export function auditPatternCatalog(input: PatternCatalogAuditInput): PatternCatalogAuditIssue[] {
  const issues: PatternCatalogAuditIssue[] = [];
  const patternsById = new Map<string, PatternDefinition>();

  for (const pattern of input.patterns) {
    if (patternsById.has(pattern.id)) {
      issues.push({ code: "invalid-id", message: `Duplicate runtime ID: ${pattern.id}.` });
    }
    patternsById.set(pattern.id, pattern);
  }

  for (const group of input.distinctIdGroups) {
    if (new Set(group).size !== group.length || group.some((id) => !patternsById.has(id))) {
      issues.push({
        code: "invalid-id",
        message: `Required distinct runtime IDs are missing or collapsed: ${group.join(", ")}.`,
      });
    }
  }

  const diagramsByKey = new Map<string, PatternCatalogSourceDiagram>();
  for (const diagram of input.sourceDiagrams) {
    const key = diagramKey(diagram.sourceFile, diagram.reference);
    if (diagramsByKey.has(key)) {
      issues.push({ code: "missing-source", message: `Duplicate source diagram mapping: ${key}.` });
    }
    diagramsByKey.set(key, diagram);

    const pattern = patternsById.get(diagram.runtimeId);
    if (!pattern) {
      issues.push({
        code: "invalid-id",
        message: `${key} maps to missing runtime ID ${diagram.runtimeId}.`,
      });
      continue;
    }

    if (
      pattern.source.file !== diagram.sourceFile ||
      !pattern.source.references.includes(diagram.reference)
    ) {
      issues.push({
        code: "missing-source",
        message: `${key} is not declared by runtime pattern ${pattern.id}.`,
      });
    }

    if (!sourceDispositions.has(diagram.disposition)) {
      issues.push({
        code: "parity-mismatch",
        message: `${key} has unknown source disposition ${diagram.disposition}.`,
      });
      continue;
    }

    if (diagram.disposition === "source-alias") {
      if (pattern.source.alias !== diagram.sourceName) {
        issues.push({
          code: "alias-mismatch",
          message: `${key} must remain the ${diagram.sourceName} alias for ${pattern.id}.`,
        });
      }
      if (!arraysEqual(pattern.masks, [diagram.mask])) {
        issues.push({
          code: "parity-mismatch",
          message: `${key} alias mask differs from runtime pattern ${pattern.id}.`,
        });
      }
      continue;
    }

    if (diagram.disposition === "flexible-rule-example") {
      const example = pattern.source.examples?.find(
        (candidate) => candidate.reference === diagram.reference,
      );
      if (
        pattern.name !== diagram.sourceName ||
        !example ||
        example.classification !== "flexible-rule-example" ||
        example.mask !== diagram.mask ||
        !pattern.masks.includes(diagram.mask)
      ) {
        issues.push({
          code: "parity-mismatch",
          message: `${key} does not match the runtime flexible-rule example for ${pattern.id}.`,
        });
      }
      continue;
    }

    if (
      pattern.mode !== "exact" ||
      pattern.name !== diagram.sourceName ||
      pattern.source.alias !== null ||
      !arraysEqual(pattern.masks, [diagram.mask])
    ) {
      issues.push({
        code: "parity-mismatch",
        message: `${key} exact source mask or metadata differs from runtime pattern ${pattern.id}.`,
      });
    }
  }

  for (const pattern of input.patterns) {
    if (pattern.source.file === null) continue;
    for (const reference of pattern.source.references) {
      const key = diagramKey(pattern.source.file, reference);
      const diagram = diagramsByKey.get(key);
      if (!diagram) {
        issues.push({
          code: "missing-source",
          message: `Runtime pattern ${pattern.id} has no reviewed source diagram for ${key}.`,
        });
      } else if (diagram.runtimeId !== pattern.id) {
        issues.push({
          code: "invalid-id",
          message: `${key} maps to ${diagram.runtimeId} instead of ${pattern.id}.`,
        });
      }
    }
  }

  for (const [id, approvedMask] of Object.entries(input.approvedMasks)) {
    const pattern = patternsById.get(id);
    if (!pattern) {
      issues.push({ code: "invalid-id", message: `Approved pattern ID is missing: ${id}.` });
    } else if (!arraysEqual(pattern.masks, [approvedMask])) {
      issues.push({
        code: "parity-mismatch",
        message: `Runtime pattern ${id} differs from its approved mask.`,
      });
    }
  }

  if (
    JSON.stringify(canonicalize(input.goldenPreviews)) !==
    JSON.stringify(canonicalize(expectedGoldenPreviews(input.patterns)))
  ) {
    issues.push({
      code: "golden-mismatch",
      message: "Committed preview goldens differ from the complete runtime catalog.",
    });
  }

  return issues;
}
