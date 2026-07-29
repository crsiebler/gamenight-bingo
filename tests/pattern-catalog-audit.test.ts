import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  auditPatternCatalog,
  parsePatternCatalogSourceDiagrams,
  patternCatalog,
  type PatternCatalogAuditInput,
  type PatternCatalogSourceDiagram,
  type PatternPreview,
} from "../packages/patterns/src/index.js";

const catalogMarkdown = readFileSync(resolve("docs/bingo-pattern-catalog.md"), "utf8");

const approvedMasks = {
  "letter-q": "#####/#...#/#...#/#..##/#####",
  "letter-w": "#...#/#...#/#.#.#/##.##/#...#",
  "number-10": "#.###/#.#.#/#.#.#/#.#.#/#.###",
  "number-11": ".#..#/##.##/.#..#/.#..#/.#..#",
  "number-12": "#.###/#...#/#.###/#.#../#.###",
  "number-13": "#.###/#...#/#.###/#...#/#.###",
  "number-14": "#.#.#/#.#.#/#.###/#...#/#...#",
  "number-15": "#.###/#.#../#.###/#...#/#.###",
  "number-16": "#.###/#.#../#.###/#.#.#/#.###",
  "number-17": "#.###/#.#.#/#...#/#...#/#...#",
  "number-18": "#.###/#.#.#/#.###/#.#.#/#.###",
  "number-19": "#.###/#.#.#/#.###/#...#/#...#",
} as const;

const distinctIdGroups = [
  ["shape-cross", "shape-plus", "christmas-cross"],
  ["shape-x", "letter-x"],
  ["shape-outside-edge", "letter-o"],
  ["shape-checkerboard", "christmas-snow"],
] as const;

function readSourceDiagrams(): PatternCatalogSourceDiagram[] {
  return parsePatternCatalogSourceDiagrams(catalogMarkdown);
}

function readGolden(fileName: string): PatternPreview[] {
  return JSON.parse(
    readFileSync(resolve(`tests/fixtures/patterns/${fileName}-previews.v1.json`), "utf8"),
  ) as PatternPreview[];
}

function completeAuditInput(): PatternCatalogAuditInput {
  return {
    patterns: patternCatalog,
    sourceDiagrams: readSourceDiagrams(),
    goldenPreviews: [
      ...readGolden("shape"),
      ...readGolden("letter"),
      ...readGolden("number"),
      ...readGolden("christmas"),
    ],
    approvedMasks,
    distinctIdGroups,
  };
}

