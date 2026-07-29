import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  createChristmasPatternPreviews,
  generateChristmasPatternPreviewHtml,
  patternCatalog,
  type PatternPreview,
} from "../packages/patterns/src/index.js";

const goldenPath = resolve("tests/fixtures/patterns/christmas-previews.v1.json");
const previewPagePath = resolve("docs/christmas-pattern-previews.html");

describe("Christmas pattern previews", () => {
  test("matches a reviewed source-linked golden for every Christmas pattern", () => {
    const previews = createChristmasPatternPreviews(patternCatalog);
    const runtimeIds = patternCatalog
      .filter((pattern) => pattern.category === "christmas")
      .map((pattern) => pattern.id);

    expect(existsSync(goldenPath)).toBe(true);
    expect(previews.map((preview) => preview.id)).toEqual(runtimeIds);
    expect(previews).toHaveLength(12);
    expect(previews).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")) as PatternPreview[]);
  });

  test("renders every source-linked thumbnail with visible catalog metadata", () => {
    const previews = createChristmasPatternPreviews(patternCatalog);
    const html = generateChristmasPatternPreviewHtml(previews);
    const page = new DOMParser().parseFromString(html, "text/html");
    const entries = [...page.querySelectorAll<HTMLElement>("[data-pattern-preview]")];
    const thumbnails = [...page.querySelectorAll<HTMLElement>("figure[data-thumbnail]")];

    expect(entries).toHaveLength(12);
    expect(thumbnails).toHaveLength(12);
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
      expect(entry!.textContent).toContain("christmas-bingo-patterns.pdf");
      expect(figure, preview.id).not.toBeNull();
      expect(figure!.textContent).toContain(thumbnail.reference);
      expect(figure!.textContent).toContain(thumbnail.mask);
      expect(figure!.querySelector("[role='img']")?.getAttribute("aria-label")).toContain(
        preview.name,
      );
    }
  });

  test("commits the exact generated standalone Christmas gallery", () => {
    const previews = createChristmasPatternPreviews(patternCatalog);
    const generated = generateChristmasPatternPreviewHtml(previews);

    expect(existsSync(previewPagePath)).toBe(true);
    expect(readFileSync(previewPagePath, "utf8")).toBe(generated);
  });
});
