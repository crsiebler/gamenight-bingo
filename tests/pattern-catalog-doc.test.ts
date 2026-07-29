import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  generateCorePatternDocumentation,
  patternCatalog,
} from "../packages/patterns/src/index.js";

const catalogPath = resolve("docs/bingo-pattern-catalog.md");
const catalog = existsSync(catalogPath) ? readFileSync(catalogPath, "utf8") : "";

const sourceNames = {
  "shapes-bingo-patterns.pdf": [
    "Bunny Ears",
    "Two Lines",
    "Four Corners",
    "Windmill",
    "Outside Edge",
    "Full House",
    "Airplane",
    "Wine Glass",
    "X",
    "Turtle",
    "Stairs",
    "Bow Tie",
    "Cross",
    "Plus",
    "Rectangle",
    "Heart",
    "Hat",
    "Hour Glass",
    "Pyramid",
    "Checkerboard",
    "Inside Square",
    "Kite",
    "Smiley Face",
    "Block of Nine",
    "Two Lines",
  ],
  "letter-bingo-patterns.pdf": "ABCDEFGHIJKLMNOPQRSTUVWXY".split(""),
  "number-bingo-patterns.pdf": Array.from({ length: 20 }, (_, index) => String(index)),
  "christmas-bingo-patterns.pdf": [
    "Christmas Tree",
    "Tinsel",
    "Reindeer",
    "Skis",
    "Wreath",
    "Cross",
    "Bell",
    "Snow Boot",
    "Mittens",
    "Snow",
    "Gift",
    "Snowmobile",
  ],
} as const;

type SourceFile = keyof typeof sourceNames;
type CatalogMode = "exact" | "flexible-example" | "alias";

interface CatalogRow {
  sourceFile: SourceFile;
  reference: string;
  sourceName: string;
  mode: CatalogMode;
  catalogName: string;
  mask: string;
}

interface SourceReviewRow {
  reference: string;
  sourceName: string;
  runtimeId: string;
  review: "exact-mask-match" | "flexible-rule-example" | "source-alias";
  cellsReviewed: string;
}

function parseCatalogRows(markdown: string): CatalogRow[] {
  const rows: CatalogRow[] = [];
  let sourceFile: SourceFile | undefined;

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^### `docs\/(.+\.pdf)`$/);
    if (heading?.[1] && heading[1] in sourceNames) {
      sourceFile = heading[1] as SourceFile;
      continue;
    }

    if (/^#{2,3} /.test(line)) {
      sourceFile = undefined;
      continue;
    }

    if (!sourceFile) continue;

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll("`", ""));

    if (!/^p\d+\/d\d+$/.test(cells[0] ?? "")) continue;

    const [reference, sourceName, mode, catalogName, mask] = cells;
    if (!reference || !sourceName || !mode || !catalogName || !mask) continue;

    rows.push({
      sourceFile,
      reference,
      sourceName,
      mode: mode as CatalogMode,
      catalogName,
      mask,
    });
  }

  return rows;
}

const rows = parseCatalogRows(catalog);

function parseSourceReviewRows(markdown: string, category: string): SourceReviewRow[] {
  const section = markdown.match(
    new RegExp(`### ${category} Cell Review Records\\n([\\s\\S]*?)(?=\\n#{2,3} |$)`),
  )?.[1];
  if (!section) return [];

  return section
    .split("\n")
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replaceAll("`", "")),
    )
    .filter((cells) => /^p1\/d\d{2}$/.test(cells[0] ?? ""))
    .map(([reference, sourceName, runtimeId, review, cellsReviewed]) => ({
      reference: reference!,
      sourceName: sourceName!,
      runtimeId: runtimeId!,
      review: review as SourceReviewRow["review"],
      cellsReviewed: cellsReviewed!,
    }));
}

const shapeReviewRows = parseSourceReviewRows(catalog, "Shape");
const letterReviewRows = parseSourceReviewRows(catalog, "Letter");
const numberReviewRows = parseSourceReviewRows(catalog, "Number");
const christmasReviewRows = parseSourceReviewRows(catalog, "Christmas");