describe("complete pattern catalog audit", () => {
  test("fails closed on malformed, unknown, or unreviewed documentation rows", () => {
    const malformedInventory = catalogMarkdown.replace(
      "### Shape Cell Review Records",
      "| p1/dXX | Extra | exact | Extra | `...../...../...../...../.....` |\n\n### Shape Cell Review Records",
    );
    const unknownDisposition = catalogMarkdown.replace(
      /`exact-mask-match`\s+\|\s+25\/25 \|/,
      "`exact-mask-matc` | 25/25 |",
    );
    const unreviewedInventory = catalogMarkdown.replace(
      "### Shape Cell Review Records",
      "| p1/d26 | Extra | exact | Extra | `...../...../...../...../.....` |\n\n### Shape Cell Review Records",
    );

    expect(() => parsePatternCatalogSourceDiagrams(malformedInventory)).toThrow(
      /Invalid source inventory row/,
    );
    expect(() => parsePatternCatalogSourceDiagrams(unknownDisposition)).toThrow(
      /Invalid source review row/,
    );
    expect(() => parsePatternCatalogSourceDiagrams(unreviewedInventory)).toThrow(
      /Missing source review/,
    );
  });

  test("maps all 82 PDF diagrams and preserves approved identities and masks", () => {
    const input = completeAuditInput();

    expect(input.sourceDiagrams).toHaveLength(82);
    expect(auditPatternCatalog(input)).toEqual([]);
  });

  test.each([
    {
      failure: "missing sources",
      code: "missing-source",
      mutate: (input: PatternCatalogAuditInput): PatternCatalogAuditInput => ({
        ...input,
        sourceDiagrams: input.sourceDiagrams.slice(1),
      }),
    },
    {
      failure: "IDs",
      code: "invalid-id",
      mutate: (input: PatternCatalogAuditInput): PatternCatalogAuditInput => ({
        ...input,
        sourceDiagrams: input.sourceDiagrams.map((diagram, index) =>
          index === 0 ? { ...diagram, runtimeId: "shape-missing" } : diagram,
        ),
      }),
    },
    {
      failure: "aliases",
      code: "alias-mismatch",
      mutate: (input: PatternCatalogAuditInput): PatternCatalogAuditInput => ({
        ...input,
        patterns: input.patterns.map((pattern) =>
          pattern.id === "standard-blackout"
            ? { ...pattern, source: { ...pattern.source, alias: null } }
            : pattern,
        ),
      }),
    },
    {
      failure: "parity",
      code: "parity-mismatch",
      mutate: (input: PatternCatalogAuditInput): PatternCatalogAuditInput => ({
        ...input,
        sourceDiagrams: input.sourceDiagrams.map((diagram) =>
          diagram.runtimeId === "letter-q"
            ? { ...diagram, mask: "#####/#...#/#...#/##..#/#####" }
            : diagram,
        ),
      }),
    },
    {
      failure: "golden fixtures",
      code: "golden-mismatch",
      mutate: (input: PatternCatalogAuditInput): PatternCatalogAuditInput => ({
        ...input,
        goldenPreviews: input.goldenPreviews.slice(1),
      }),
    },
  ])("fails for $failure", ({ code, mutate }) => {
    expect(auditPatternCatalog(mutate(completeAuditInput())).map((issue) => issue.code)).toContain(
      code,
    );
  });

  test("fails when approved masks change or duplicate identities collapse", () => {
    const input = completeAuditInput();
    const changedApprovedMask = {
      ...input,
      approvedMasks: {
        ...input.approvedMasks,
        "number-10": "#.###/#.#.#/#.#.#/#.###/#.#.#",
      },
    } satisfies PatternCatalogAuditInput;
    const duplicateIdRequirement = {
      ...input,
      distinctIdGroups: [...input.distinctIdGroups, ["shape-cross", "shape-cross"]],
    } satisfies PatternCatalogAuditInput;

    expect(auditPatternCatalog(changedApprovedMask)).toContainEqual({
      code: "parity-mismatch",
      message: "Runtime pattern number-10 differs from its approved mask.",
    });
    expect(auditPatternCatalog(duplicateIdRequirement)).toContainEqual({
      code: "invalid-id",
      message: "Required distinct runtime IDs are missing or collapsed: shape-cross, shape-cross.",
    });
  });

  test("rejects unknown dispositions and ignores golden object property order", () => {
    const input = completeAuditInput();
    const unknownDisposition = {
      ...input,
      sourceDiagrams: input.sourceDiagrams.map((diagram, index) =>
        index === 0
          ? {
              ...diagram,
              disposition: "exact-mask-matc" as PatternCatalogSourceDiagram["disposition"],
            }
          : diagram,
      ),
    } satisfies PatternCatalogAuditInput;
    const reorderedGoldens = {
      ...input,
      goldenPreviews: input.goldenPreviews.map((preview) => ({
        thumbnails: preview.thumbnails.map(({ reference, classification, mask }) => ({
          mask,
          classification,
          reference,
        })),
        source: { alias: preview.source.alias, file: preview.source.file },
        mode: preview.mode,
        name: preview.name,
        id: preview.id,
      })),
    } satisfies PatternCatalogAuditInput;

    expect(auditPatternCatalog(unknownDisposition).map((issue) => issue.code)).toContain(
      "parity-mismatch",
    );
    expect(auditPatternCatalog(reorderedGoldens)).toEqual([]);
  });
});
