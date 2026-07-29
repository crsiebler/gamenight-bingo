import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  assetBudgets,
  assetInventory,
  assetOptimizationPolicy,
  renderAssetInventoryMarkdown,
  renderThemeAudioSprite,
  renderThemeSprite,
  themeCatalog,
} from "../packages/themes/src/index.js";

const repositoryRoot = new URL("../", import.meta.url);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("asset optimization and provenance", () => {
  it("registers every tracked media asset exactly once", () => {
    const trackedMedia = execFileSync("git", ["ls-files", "apps/web/public/**", "docs/**"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((path) => path.startsWith("apps/web/public/") || !/\.(?:html|md)$/.test(path))
      .sort();
    const registered = assetInventory.map(({ path }) => path).sort();

    expect(new Set(registered).size).toBe(registered.length);
    expect(registered).toEqual(trackedMedia);
  });

  it("binds every nongenerated asset to complete approved provenance", () => {
    const nongenerated = assetInventory.filter(({ origin }) => origin === "nongenerated");

    expect(nongenerated.map(({ path }) => path).sort()).toEqual([
      "docs/christmas-bingo-patterns.pdf",
      "docs/letter-bingo-patterns.pdf",
      "docs/number-bingo-patterns.pdf",
      "docs/shapes-bingo-patterns.pdf",
    ]);
    for (const asset of nongenerated) {
      expect(asset.source.length, `${asset.path} source`).toBeGreaterThan(10);
      expect(asset.author.length, `${asset.path} author`).toBeGreaterThan(10);
      expect(asset.license.length, `${asset.path} license`).toBeGreaterThan(10);
      expect(asset.modifications.length, `${asset.path} modifications`).toBeGreaterThan(0);
      expect(asset.approval.length, `${asset.path} approval`).toBeGreaterThan(10);
      expect(asset.sha256, `${asset.path} digest`).toMatch(/^[a-f0-9]{64}$/);
      expect(
        sha256(new Uint8Array(readFileSync(new URL(asset.path, repositoryRoot)))),
        `${asset.path} content`,
      ).toBe(asset.sha256);
    }
  });

  it("enforces aggregate selected-theme visual and audio budgets", () => {
    expect(assetBudgets).toEqual({
      selectedThemeAudioBytes: 1_000_000,
      selectedThemeVisualCompressedBytes: 500_000,
    });

    for (const theme of themeCatalog) {
      const visualPayloads = assetInventory
        .filter(
          ({ delivery, themeIds }) => delivery === "selected-visual" && themeIds.includes(theme.id),
        )
        .map(({ path }) => readFileSync(new URL(path, repositoryRoot)));
      const audioPayloads = assetInventory
        .filter(
          ({ delivery, themeIds }) => delivery === "opt-in-audio" && themeIds.includes(theme.id),
        )
        .map(({ path }) => readFileSync(new URL(path, repositoryRoot)));

      expect(visualPayloads.length).toBeGreaterThan(0);
      expect(audioPayloads.length).toBeGreaterThan(0);
      expect(visualPayloads[0]?.toString("utf8")).toBe(renderThemeSprite(theme));
      expect(audioPayloads[0]).toEqual(Buffer.from(renderThemeAudioSprite(theme)));
      expect(
        visualPayloads.reduce((total, payload) => total + gzipSync(payload).byteLength, 0),
        `${theme.id} selected visual gzip budget`,
      ).toBeLessThanOrEqual(assetBudgets.selectedThemeVisualCompressedBytes);
      expect(
        visualPayloads.reduce(
          (total, payload) => total + brotliCompressSync(payload).byteLength,
          0,
        ),
        `${theme.id} selected visual Brotli budget`,
      ).toBeLessThanOrEqual(assetBudgets.selectedThemeVisualCompressedBytes);
      expect(
        audioPayloads.reduce((total, payload) => total + payload.byteLength, 0),
        `${theme.id} opt-in audio budget`,
      ).toBeLessThanOrEqual(assetBudgets.selectedThemeAudioBytes);
    }

    for (const asset of assetInventory) {
      if (asset.delivery === "reference-only") {
        expect(asset.themeIds, `${asset.path} theme scope`).toEqual([]);
      } else {
        expect(asset.themeIds.length, `${asset.path} theme scope`).toBeGreaterThan(0);
      }
    }
  });

  it("records the raster audit and future AVIF/WebP fallback order", () => {
    expect(assetOptimizationPolicy.runtimeRasterAssets).toEqual([]);
    expect(assetOptimizationPolicy.rasterVariants).toBe("not-applicable");
    expect(assetOptimizationPolicy.rasterReason).toMatch(/svg.*scal|vector.*scal/i);
    expect(assetOptimizationPolicy.futureRasterFormats).toEqual(["avif", "webp", "source"]);
  });

  it("keeps generated asset documentation in parity with canonical policy", () => {
    const documentation = readFileSync(new URL("docs/assets.md", repositoryRoot), "utf8");

    expect(documentation).toBe(renderAssetInventoryMarkdown());
    expect(documentation).toContain("AVIF, then WebP, then the source format");
    expect(documentation).toContain("500,000 compressed bytes");
    expect(documentation).toContain("1,000,000 raw bytes");
    expect(documentation).toContain("static geometric fallback");
    expect(documentation).toContain("explicit sound opt-in");
  });
});
