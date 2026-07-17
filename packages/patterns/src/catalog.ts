import { z } from "zod";

const PATTERN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_REFERENCE = /^p[1-9]\d*\/d0*[1-9]\d*$/;
const MASK = /^[#.]{5}(?:\/[#.]{5}){4}$/;

export const PatternCategorySchema = z.enum(["standard", "shape", "letter", "number", "christmas"]);

export const PatternModeSchema = z.enum(["exact", "one-line", "two-lines", "blackout"]);

export const PatternMaskSchema = z.string().regex(MASK);

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
  })
  .superRefine((source, context) => {
    if (source.file === null && (source.references.length > 0 || source.alias !== null)) {
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
  ]),
);
