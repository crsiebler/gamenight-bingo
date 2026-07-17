import { z } from "zod";

const PATTERN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_REFERENCE = /^p[1-9]\d*\/d0*[1-9]\d*$/;
const MASK = /^[#.]{5}(?:\/[#.]{5}){4}$/;

export const PatternCategorySchema = z.enum(["standard", "shape", "letter", "number", "christmas"]);

export const PatternModeSchema = z.enum(["exact", "one-line", "two-lines", "blackout"]);

export const PatternMaskSchema = z.string().regex(MASK);

export const PatternSourceExampleSchema = z.strictObject({
  reference: z.string().regex(SOURCE_REFERENCE),
  classification: z.literal("flexible-rule-example"),
  mask: PatternMaskSchema,
});

export const PatternSourceSchema = z
  .strictObject({
    file: z
      .enum([
        "shapes-bingo-patterns.pdf",
        "letter-bingo-patterns.pdf",
        "number-bingo-patterns.pdf",
        "christmas-bingo-patterns.pdf",
      ])
      .nullable(),
    references: z.array(z.string().regex(SOURCE_REFERENCE)).max(2),
    alias: z.string().min(1).max(128).nullable(),
    examples: z.array(PatternSourceExampleSchema).max(2).optional(),
  })
  .superRefine((source, context) => {
    if (
      source.file === null &&
      (source.references.length > 0 || source.alias !== null || (source.examples?.length ?? 0) > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "A source file is required for references and aliases.",
      });
    }

    if (source.file !== null && source.references.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A source file requires at least one diagram reference.",
        path: ["references"],
      });
    }
  });

export const PatternDefinitionSchema = z
  .strictObject({
    id: z.string().regex(PATTERN_ID).max(128),
    name: z.string().min(1).max(128),
    category: PatternCategorySchema,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    mode: PatternModeSchema,
    source: PatternSourceSchema,
    masks: z.array(PatternMaskSchema).min(1).max(66),
  })
  .superRefine((pattern, context) => {
    const requiredMaskCounts = {
      exact: 1,
      "one-line": 12,
      "two-lines": 66,
      blackout: 1,
    } as const;

    if (pattern.masks.length !== requiredMaskCounts[pattern.mode]) {
      context.addIssue({
        code: "custom",
        message: `${pattern.mode} patterns require ${requiredMaskCounts[pattern.mode]} mask(s).`,
        path: ["masks"],
      });
    }

    if (new Set(pattern.masks).size !== pattern.masks.length) {
      context.addIssue({
        code: "custom",
        message: "Pattern masks must be unique.",
        path: ["masks"],
      });
    }

    const examples = pattern.source.examples ?? [];
    if (examples.length > 0) {
      if (pattern.mode !== "two-lines") {
        context.addIssue({
          code: "custom",
          message: "Source examples are supported only for flexible Two Lines patterns.",
          path: ["source", "examples"],
        });
      }

      if (
        examples.length !== pattern.source.references.length ||
        new Set(examples.map((example) => example.reference)).size !== examples.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Source examples must map each source reference exactly once.",
          path: ["source", "examples"],
        });
      }

      for (const [index, example] of examples.entries()) {
        if (!pattern.source.references.includes(example.reference)) {
          context.addIssue({
            code: "custom",
            message: "Source example references must belong to the pattern source.",
            path: ["source", "examples", index, "reference"],
          });
        }
        if (!pattern.masks.includes(example.mask)) {
          context.addIssue({
            code: "custom",
            message: "Source example masks must be accepted by the runtime rule.",
            path: ["source", "examples", index, "mask"],
          });
        }
      }
    }
  });

export const PatternCatalogSchema = z
  .array(PatternDefinitionSchema)
  .min(1)
  .superRefine((patterns, context) => {
    const ids = new Set<string>();
    for (const [index, pattern] of patterns.entries()) {
      if (ids.has(pattern.id)) {
        context.addIssue({
          code: "custom",
          message: "Pattern IDs must be unique.",
          path: [index, "id"],
        });
      }
      ids.add(pattern.id);
    }
  });

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type PatternDefinition = DeepReadonly<z.infer<typeof PatternDefinitionSchema>>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue);
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}

