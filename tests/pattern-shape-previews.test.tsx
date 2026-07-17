import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  createShapePatternPreviews,
  generateShapePatternPreviewHtml,
  patternCatalog,
  type PatternPreview,
} from "../packages/patterns/src/index.js";

const goldenPath = resolve("tests/fixtures/patterns/shape-previews.v1.json");
const previewPagePath = resolve("docs/shape-pattern-previews.html");

function readGolden(): PatternPreview[] {
  if (!existsSync(goldenPath)) return [];
  return JSON.parse(readFileSync(goldenPath, "utf8")) as PatternPreview[];
}

describe("shape pattern previews", () => {
  test("matches the reviewed golden model for every runtime shape selection", () => {
    const previews = createShapePatternPreviews(patternCatalog);
    const runtimeIds = patternCatalog
      .filter((pattern) => pattern.source.file === "shapes-bingo-patterns.pdf")
      .map((pattern) => pattern.id);

    expect(existsSync(goldenPath)).toBe(true);
    expect(previews.map((preview) => preview.id)).toEqual(runtimeIds);
    expect(previews).toHaveLength(24);
    expect(previews).toEqual(readGolden());
  });

  test("labels both Two Lines source diagrams as flexible-rule examples", () => {
    const previews = createShapePatternPreviews(patternCatalog);
    const twoLines = previews.find((preview) => preview.id === "standard-two-lines");

    expect(twoLines).toBeDefined();
    expect(twoLines!.thumbnails).toEqual([
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
    ]);

    const runtimeRule = patternCatalog.find((pattern) => pattern.id === "standard-two-lines")!;
    for (const thumbnail of twoLines!.thumbnails) {
      expect(runtimeRule.masks).toContain(thumbnail.mask);
    }
  });

  test("renders accessible thumbnails with complete catalog metadata", () => {
    const previews = createShapePatternPreviews(patternCatalog);
    const html = generateShapePatternPreviewHtml(previews);
    const page = new DOMParser().parseFromString(html, "text/html");
    const entries = [...page.querySelectorAll<HTMLElement>("[data-pattern-preview]")];
    const thumbnails = [...page.querySelectorAll<HTMLElement>("figure[data-thumbnail]")];

    expect(entries).toHaveLength(24);
    expect(thumbnails).toHaveLength(25);
    expect(page.querySelector('meta[name="viewport"]')?.getAttribute("content")).toContain(
      "width=device-width",
    );
    expect(page.querySelectorAll("script, link[rel='stylesheet']")).toHaveLength(0);

    for (const preview of previews) {
      const entry = page.querySelector<HTMLElement>(`[data-pattern-id="${preview.id}"]`);
      expect(entry, preview.id).not.toBeNull();
      expect(entry!.textContent).toContain(preview.name);
      expect(entry!.textContent).toContain(preview.id);
      expect(entry!.textContent).toContain(preview.mode);
      expect(entry!.dataset["mode"]).toBe(preview.mode);
      expect(entry!.querySelector("[data-pattern-mode]")?.textContent).toBe(preview.mode);
      expect(entry!.textContent).toContain(preview.source.file);

      for (const thumbnail of preview.thumbnails) {
        const figure = entry!.querySelector<HTMLElement>(
          `figure[data-reference="${thumbnail.reference}"]`,
        );
        const grid = figure?.querySelector<HTMLElement>("[role='img']");

        expect(figure, `${preview.id} ${thumbnail.reference}`).not.toBeNull();
        expect(figure!.textContent).toContain(thumbnail.reference);
        expect(figure!.textContent).toContain(thumbnail.classification);
        expect(figure!.textContent).toContain(thumbnail.mask);
        expect(grid?.getAttribute("aria-label")).toContain(preview.name);
        expect(grid?.dataset["mask"]).toBe(thumbnail.mask);
        expect(grid?.textContent?.trim().split(/\s+/)).toEqual(thumbnail.mask.split("/"));
      }
    }
  });

  test("commits the exact generated standalone gallery", () => {
    const generated = generateShapePatternPreviewHtml(createShapePatternPreviews(patternCatalog));

    expect(existsSync(previewPagePath)).toBe(true);
    expect(readFileSync(previewPagePath, "utf8")).toBe(generated);
  });
});
