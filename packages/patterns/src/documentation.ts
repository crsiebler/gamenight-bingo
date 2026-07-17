import type { PatternDefinition } from "./catalog.js";

function describeSource(pattern: PatternDefinition): string {
  const { file, references, alias } = pattern.source;
  if (file === null) return "Rule definition (no PDF diagram)";

  const locations = references.map((reference) => `\`${reference}\``).join(", ");
  const source = `\`docs/${file}\` ${locations}`;
  return alias === null ? source : `${alias} alias at ${source}`;
}

function digestMasks(masks: readonly string[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of masks.join("|")) {
    hash ^= BigInt(character.charCodeAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function generateCorePatternDocumentation(patterns: readonly PatternDefinition[]): string {
  const heading = [
    "| Stable ID | Name | Category | Version | Mode | Source | Masks | Mask digest |",
    "| --------- | ---- | -------- | ------: | ---- | ------ | ----: | ----------- |",
  ];
  const rows = patterns.map(
    (pattern) =>
      `| \`${pattern.id}\` | ${pattern.name} | ${pattern.category} | ${pattern.version} | \`${pattern.mode}\` | ${describeSource(pattern)} | ${pattern.masks.length} | \`${digestMasks(pattern.masks)}\` |`,
  );

  return [...heading, ...rows].join("\n");
}
