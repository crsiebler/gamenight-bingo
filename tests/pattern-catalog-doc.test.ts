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

function parseCatalogRows(markdown: string): CatalogRow[] {
  const rows: CatalogRow[] = [];
  let sourceFile: SourceFile | undefined;

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^### `docs\/(.+\.pdf)`$/);
    if (heading?.[1] && heading[1] in sourceNames) {
      sourceFile = heading[1] as SourceFile;
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