function indexesToMask(indexes: ReadonlySet<number>): string {
  return Array.from({ length: 25 }, (_, index) => (indexes.has(index) ? "#" : "."))
    .join("")
    .match(/.{5}/g)!
    .join("/");
}

function createLineIndexes(): ReadonlySet<number>[] {
  const lines: Set<number>[] = [];

  for (let row = 0; row < 5; row += 1) {
    lines.push(new Set(Array.from({ length: 5 }, (_, column) => row * 5 + column)));
  }

  for (let column = 0; column < 5; column += 1) {
    lines.push(new Set(Array.from({ length: 5 }, (_, row) => row * 5 + column)));
  }

  lines.push(new Set([0, 6, 12, 18, 24]), new Set([4, 8, 12, 16, 20]));
  return lines;
}

const lineIndexes = createLineIndexes();
const oneLineMasks = lineIndexes.map(indexesToMask);
const twoLineMasks: string[] = [];

for (let first = 0; first < lineIndexes.length; first += 1) {
  for (let second = first + 1; second < lineIndexes.length; second += 1) {
    twoLineMasks.push(
      indexesToMask(new Set([...(lineIndexes[first] ?? []), ...(lineIndexes[second] ?? [])])),
    );
  }
}

function exactShape(id: string, name: string, reference: string, mask: string) {
  return {
    id: `shape-${id}`,
    name,
    category: "shape",
    version: 1,
    mode: "exact",
    source: {
      file: "shapes-bingo-patterns.pdf",
      references: [reference],
      alias: null,
    },
    masks: [mask],
  } as const;
}

function exactLetter(letter: string, reference: string, mask: string) {
  return {
    id: `letter-${letter.toLowerCase()}`,
    name: letter,
    category: "letter",
    version: 1,
    mode: "exact",
    source: {
      file: "letter-bingo-patterns.pdf",
      references: [reference],
      alias: null,
    },
    masks: [mask],
  } as const;
}

