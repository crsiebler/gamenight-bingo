import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  createLetterPatternPreviews,
  generateLetterPatternPreviewHtml,
  patternCatalog,
  type PatternPreview,
} from "../packages/patterns/src/index.js";

const goldenPath = resolve("tests/fixtures/patterns/letter-previews.v1.json");
const previewPagePath = resolve("docs/letter-pattern-previews.html");

describe("letter pattern previews", () => {
  test("matches a reviewed source-linked golden for A through Y", () => {
    const previews = createLetterPatternPreviews(patternCatalog);
    const runtimeIds = patternCatalog
      .filter((pattern) => pattern.category === "letter")
      .map((pattern) => pattern.id);

    expect(existsSync(goldenPath)).toBe(true);
    expect(previews.map((preview) => preview.id)).toEqual(runtimeIds);
    expect(previews).toHaveLength(25);
    expect(previews).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")) as PatternPreview[]);
  });

  test("preserves the confirmed Q and W masks and omits Z", () => {
    const previews = createLetterPatternPreviews(patternCatalog);

    expect(previews.find((preview) => preview.id === "letter-q")?.thumbnails[0]?.mask).toBe(
      "#####/#...#/#...#/#..##/#####",
    );
    expect(previews.find((preview) => preview.id === "letter-w")?.thumbnails[0]?.mask).toBe(
      "#...#/#...#/#.#.#/##.##/#...#",
    );
    expect(previews.some((preview) => preview.name === "Z")).toBe(false);
  });

  test("renders all source-linked thumbnails with visible catalog metadata", () => {
    const previews = createLetterPatternPreviews(patternCatalog);
    const html = generateLetterPatternPreviewHtml(previews);
    const page = new DOMParser().parseFromString(html, "text/html");
    const entries = [...page.querySelectorAll<HTMLElement>("[data-pattern-preview]")];
    const thumbnails = [...page.querySelectorAll<HTMLElement>("figure[data-thumbnail]")];

    expect(entries).toHaveLength(25);
    expect(thumbnails).toHaveLength(25);
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
      expect(entry!.textContent).toContain("letter-bingo-patterns.pdf");
      expect(figure, preview.id).not.toBeNull();
      expect(figure!.textContent).toContain(thumbnail.reference);
      expect(figure!.textContent).toContain(thumbnail.mask);
      expect(figure!.querySelector("[role='img']")?.getAttribute("aria-label")).toContain(
        preview.name,
      );
    }
  });

  test("commits the exact generated standalone letter gallery", () => {
    const previews = createLetterPatternPreviews(patternCatalog);
    const generated = generateLetterPatternPreviewHtml(previews);

    expect(existsSync(previewPagePath)).toBe(true);
    expect(readFileSync(previewPagePath, "utf8")).toBe(generated);
  });
});