const expectedShapeReviewMappings = [
  ["p1/d01", "Bunny Ears", "shape-bunny-ears", "exact-mask-match"],
  ["p1/d02", "Two Lines", "standard-two-lines", "flexible-rule-example"],
  ["p1/d03", "Four Corners", "shape-four-corners", "exact-mask-match"],
  ["p1/d04", "Windmill", "shape-windmill", "exact-mask-match"],
  ["p1/d05", "Outside Edge", "shape-outside-edge", "exact-mask-match"],
  ["p1/d06", "Full House", "standard-blackout", "source-alias"],
  ["p1/d07", "Airplane", "shape-airplane", "exact-mask-match"],
  ["p1/d08", "Wine Glass", "shape-wine-glass", "exact-mask-match"],
  ["p1/d09", "X", "shape-x", "exact-mask-match"],
  ["p1/d10", "Turtle", "shape-turtle", "exact-mask-match"],
  ["p1/d11", "Stairs", "shape-stairs", "exact-mask-match"],
  ["p1/d12", "Bow Tie", "shape-bow-tie", "exact-mask-match"],
  ["p1/d13", "Cross", "shape-cross", "exact-mask-match"],
  ["p1/d14", "Plus", "shape-plus", "exact-mask-match"],
  ["p1/d15", "Rectangle", "shape-rectangle", "exact-mask-match"],
  ["p1/d16", "Heart", "shape-heart", "exact-mask-match"],
  ["p1/d17", "Hat", "shape-hat", "exact-mask-match"],
  ["p1/d18", "Hour Glass", "shape-hour-glass", "exact-mask-match"],
  ["p1/d19", "Pyramid", "shape-pyramid", "exact-mask-match"],
  ["p1/d20", "Checkerboard", "shape-checkerboard", "exact-mask-match"],
  ["p1/d21", "Inside Square", "shape-inside-square", "exact-mask-match"],
  ["p1/d22", "Kite", "shape-kite", "exact-mask-match"],
  ["p1/d23", "Smiley Face", "shape-smiley-face", "exact-mask-match"],
  ["p1/d24", "Block of Nine", "shape-block-of-nine", "exact-mask-match"],
  ["p1/d25", "Two Lines", "standard-two-lines", "flexible-rule-example"],
] as const;

const expectedLetterReviewMappings = "ABCDEFGHIJKLMNOPQRSTUVWXY"
  .split("")
  .map((letter, index) => [
    `p1/d${String(index + 1).padStart(2, "0")}`,
    letter,
    `letter-${letter.toLowerCase()}`,
    "exact-mask-match",
  ]);

const expectedNumberReviewMappings = Array.from({ length: 20 }, (_, index) => [
  `p1/d${String(index + 1).padStart(2, "0")}`,
  String(index),
  `number-${index}`,
  "exact-mask-match",
]);

const expectedChristmasReviewMappings = [
  ["p1/d01", "Christmas Tree", "christmas-tree", "exact-mask-match"],
  ["p1/d02", "Tinsel", "christmas-tinsel", "exact-mask-match"],
  ["p1/d03", "Reindeer", "christmas-reindeer", "exact-mask-match"],
  ["p1/d04", "Skis", "christmas-skis", "exact-mask-match"],
  ["p1/d05", "Wreath", "christmas-wreath", "exact-mask-match"],
  ["p1/d06", "Cross", "christmas-cross", "exact-mask-match"],
  ["p1/d07", "Bell", "christmas-bell", "exact-mask-match"],
  ["p1/d08", "Snow Boot", "christmas-snow-boot", "exact-mask-match"],
  ["p1/d09", "Mittens", "christmas-mittens", "exact-mask-match"],
  ["p1/d10", "Snow", "christmas-snow", "exact-mask-match"],
  ["p1/d11", "Gift", "christmas-gift", "exact-mask-match"],
  ["p1/d12", "Snowmobile", "christmas-snowmobile", "exact-mask-match"],
] as const;

function generatedSection(markdown: string): string | undefined {
  return markdown.match(
    /<!-- BEGIN GENERATED CORE PATTERNS -->\n([\s\S]*?)\n<!-- END GENERATED CORE PATTERNS -->/,
  )?.[1];
}

function findRow(sourceFile: SourceFile, sourceName: string): CatalogRow {
  const row = rows.find(
    (candidate) => candidate.sourceFile === sourceFile && candidate.sourceName === sourceName,
  );
  expect(row, `${sourceFile}: ${sourceName}`).toBeDefined();
  return row!;
}

