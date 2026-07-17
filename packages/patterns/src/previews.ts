import type { PatternDefinition } from "./catalog.js";

export type PatternPreviewClassification = "exact" | "flexible-rule-example" | "source-alias";

export interface PatternPreviewThumbnail {
  readonly reference: string;
  readonly classification: PatternPreviewClassification;
  readonly mask: string;
}

export interface PatternPreview {
  readonly id: string;
  readonly name: string;
  readonly mode: PatternDefinition["mode"];
  readonly source: {
    readonly file: "shapes-bingo-patterns.pdf";
    readonly alias: string | null;
  };
  readonly thumbnails: readonly PatternPreviewThumbnail[];
}

export function createShapePatternPreviews(
  patterns: readonly PatternDefinition[],
): PatternPreview[] {
  return patterns
    .filter(
      (
        pattern,
      ): pattern is PatternDefinition & {
        readonly source: PatternDefinition["source"] & {
          readonly file: "shapes-bingo-patterns.pdf";
        };
      } => pattern.source.file === "shapes-bingo-patterns.pdf",
    )
    .map((pattern) => {
      const examples = pattern.source.examples ?? [];
      let thumbnails: PatternPreviewThumbnail[];

      if (examples.length > 0) {
        thumbnails = examples.map(({ reference, classification, mask }) => ({
          reference,
          classification,
          mask,
        }));
      } else {
        const reference = pattern.source.references[0];
        const mask = pattern.masks[0];
        if (!reference || !mask || pattern.source.references.length !== 1) {
          throw new Error(`Pattern ${pattern.id} does not have one previewable source diagram.`);
        }

        thumbnails = [
          {
            reference,
            classification: pattern.source.alias === null ? "exact" : "source-alias",
            mask,
          },
        ];
      }

      return {
        id: pattern.id,
        name: pattern.name,
        mode: pattern.mode,
        source: {
          file: pattern.source.file,
          alias: pattern.source.alias,
        },
        thumbnails,
      };
    });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderThumbnail(preview: PatternPreview, thumbnail: PatternPreviewThumbnail): string {
  const rows = thumbnail.mask.split("/").map(escapeHtml).join("\n");
  const label = `${preview.name}, ${thumbnail.classification}, ${thumbnail.reference}. Required cells use # and other cells use period.`;
  const explanation =
    thumbnail.classification === "flexible-rule-example"
      ? '<p class="example-note">Flexible-rule example, not the complete Two Lines rule.</p>'
      : "";

  return `<figure data-thumbnail data-reference="${escapeHtml(thumbnail.reference)}">
<figcaption><strong>${escapeHtml(thumbnail.reference)}</strong><span>${escapeHtml(thumbnail.classification)}</span></figcaption>
${explanation}<pre class="mask-grid" role="img" data-mask="${escapeHtml(thumbnail.mask)}" aria-label="${escapeHtml(label)}">${rows}</pre>
<code class="mask-code">${escapeHtml(thumbnail.mask)}</code>
</figure>`;
}

function renderPreview(preview: PatternPreview): string {
  const alias =
    preview.source.alias === null
      ? ""
      : `<div><dt>Source alias</dt><dd>${escapeHtml(preview.source.alias)}</dd></div>`;
  const thumbnails = preview.thumbnails
    .map((thumbnail) => renderThumbnail(preview, thumbnail))
    .join("\n");

  return `<article class="pattern-card" data-pattern-preview data-pattern-id="${escapeHtml(preview.id)}" data-mode="${escapeHtml(preview.mode)}">
<header><p class="eyebrow" data-pattern-mode>${escapeHtml(preview.mode)}</p><h2>${escapeHtml(preview.name)}</h2></header>
<dl><div><dt>Stable ID</dt><dd><code>${escapeHtml(preview.id)}</code></dd></div><div><dt>Source</dt><dd><code>docs/${escapeHtml(preview.source.file)}</code></dd></div>${alias}</dl>
<div class="thumbnails">${thumbnails}</div>
</article>`;
}

export function generateShapePatternPreviewHtml(previews: readonly PatternPreview[]): string {
  const cards = previews.map(renderPreview).join("\n");

  return `<!doctype html>
<!-- prettier-ignore -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GameNight Bingo shape pattern previews</title>
<style>
:root { color-scheme: light; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f3eddf; color: #17233b; }
* { box-sizing: border-box; }
body { margin: 0; background: linear-gradient(135deg, #f3eddf 0%, #f3eddf 55%, #d9e7e3 100%); }
.page-header { padding: clamp(2rem, 7vw, 5rem) clamp(1rem, 4vw, 4rem); border-bottom: 4px solid #17233b; }
.page-header p { max-width: 68ch; line-height: 1.6; }
h1, h2, p { margin-top: 0; }
h1 { max-width: 13ch; font-family: Georgia, serif; font-size: clamp(2.5rem, 8vw, 6rem); line-height: .9; letter-spacing: -.04em; }
.gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: 1.25rem; padding: clamp(1rem, 4vw, 4rem); }
.pattern-card { min-width: 0; padding: 1.25rem; border: 2px solid #17233b; border-radius: .35rem; background: #fffdf7; box-shadow: .4rem .4rem 0 #17233b; }
.pattern-card header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; border-bottom: 1px solid #17233b; }
.pattern-card h2 { font-family: Georgia, serif; font-size: 1.65rem; }
.eyebrow { color: #9c3d2f; font-size: .75rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
dl { margin: 1rem 0; }
dl div { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: .5rem; margin: .35rem 0; }
dt { font-weight: 800; }
dd { margin: 0; overflow-wrap: anywhere; }
.thumbnails { display: grid; gap: 1rem; }
figure { margin: 0; padding: 1rem; border: 1px solid #17233b; background: #f8f2e6; }
figcaption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .5rem; margin-bottom: .75rem; }
figcaption span { color: #9c3d2f; font-size: .75rem; font-weight: 800; text-transform: uppercase; }
.example-note { font-size: .8rem; line-height: 1.4; }
.mask-grid { width: max-content; max-width: 100%; margin: 0 auto .75rem; padding: .65rem .8rem; border: 2px solid #17233b; background: #ef6f55; color: #17233b; font-size: clamp(1.5rem, 8vw, 2.25rem); font-weight: 900; line-height: 1.05; letter-spacing: .18em; text-align: center; }
.mask-code { display: block; overflow-wrap: anywhere; text-align: center; }
@media (forced-colors: active) { .mask-grid { outline: 3px solid CanvasText; outline-offset: -6px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
</style>
</head>
<body>
<header class="page-header"><p class="eyebrow">Canonical review sheet</p><h1>Shape pattern previews</h1><p>Generated from the versioned runtime catalog. Each thumbnail preserves its source orientation; # marks a required cell and . marks another cell. The free center is always satisfied during play.</p></header>
<main class="gallery">${cards}</main>
</body>
</html>
`;
}
