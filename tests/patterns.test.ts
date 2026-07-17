import { describe, expect, test } from "vitest";

import {
  PatternCardStateSchema,
  PatternDefinitionSchema,
  PatternSourceSchema,
  patternCatalog,
  matchesPattern,
} from "../packages/patterns/src/index.js";

const emptyCard = () => Array<boolean>(25).fill(false);

function cardWith(...indexes: number[]): boolean[] {
  const card = emptyCard();
  for (const index of indexes) card[index] = true;
  return card;
}

function maskWith(...indexes: number[]): string {
  const required = new Set(indexes);
  return Array.from({ length: 25 }, (_, index) => (required.has(index) ? "#" : "."))
    .join("")
    .match(/.{5}/g)!
    .join("/");
}

const expectedLines = [
  [0, 1, 2, 3, 4],
  [5, 6, 7, 8, 9],
  [10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19],
  [20, 21, 22, 23, 24],
  [0, 5, 10, 15, 20],
  [1, 6, 11, 16, 21],
  [2, 7, 12, 17, 22],
  [3, 8, 13, 18, 23],
  [4, 9, 14, 19, 24],
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20],
] as const;

const expectedTwoLines: string[] = [];
for (let first = 0; first < expectedLines.length; first += 1) {
  for (let second = first + 1; second < expectedLines.length; second += 1) {
    expectedTwoLines.push(
      maskWith(...new Set([...(expectedLines[first] ?? []), ...(expectedLines[second] ?? [])])),
    );
  }
}

const expectedShapePatterns = [
  ["shape-bunny-ears", "Bunny Ears", "p1/d01", ".###./#.#.#/#.#.#/#.#.#/#.#.#"],
  ["shape-four-corners", "Four Corners", "p1/d03", "#...#/...../...../...../#...#"],
  ["shape-windmill", "Windmill", "p1/d04", "##.##/##.##/..#../##.##/##.##"],
  ["shape-outside-edge", "Outside Edge", "p1/d05", "#####/#...#/#...#/#...#/#####"],
  ["shape-airplane", "Airplane", "p1/d07", "...#./#..#./#####/#..#./...#."],
  ["shape-wine-glass", "Wine Glass", "p1/d08", "#####/.###./..#../..#../.###."],
  ["shape-x", "X", "p1/d09", "#...#/.#.#./..#../.#.#./#...#"],
  ["shape-turtle", "Turtle", "p1/d10", "..#../#####/.###./.###./#...#"],
  ["shape-stairs", "Stairs", "p1/d11", "....#/...##/..###/.####/#####"],
  ["shape-bow-tie", "Bow Tie", "p1/d12", "...../##.##/#####/##.##/....."],
  ["shape-cross", "Cross", "p1/d13", "..#../#####/..#../..#../..#.."],
  ["shape-plus", "Plus", "p1/d14", "..#../..#../#####/..#../..#.."],
  ["shape-rectangle", "Rectangle", "p1/d15", "...../#####/#...#/#####/....."],
  ["shape-heart", "Heart", "p1/d16", ".#.#./#####/#####/.###./..#.."],
  ["shape-hat", "Hat", "p1/d17", "...../.###./.###./#####/....."],
  ["shape-hour-glass", "Hour Glass", "p1/d18", "#####/.###./..#../.###./#####"],
  ["shape-pyramid", "Pyramid", "p1/d19", "...../...../..#../.###./#####"],
  ["shape-checkerboard", "Checkerboard", "p1/d20", "#.#.#/.#.#./#.#.#/.#.#./#.#.#"],
  ["shape-inside-square", "Inside Square", "p1/d21", "...../.###./.###./.###./....."],
  ["shape-kite", "Kite", "p1/d22", "...##/...##/..#../.#.../#...."],
  ["shape-smiley-face", "Smiley Face", "p1/d23", "...../.#.#./..#../#...#/.###."],
  ["shape-block-of-nine", "Block of Nine", "p1/d24", "###../###../###../...../....."],
] as const;