export const patternCatalog = deepFreeze(
  PatternCatalogSchema.parse([
    {
      id: "standard-one-line",
      name: "One Line",
      category: "standard",
      version: 1,
      mode: "one-line",
      source: { file: null, references: [], alias: null },
      masks: oneLineMasks,
    },
    {
      id: "standard-two-lines",
      name: "Two Lines",
      category: "standard",
      version: 1,
      mode: "two-lines",
      source: {
        file: "shapes-bingo-patterns.pdf",
        references: ["p1/d02", "p1/d25"],
        alias: null,
        examples: [
          {
            reference: "p1/d02",
            classification: "flexible-rule-example",
            mask: "#####/#..../#..../#..../#....",
          },
          {
            reference: "p1/d25",
            classification: "flexible-rule-example",
            mask: ".#.#./.#.#./.#.#./.#.#./.#.#.",
          },
        ],
      },
      masks: twoLineMasks,
    },
    {
      id: "standard-blackout",
      name: "Blackout",
      category: "standard",
      version: 1,
      mode: "blackout",
      source: {
        file: "shapes-bingo-patterns.pdf",
        references: ["p1/d06"],
        alias: "Full House",
      },
      masks: ["#####/#####/#####/#####/#####"],
    },
    exactShape("bunny-ears", "Bunny Ears", "p1/d01", ".###./#.#.#/#.#.#/#.#.#/#.#.#"),
    exactShape("four-corners", "Four Corners", "p1/d03", "#...#/...../...../...../#...#"),
    exactShape("windmill", "Windmill", "p1/d04", "##.##/##.##/..#../##.##/##.##"),
    exactShape("outside-edge", "Outside Edge", "p1/d05", "#####/#...#/#...#/#...#/#####"),
    exactShape("airplane", "Airplane", "p1/d07", "...#./#..#./#####/#..#./...#."),
    exactShape("wine-glass", "Wine Glass", "p1/d08", "#####/.###./..#../..#../.###."),
    exactShape("x", "X", "p1/d09", "#...#/.#.#./..#../.#.#./#...#"),
    exactShape("turtle", "Turtle", "p1/d10", "..#../#####/.###./.###./#...#"),
    exactShape("stairs", "Stairs", "p1/d11", "....#/...##/..###/.####/#####"),
    exactShape("bow-tie", "Bow Tie", "p1/d12", "...../##.##/#####/##.##/....."),
    exactShape("cross", "Cross", "p1/d13", "..#../#####/..#../..#../..#.."),
    exactShape("plus", "Plus", "p1/d14", "..#../..#../#####/..#../..#.."),
    exactShape("rectangle", "Rectangle", "p1/d15", "...../#####/#...#/#####/....."),
    exactShape("heart", "Heart", "p1/d16", ".#.#./#####/#####/.###./..#.."),
    exactShape("hat", "Hat", "p1/d17", "...../.###./.###./#####/....."),
    exactShape("hour-glass", "Hour Glass", "p1/d18", "#####/.###./..#../.###./#####"),
    exactShape("pyramid", "Pyramid", "p1/d19", "...../...../..#../.###./#####"),
    exactShape("checkerboard", "Checkerboard", "p1/d20", "#.#.#/.#.#./#.#.#/.#.#./#.#.#"),
    exactShape("inside-square", "Inside Square", "p1/d21", "...../.###./.###./.###./....."),
    exactShape("kite", "Kite", "p1/d22", "...##/...##/..#../.#.../#...."),
    exactShape("smiley-face", "Smiley Face", "p1/d23", "...../.#.#./..#../#...#/.###."),
    exactShape("block-of-nine", "Block of Nine", "p1/d24", "###../###../###../...../....."),
    exactLetter("A", "p1/d01", "#####/#...#/#####/#...#/#...#"),
    exactLetter("B", "p1/d02", "####./#...#/####./#...#/####."),
    exactLetter("C", "p1/d03", "#####/#..../#..../#..../#####"),
    exactLetter("D", "p1/d04", "####./#...#/#...#/#...#/####."),
    exactLetter("E", "p1/d05", "#####/#..../####./#..../#####"),
    exactLetter("F", "p1/d06", "#####/#..../#####/#..../#...."),
    exactLetter("G", "p1/d07", "#####/#..../#.###/#...#/#####"),
    exactLetter("H", "p1/d08", "#...#/#...#/#####/#...#/#...#"),
    exactLetter("I", "p1/d09", "#####/..#../..#../..#../#####"),
    exactLetter("J", "p1/d10", "#####/....#/....#/....#/#####"),
    exactLetter("K", "p1/d11", "#...#/#..#./###../#..#./#...#"),
    exactLetter("L", "p1/d12", "#..../#..../#..../#..../#####"),
    exactLetter("M", "p1/d13", "#...#/##.##/#.#.#/#...#/#...#"),
    exactLetter("N", "p1/d14", "#...#/##..#/#.#.#/#..##/#...#"),
    exactLetter("O", "p1/d15", "#####/#...#/#...#/#...#/#####"),
    exactLetter("P", "p1/d16", "####./#...#/####./#..../#...."),
    exactLetter("Q", "p1/d17", "#####/#...#/#...#/#..##/#####"),
    exactLetter("R", "p1/d18", "####./#...#/####./#..#./#...#"),
    exactLetter("S", "p1/d19", "#####/#..../#####/....#/#####"),
    exactLetter("T", "p1/d20", "#####/..#../..#../..#../..#.."),
    exactLetter("U", "p1/d21", "#...#/#...#/#...#/#...#/#####"),
    exactLetter("V", "p1/d22", "#...#/#...#/.#.#./.#.#./..#.."),
    exactLetter("W", "p1/d23", "#...#/#...#/#.#.#/##.##/#...#"),
    exactLetter("X", "p1/d24", "#...#/.#.#./..#../.#.#./#...#"),
    exactLetter("Y", "p1/d25", "#...#/.#.#./..#../..#../..#.."),
  ]),
);