describe("canonical pattern catalog documentation", () => {
  test("exists at the documented canonical path", () => {
    expect(existsSync(catalogPath)).toBe(true);
  });

  test.each(Object.entries(sourceNames))(
    "accounts for every diagram in %s",
    (sourceFile, expectedNames) => {
      const sourceRows = rows.filter((row) => row.sourceFile === sourceFile);

      expect(sourceRows.map((row) => row.sourceName)).toEqual(expectedNames);
      expect(sourceRows.map((row) => row.reference)).toEqual(
        expectedNames.map((_, index) => `p1/d${String(index + 1).padStart(2, "0")}`),
      );
    },
  );

  test("records 82 source diagrams with their expected classifications", () => {
    expect(rows).toHaveLength(82);
    expect(rows.filter((row) => row.mode === "exact")).toHaveLength(79);
    expect(rows.filter((row) => row.mode === "flexible-example")).toHaveLength(2);
    expect(rows.filter((row) => row.mode === "alias")).toHaveLength(1);
  });

  test("uses a valid 5x5 mask for every source diagram", () => {
    for (const row of rows) {
      expect(row.mask, `${row.sourceFile} ${row.reference}`).toMatch(/^[#.]{5}(?:\/[#.]{5}){4}$/);
    }
  });

  test("records both Two Lines diagrams as examples of one flexible rule", () => {
    const twoLines = rows.filter(
      (row) => row.sourceFile === "shapes-bingo-patterns.pdf" && row.sourceName === "Two Lines",
    );

    expect(twoLines).toHaveLength(2);
    expect(twoLines.map((row) => row.mode)).toEqual(["flexible-example", "flexible-example"]);
    expect(twoLines.map((row) => row.catalogName)).toEqual(["Two Lines", "Two Lines"]);
  });

  test("records a completed cell-by-cell review for every shape source diagram", () => {
    expect(shapeReviewRows).toHaveLength(25);
    expect(
      shapeReviewRows.map(({ reference, sourceName, runtimeId, review }) => [
        reference,
        sourceName,
        runtimeId,
        review,
      ]),
    ).toEqual(expectedShapeReviewMappings);
    expect(shapeReviewRows.every((row) => row.cellsReviewed === "25/25")).toBe(true);

    for (const review of shapeReviewRows) {
      const source = rows.find(
        (row) =>
          row.sourceFile === "shapes-bingo-patterns.pdf" && row.reference === review.reference,
      );
      const runtimePattern = patternCatalog.find((pattern) => pattern.id === review.runtimeId);
      expect(source, review.reference).toBeDefined();
      expect(runtimePattern, review.runtimeId).toBeDefined();

      if (review.review === "exact-mask-match") {
        expect(runtimePattern!.masks).toEqual([source!.mask]);
      } else {
        expect(runtimePattern!.source.references).toContain(review.reference);
      }
    }
  });

  test("records source-to-runtime parity for every reviewed letter diagram", () => {
    expect(letterReviewRows).toHaveLength(25);
    expect(
      letterReviewRows.map(({ reference, sourceName, runtimeId, review }) => [
        reference,
        sourceName,
        runtimeId,
        review,
      ]),
    ).toEqual(expectedLetterReviewMappings);
    expect(letterReviewRows.every((row) => row.cellsReviewed === "25/25")).toBe(true);

    for (const review of letterReviewRows) {
      const source = rows.find(
        (row) =>
          row.sourceFile === "letter-bingo-patterns.pdf" && row.reference === review.reference,
      );
      const runtimePattern = patternCatalog.find((pattern) => pattern.id === review.runtimeId);

      expect(source, review.reference).toBeDefined();
      expect(runtimePattern, review.runtimeId).toBeDefined();
      expect(runtimePattern).toMatchObject({
        name: review.sourceName,
        category: "letter",
        source: {
          file: "letter-bingo-patterns.pdf",
          references: [review.reference],
        },
        masks: [source!.mask],
      });
    }
  });

  test("records source-to-runtime parity for every reviewed number diagram", () => {
    expect(numberReviewRows).toHaveLength(20);
    expect(
      numberReviewRows.map(({ reference, sourceName, runtimeId, review }) => [
        reference,
        sourceName,
        runtimeId,
        review,
      ]),
    ).toEqual(expectedNumberReviewMappings);
    expect(numberReviewRows.every((row) => row.cellsReviewed === "25/25")).toBe(true);

    for (const review of numberReviewRows) {
      const source = rows.find(
        (row) =>
          row.sourceFile === "number-bingo-patterns.pdf" && row.reference === review.reference,
      );
      const runtimePattern = patternCatalog.find((pattern) => pattern.id === review.runtimeId);

      expect(source, review.reference).toBeDefined();
      expect(runtimePattern, review.runtimeId).toBeDefined();
      expect(runtimePattern).toMatchObject({
        name: review.sourceName,
        category: "number",
        source: {
          file: "number-bingo-patterns.pdf",
          references: [review.reference],
        },
        masks: [source!.mask],
      });
    }
  });

  test("records source-to-runtime parity for every reviewed Christmas diagram", () => {
    expect(christmasReviewRows).toHaveLength(12);
    expect(
      christmasReviewRows.map(({ reference, sourceName, runtimeId, review }) => [
        reference,
        sourceName,
        runtimeId,
        review,
      ]),
    ).toEqual(expectedChristmasReviewMappings);
    expect(christmasReviewRows.every((row) => row.cellsReviewed === "25/25")).toBe(true);

    for (const review of christmasReviewRows) {
      const source = rows.find(
        (row) =>
          row.sourceFile === "christmas-bingo-patterns.pdf" && row.reference === review.reference,
      );
      const runtimePattern = patternCatalog.find((pattern) => pattern.id === review.runtimeId);

      expect(source, review.reference).toBeDefined();
      expect(runtimePattern, review.runtimeId).toBeDefined();
      expect(runtimePattern).toMatchObject({
        name: review.sourceName,
        category: "christmas",
        source: {
          file: "christmas-bingo-patterns.pdf",
          references: [review.reference],
        },
        masks: [source!.mask],
      });
    }
  });

  test("treats Full House only as the source alias for Blackout", () => {
    const fullHouse = findRow("shapes-bingo-patterns.pdf", "Full House");

    expect(fullHouse.mode).toBe("alias");
    expect(fullHouse.catalogName).toBe("Blackout");
    expect(rows.filter((row) => row.catalogName === "Blackout")).toEqual([fullHouse]);
  });

  test("preserves the approved Q, W, and 10-19 masks exactly", () => {
    const approvedMasks = {
      Q: "#####/#...#/#...#/#..##/#####",
      W: "#...#/#...#/#.#.#/##.##/#...#",
      "10": "#.###/#.#.#/#.#.#/#.#.#/#.###",
      "11": ".#..#/##.##/.#..#/.#..#/.#..#",
      "12": "#.###/#...#/#.###/#.#../#.###",
      "13": "#.###/#...#/#.###/#...#/#.###",
      "14": "#.#.#/#.#.#/#.###/#...#/#...#",
      "15": "#.###/#.#../#.###/#...#/#.###",
      "16": "#.###/#.#../#.###/#.#.#/#.###",
      "17": "#.###/#.#.#/#...#/#...#/#...#",
      "18": "#.###/#.#.#/#.###/#.#.#/#.###",
      "19": "#.###/#.#.#/#.###/#...#/#...#",
    } as const;

    for (const [name, mask] of Object.entries(approvedMasks)) {
      const sourceFile = /[QW]/.test(name)
        ? "letter-bingo-patterns.pdf"
        : "number-bingo-patterns.pdf";
      expect(findRow(sourceFile, name).mask).toBe(mask);
    }
  });

  test("documents known duplicate masks without collapsing their identities", () => {
    const duplicateGroups = [
      [
        ["shapes-bingo-patterns.pdf", "Outside Edge"],
        ["letter-bingo-patterns.pdf", "O"],
      ],
      [
        ["shapes-bingo-patterns.pdf", "X"],
        ["letter-bingo-patterns.pdf", "X"],
      ],
      [
        ["shapes-bingo-patterns.pdf", "Cross"],
        ["christmas-bingo-patterns.pdf", "Cross"],
      ],
      [
        ["shapes-bingo-patterns.pdf", "Checkerboard"],
        ["christmas-bingo-patterns.pdf", "Snow"],
      ],
    ] as const;

    for (const group of duplicateGroups) {
      const masks = group.map(([sourceFile, sourceName]) => findRow(sourceFile, sourceName).mask);
      expect(new Set(masks).size, group.map((entry) => entry[1]).join(" / ")).toBe(1);
    }
  });

  test("states the center and transformation rules and future runtime source", () => {
    const normalizedCatalog = catalog.replaceAll(/\s+/g, " ");

    expect(normalizedCatalog).toContain("The center is the free square and is always satisfied");
    expect(normalizedCatalog).toContain(
      "Never rotate, reflect, translate, or otherwise transform a source mask implicitly",
    );
    expect(normalizedCatalog).toContain("`packages/patterns/src/catalog.ts`");
    expect(normalizedCatalog).toContain(
      "generated and tested from the runtime catalog so the two representations cannot diverge",
    );
  });

  test("keeps generated core documentation equal to runtime canonical data", () => {
    expect(generatedSection(catalog)).toBe(generateCorePatternDocumentation(patternCatalog));
  });

  test("changes generated documentation when canonical mask content changes", () => {
    const changedCatalog = patternCatalog.map((pattern, index) =>
      index === 0
        ? {
            ...pattern,
            masks: ["#####/#####/#####/#####/#####", ...pattern.masks.slice(1)],
          }
        : pattern,
    );

    expect(generateCorePatternDocumentation(changedCatalog)).not.toBe(
      generateCorePatternDocumentation(patternCatalog),
    );
  });
});