const expectedLetterPatterns = [
  ["letter-a", "A", "p1/d01", "#####/#...#/#####/#...#/#...#"],
  ["letter-b", "B", "p1/d02", "####./#...#/####./#...#/####."],
  ["letter-c", "C", "p1/d03", "#####/#..../#..../#..../#####"],
  ["letter-d", "D", "p1/d04", "####./#...#/#...#/#...#/####."],
  ["letter-e", "E", "p1/d05", "#####/#..../####./#..../#####"],
  ["letter-f", "F", "p1/d06", "#####/#..../#####/#..../#...."],
  ["letter-g", "G", "p1/d07", "#####/#..../#.###/#...#/#####"],
  ["letter-h", "H", "p1/d08", "#...#/#...#/#####/#...#/#...#"],
  ["letter-i", "I", "p1/d09", "#####/..#../..#../..#../#####"],
  ["letter-j", "J", "p1/d10", "#####/....#/....#/....#/#####"],
  ["letter-k", "K", "p1/d11", "#...#/#..#./###../#..#./#...#"],
  ["letter-l", "L", "p1/d12", "#..../#..../#..../#..../#####"],
  ["letter-m", "M", "p1/d13", "#...#/##.##/#.#.#/#...#/#...#"],
  ["letter-n", "N", "p1/d14", "#...#/##..#/#.#.#/#..##/#...#"],
  ["letter-o", "O", "p1/d15", "#####/#...#/#...#/#...#/#####"],
  ["letter-p", "P", "p1/d16", "####./#...#/####./#..../#...."],
  ["letter-q", "Q", "p1/d17", "#####/#...#/#...#/#..##/#####"],
  ["letter-r", "R", "p1/d18", "####./#...#/####./#..#./#...#"],
  ["letter-s", "S", "p1/d19", "#####/#..../#####/....#/#####"],
  ["letter-t", "T", "p1/d20", "#####/..#../..#../..#../..#.."],
  ["letter-u", "U", "p1/d21", "#...#/#...#/#...#/#...#/#####"],
  ["letter-v", "V", "p1/d22", "#...#/#...#/.#.#./.#.#./..#.."],
  ["letter-w", "W", "p1/d23", "#...#/#...#/#.#.#/##.##/#...#"],
  ["letter-x", "X", "p1/d24", "#...#/.#.#./..#../.#.#./#...#"],
  ["letter-y", "Y", "p1/d25", "#...#/.#.#./..#../..#../..#.."],
] as const;

function catalogPattern(id: string) {
  const pattern = patternCatalog.find((candidate) => candidate.id === id);
  expect(pattern, id).toBeDefined();
  return pattern!;
}

