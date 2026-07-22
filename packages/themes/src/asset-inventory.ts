import { themeCatalog, type CatalogThemeId } from "./catalog.js";

export const assetBudgets = {
  selectedThemeAudioBytes: 1_000_000,
  selectedThemeVisualCompressedBytes: 500_000,
} as const;

export const assetOptimizationPolicy = {
  futureRasterFormats: ["avif", "webp", "source"],
  rasterReason:
    "Current runtime visuals are compact scalable SVG vectors; raster copies would lose scaling and currentColor behavior while duplicating payloads.",
  rasterVariants: "not-applicable",
  runtimeRasterAssets: [],
} as const;

type AssetDelivery = "selected-visual" | "opt-in-audio" | "reference-only";

type AssetInventoryEntry = {
  readonly approval: string;
  readonly author: string;
  readonly delivery: AssetDelivery;
  readonly format: "pdf" | "svg" | "wav";
  readonly license: string;
  readonly modifications: string;
  readonly origin: "generated" | "nongenerated";
  readonly path: string;
  readonly sha256?: string;
  readonly source: string;
  readonly themeIds: readonly CatalogThemeId[];
};

const generatedApproval = "Approved by the product owner through PRD stories US-054 and US-055";

const generatedThemeAssets: readonly AssetInventoryEntry[] = themeCatalog.flatMap((theme) => [
  {
    approval: generatedApproval,
    author: "GameNight Bingo",
    delivery: "selected-visual",
    format: "svg",
    license: "Project-original",
    modifications:
      "Generated deterministically; edit canonical theme metadata or renderer, not this file",
    origin: "generated",
    path: `apps/web/public${theme.visuals.spriteUrl}`,
    source: "packages/themes/src/catalog.ts and packages/themes/src/assets.ts",
    themeIds: [theme.id],
  },
  {
    approval: generatedApproval,
    author: theme.audio.provenance.author,
    delivery: "opt-in-audio",
    format: "wav",
    license: theme.audio.provenance.license,
    modifications:
      "Generated deterministically; edit canonical theme metadata or renderer, not this file",
    origin: "generated",
    path: `apps/web/public${theme.audio.spriteUrl}`,
    source: "packages/themes/src/catalog.ts and packages/themes/src/audio.ts",
    themeIds: [theme.id],
  },
]);

const referenceApproval =
  "Approved by the product owner as canonical pattern input through PRD stories US-010 through US-019";
const referenceAuthor = "Unknown; the supplied PDF metadata contains no author or creator";
const referenceLicense = "Reference-only project input; no external reuse license is asserted";
const referenceSource = "Project-supplied Bingo pattern reference PDF";

const referenceAssets = [
  {
    path: "docs/christmas-bingo-patterns.pdf",
    sha256: "957ca903236baf3241466678f4c4b7d89a256f9d283c6f76ede631dda1f4a087",
  },
  {
    path: "docs/letter-bingo-patterns.pdf",
    sha256: "0284e465b69bdfe08253b4e32440ce0f1e1b6602e7f0de551f0181fe508622a3",
  },
  {
    path: "docs/number-bingo-patterns.pdf",
    sha256: "328265d8b67a7aa7dec4313b1a76afb79b0f64ea95360acc8650bbef76893a2f",
  },
  {
    path: "docs/shapes-bingo-patterns.pdf",
    sha256: "be160e868df527ee9b1039d45f447190c3f90fe86666250a53b0544492dc74e8",
  },
].map(({ path, sha256 }): AssetInventoryEntry => ({
  approval: referenceApproval,
  author: referenceAuthor,
  delivery: "reference-only",
  format: "pdf",
  license: referenceLicense,
  modifications: "None",
  origin: "nongenerated",
  path,
  sha256,
  source: referenceSource,
  themeIds: [],
}));

export const assetInventory: readonly AssetInventoryEntry[] = [
  ...generatedThemeAssets,
  ...referenceAssets,
];

function tableValue(value: string): string {
  return value.replaceAll("|", "\\|");
}

export function renderAssetInventoryMarkdown(): string {
  const generatedRows = assetInventory
    .filter(({ origin }) => origin === "generated")
    .map(
      (asset) =>
        `| \`${asset.path}\` | ${asset.format.toUpperCase()} | ${asset.delivery} | ${asset.themeIds.join(", ")} | ${tableValue(asset.source)} |`,
    )
    .join("\n");
  const referenceRows = assetInventory
    .filter(({ origin }) => origin === "nongenerated")
    .map(
      (asset) =>
        `| \`${asset.path}\` | ${tableValue(asset.source)} | ${tableValue(asset.author)} | ${tableValue(asset.license)} | ${tableValue(asset.modifications)} | ${tableValue(asset.approval)} | \`${asset.sha256}\` |`,
    )
    .join("\n");

  return `# Asset Inventory And Optimization

This document is generated from \`packages/themes/src/asset-inventory.ts\`. Update the canonical inventory, then run \`bun scripts/generate-theme-assets.ts\` instead of editing this file directly.

## Delivery And Budgets

- A lobby requests one selected-theme SVG sprite. The aggregate selected visual payload must remain at or below **500,000 compressed bytes** under both gzip and Brotli.
- Theme audio remains inert until **explicit sound opt-in**, then requests one selected-theme WAV sprite whose aggregate raw payload must remain at or below **1,000,000 raw bytes**.
- Nonselected visual and audio themes are not prefetched. Tests verify selected-only URLs and prevent an asset inventory from silently growing beyond the aggregate budgets.
- Decorative SVG is silent and unfocusable. While it loads or if it fails, a **static geometric fallback** remains behind semantic HTML; gameplay labels, states, controls, and results do not depend on decoration or sound.

## Raster Formats

The runtime raster audit found no suitable raster assets. Current visuals are compact scalable SVG vectors that preserve sharp resizing and \`currentColor\` theme treatment; rasterizing them would duplicate payloads and reduce flexibility without improving delivery. AVIF/WebP variants are therefore not applicable to the current asset set.

If a future approved raster asset is necessary, serve it with \`<picture>\` in this fallback order: **AVIF, then WebP, then the source format**. Add every variant to the inventory and include the full selected-theme aggregate in budget tests.

## Generated Runtime Assets

These project-original outputs are reproducible from canonical metadata. Regenerate SVG sprites with \`bun scripts/generate-theme-assets.ts\` and WAV sprites with \`bun scripts/generate-theme-audio.ts\`.

<!-- prettier-ignore -->
| Path | Format | Delivery | Theme scope | Canonical source |
| --- | --- | --- | --- | --- |
${generatedRows}

## Nongenerated Reference Assets

The supplied PDFs are retained only as source references for the canonical pattern review. Their embedded metadata names no author, creator, or license, so this inventory records that uncertainty rather than inferring rights. SHA-256 binds each approval record to the reviewed bytes.

<!-- prettier-ignore -->
| Path | Source | Author | License | Modifications | Approval | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
${referenceRows}
`;
}
