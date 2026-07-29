import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  createNumberPatternPreviews,
  generateNumberPatternPreviewHtml,
  patternCatalog,
  type PatternPreview,
} from "../packages/patterns/src/index.js";

const goldenPath = resolve("tests/fixtures/patterns/number-previews.v1.json");
const previewPagePath = resolve("docs/number-pattern-previews.html");

describe("number pattern previews", () => {
  test("matches a reviewed source-linked golden for 0 through 19", () => {
    const previews = createNumberPatternPreviews(patternCatalog);
    const runtimeIds = patternCatalog
      .filter((pattern) => pattern.category === "number")
      .map((pattern) => pattern.id);

    expect(existsSync(goldenPath)).toBe(true);
    expect(previews.map((preview) => preview.id)).toEqual(runtimeIds);
    expect(previews).toHaveLength(20);
    expect(previews).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")) as PatternPreview[]);
  });

  test("preserves every approved 10 through 19 mask", () => {
    const previews = createNumberPatternPreviews(patternCatalog);
    const approvedMasks = [
      "#.###/#.#.#/#.#.#/#.#.#/#.###",
      ".#..#/##.##/.#..#/.#..#/.#..#",
      "#.###/#...#/#.###/#.#../#.###",
      "#.###/#...#/#.###/#...#/#.###",
      "#.#.#/#.#.#/#.###/#...#/#...#",
      "#.###/#.#../#.###/#...#/#.###",
      "#.###/#.#../#.###/#.#.#/#.###",
      "#.###/#.#.#/#...#/#...#/#...#",
      "#.###/#.#.#/#.###/#.#.#/#.###",
      "#.###/#.#.#/#.###/#...#/#...#",
    ];

    expect(previews.slice(10).map((preview) => preview.thumbnails[0]?.mask)).toEqual(approvedMasks);
  });

  test("renders all source-linked thumbnails with visible catalog metadata", () => {
    const previews = createNumberPatternPreviews(patternCatalog);
    const html = generateNumberPatternPreviewHtml(previews);
    const page = new DOMParser().parseFromString(html, "text/html");
    const entries = [...page.querySelectorAll<HTMLElement>("[data-pattern-preview]")];
    const thumbnails = [...page.querySelectorAll<HTMLElement>("figure[data-thumbnail]")];

    expect(entries).toHaveLength(20);
    expect(thumbnails).toHaveLength(20);
    expect(page.querySelectorAll("script, link[rel='stylesheet']")).toHaveLength(0);

    for (const preview of previews) {
      const entry = page.querySelector<HTMLElement>(`[data-pattern-id="${preview.id}"]`);
      const thumbnail = preview.thumbnails[0]!;
      const figure = entry?.querySelector<HTMLElement>(
        `figure[data-reference="${thumbnail.reference}"]`,
      );

      expect(entry, preview.id).not.toBeNull();
      expect(entry!.textContent).toContain(preview.name);
      expect(entry!.textContent).toContain(preview.id);
      expect(entry!.querySelector("[data-pattern-mode]")?.textContent).toBe("exact");
      expect(entry!.textContent).toContain("number-bingo-patterns.pdf");
      expect(figure, preview.id).not.toBeNull();
      expect(figure!.textContent).toContain(thumbnail.reference);
      expect(figure!.textContent).toContain(thumbnail.mask);
      expect(figure!.querySelector("[role='img']")?.getAttribute("aria-label")).toContain(
        preview.name,
      );
    }
  });

  test("commits the exact generated standalone number gallery", () => {
    const previews = createNumberPatternPreviews(patternCatalog);
    const generated = generateNumberPatternPreviewHtml(previews);

    expect(existsSync(previewPagePath)).toBe(true);
    expect(readFileSync(previewPagePath, "utf8")).toBe(generated);
  });
});