describe("pattern definition schema", () => {
  test("accepts one strict, versioned exact-mask definition", () => {
    const parsed = PatternDefinitionSchema.parse({
      id: "shape-asymmetric",
      name: "Asymmetric",
      category: "shape",
      version: 1,
      mode: "exact",
      source: {
        file: "shapes-bingo-patterns.pdf",
        references: ["p1/d99"],
        alias: null,
      },
      masks: ["##.../.#.../..#../...#./....#"],
    });

    expect(parsed.id).toBe("shape-asymmetric");
  });

  test("rejects malformed masks, extra fields, and invalid exact definitions", () => {
    const valid = {
      id: "shape-asymmetric",
      name: "Asymmetric",
      category: "shape",
      version: 1,
      mode: "exact",
      source: {
        file: "shapes-bingo-patterns.pdf",
        references: ["p1/d99"],
        alias: null,
      },
      masks: ["##.../.#.../..#../...#./....#"],
    } as const;

    expect(PatternDefinitionSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(PatternDefinitionSchema.safeParse({ ...valid, masks: ["#####"] }).success).toBe(false);
    expect(
      PatternDefinitionSchema.safeParse({ ...valid, masks: [...valid.masks, ...valid.masks] })
        .success,
    ).toBe(false);
  });

  test("rejects inconsistent flexible source examples", () => {
    const twoLines = catalogPattern("standard-two-lines");
    const sourceExample = twoLines.source.examples![0]!;
    const parsedSourceWithoutFile = PatternSourceSchema.safeParse({
      file: null,
      references: [],
      alias: null,
      examples: [sourceExample],
    });

    expect(parsedSourceWithoutFile.success).toBe(false);
    const exactWithSourceExample = PatternDefinitionSchema.safeParse({
      ...twoLines,
      mode: "exact",
      source: {
        ...twoLines.source,
        references: [sourceExample.reference],
        examples: [sourceExample],
      },
      masks: [sourceExample.mask],
    });
    expect(exactWithSourceExample.success).toBe(false);
    if (!exactWithSourceExample.success) {
      expect(exactWithSourceExample.error.issues.map((issue) => issue.message)).toEqual([
        "Source examples are supported only for flexible Two Lines patterns.",
      ]);
    }
    expect(
      PatternDefinitionSchema.safeParse({
        ...twoLines,
        source: {
          ...twoLines.source,
          examples: [sourceExample, sourceExample],
        },
      }).success,
    ).toBe(false);
    expect(
      PatternDefinitionSchema.safeParse({
        ...twoLines,
        source: {
          ...twoLines.source,
          examples: [sourceExample, { ...twoLines.source.examples![1]!, reference: "p1/d99" }],
        },
      }).success,
    ).toBe(false);
    expect(
      PatternDefinitionSchema.safeParse({
        ...twoLines,
        source: {
          ...twoLines.source,
          examples: [
            sourceExample,
            {
              ...twoLines.source.examples![1]!,
              mask: "#####/#####/#####/#####/#####",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  test("requires exactly 25 boolean card cells", () => {
    expect(PatternCardStateSchema.safeParse(emptyCard()).success).toBe(true);
    expect(PatternCardStateSchema.safeParse(Array<boolean>(24).fill(false)).success).toBe(false);
    expect(PatternCardStateSchema.safeParse([...emptyCard(), "marked"]).success).toBe(false);
  });
});

describe("canonical core pattern catalog", () => {
  test("defines stable metadata without a second Full House entry", () => {
    expect(
      patternCatalog
        .filter((pattern) => pattern.category === "standard")
        .map(({ id, name, category, version, mode }) => ({
          id,
          name,
          category,
          version,
          mode,
        })),
    ).toEqual([
      {
        id: "standard-one-line",
        name: "One Line",
        category: "standard",
        version: 1,
        mode: "one-line",
      },
      {
        id: "standard-two-lines",
        name: "Two Lines",
        category: "standard",
        version: 1,
        mode: "two-lines",
      },
      {
        id: "standard-blackout",
        name: "Blackout",
        category: "standard",
        version: 1,
        mode: "blackout",
      },
    ]);

    expect(catalogPattern("standard-one-line").masks).toHaveLength(12);
    expect(catalogPattern("standard-two-lines").masks).toHaveLength(66);
    expect(catalogPattern("standard-blackout")).toMatchObject({
      source: {
        file: "shapes-bingo-patterns.pdf",
        references: ["p1/d06"],
        alias: "Full House",
      },
      masks: ["#####/#####/#####/#####/#####"],
    });
    expect(patternCatalog.some((pattern) => pattern.name === "Full House")).toBe(false);
  });

  test("encodes every approved exact shape with stable IDs, sources, and masks", () => {
    const shapes = patternCatalog.filter((pattern) => pattern.category === "shape");

    expect(shapes).toHaveLength(22);
    expect(
      shapes.map((pattern) => [
        pattern.id,
        pattern.name,
        pattern.source.references[0],
        pattern.masks[0],
      ]),
    ).toEqual(expectedShapePatterns);

    for (const shape of shapes) {
      expect(shape).toMatchObject({
        category: "shape",
        version: 1,
        mode: "exact",
        source: {
          file: "shapes-bingo-patterns.pdf",
          alias: null,
        },
      });
      expect(shape.source.references).toHaveLength(1);
      expect(shape.masks).toHaveLength(1);
    }
  });

  test("offers 24 source-derived shape selections without duplicate flexible or alias entries", () => {
    const shapeSelections = patternCatalog.filter(
      (pattern) =>
        pattern.category === "shape" ||
        pattern.id === "standard-two-lines" ||
        pattern.id === "standard-blackout",
    );

    expect(shapeSelections).toHaveLength(24);
    expect(shapeSelections.filter((pattern) => pattern.name === "Two Lines")).toHaveLength(1);
    expect(shapeSelections.filter((pattern) => pattern.name === "Blackout")).toHaveLength(1);
    expect(shapeSelections.some((pattern) => pattern.name === "Full House")).toBe(false);
  });

  test("encodes A through Y with category-specific stable IDs and source masks", () => {
    const letters = patternCatalog.filter((pattern) => pattern.category === "letter");

    expect(
      letters.map((pattern) => [
        pattern.id,
        pattern.name,
        pattern.source.references[0],
        pattern.masks[0],
      ]),
    ).toEqual(expectedLetterPatterns);
    expect(letters.some((pattern) => pattern.name === "Z")).toBe(false);

    for (const letter of letters) {
      expect(letter).toMatchObject({
        category: "letter",
        version: 1,
        mode: "exact",
        source: {
          file: "letter-bingo-patterns.pdf",
          alias: null,
        },
      });
      expect(letter.source.references).toHaveLength(1);
      expect(letter.masks).toHaveLength(1);
    }
  });

  test("keeps Letter O and Letter X independent from identical shape masks", () => {
    expect(catalogPattern("letter-o").masks).toEqual(catalogPattern("shape-outside-edge").masks);
    expect(catalogPattern("letter-x").masks).toEqual(catalogPattern("shape-x").masks);
    expect(catalogPattern("letter-o").id).not.toBe(catalogPattern("shape-outside-edge").id);
    expect(catalogPattern("letter-x").id).not.toBe(catalogPattern("shape-x").id);
  });

  test("is deeply immutable", () => {
    const oneLine = catalogPattern("standard-one-line");

    expect(Object.isFrozen(patternCatalog)).toBe(true);
    expect(Object.isFrozen(oneLine)).toBe(true);
    expect(Object.isFrozen(oneLine.source)).toBe(true);
    expect(Object.isFrozen(oneLine.source.references)).toBe(true);
    expect(Object.isFrozen(oneLine.masks)).toBe(true);
    expect(() => {
      (oneLine.masks as string[])[0] = "#####/#####/#####/#####/#####";
    }).toThrow(TypeError);
  });

  test("contains exactly every valid line and distinct line-pair union", () => {
    const oneLine = catalogPattern("standard-one-line");
    const twoLines = catalogPattern("standard-two-lines");

    expect(oneLine.masks).toEqual(expectedLines.map((line) => maskWith(...line)));
    expect(twoLines.masks).toEqual(expectedTwoLines);

    for (const line of expectedLines) {
      expect(matchesPattern(oneLine, cardWith(...line.filter((index) => index !== 12)))).toBe(true);
    }

    for (const mask of expectedTwoLines) {
      const indexes = Array.from(mask.replaceAll("/", ""))
        .map((cell, index) => (cell === "#" && index !== 12 ? index : -1))
        .filter((index) => index >= 0);
      expect(matchesPattern(twoLines, cardWith(...indexes))).toBe(true);
    }
  });
});

describe("pattern matching", () => {
  test("requires an exact mask, tolerates extra daubs, and does not transform it", () => {
    const pattern = PatternDefinitionSchema.parse({
      id: "shape-asymmetric",
      name: "Asymmetric",
      category: "shape",
      version: 1,
      mode: "exact",
      source: {
        file: "shapes-bingo-patterns.pdf",
        references: ["p1/d99"],
        alias: null,
      },
      masks: ["##.../.#.../#..../...../....."],
    });

    expect(matchesPattern(pattern, cardWith(0, 1, 6, 10))).toBe(true);
    expect(matchesPattern(pattern, cardWith(0, 1, 6, 10, 24))).toBe(true);

    const transformedIndexes = {
      reflected: [3, 4, 8, 14],
      rotated: [2, 4, 8, 9],
      translated: [6, 7, 12, 16],
    } as const;
    for (const indexes of Object.values(transformedIndexes)) {
      expect(matchesPattern(pattern, cardWith(...indexes))).toBe(false);
    }
  });

  test("always satisfies a required center cell", () => {
    const pattern = PatternDefinitionSchema.parse({
      id: "shape-center",
      name: "Center",
      category: "shape",
      version: 1,
      mode: "exact",
      source: {
        file: "shapes-bingo-patterns.pdf",
        references: ["p1/d99"],
        alias: null,
      },
      masks: ["...../...../..#../...../....."],
    });

    expect(matchesPattern(pattern, emptyCard())).toBe(true);
  });

  test("accepts any complete row, column, or diagonal for One Line", () => {
    const oneLine = catalogPattern("standard-one-line");

    expect(matchesPattern(oneLine, cardWith(0, 1, 2, 3, 4))).toBe(true);
    expect(matchesPattern(oneLine, cardWith(2, 7, 17, 22))).toBe(true);
    expect(matchesPattern(oneLine, cardWith(0, 6, 18, 24))).toBe(true);
    expect(matchesPattern(oneLine, cardWith(0, 1, 2, 3))).toBe(false);
  });

  test("requires any two distinct lines and permits intersections for Two Lines", () => {
    const twoLines = catalogPattern("standard-two-lines");

    expect(matchesPattern(twoLines, cardWith(0, 1, 2, 3, 4, 5, 10, 15, 20))).toBe(true);
    expect(matchesPattern(twoLines, cardWith(0, 1, 2, 3, 4))).toBe(false);
  });

  test("requires every noncenter cell for Blackout", () => {
    const blackout = catalogPattern("standard-blackout");
    const allNoncenter = Array<boolean>(25).fill(true);
    allNoncenter[12] = false;

    expect(matchesPattern(blackout, allNoncenter)).toBe(true);
    allNoncenter[24] = false;
    expect(matchesPattern(blackout, allNoncenter)).toBe(false);
  });
});
