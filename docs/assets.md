# Asset Inventory And Optimization

This document is generated from `packages/themes/src/asset-inventory.ts`. Update the canonical inventory, then run `bun scripts/generate-theme-assets.ts` instead of editing this file directly.

## Delivery And Budgets

- A lobby requests one selected-theme SVG sprite. The aggregate selected visual payload must remain at or below **500,000 compressed bytes** under both gzip and Brotli.
- Theme audio remains inert until **explicit sound opt-in**, then requests one selected-theme WAV sprite whose aggregate raw payload must remain at or below **1,000,000 raw bytes**.
- Nonselected visual and audio themes are not prefetched. Tests verify selected-only URLs and prevent an asset inventory from silently growing beyond the aggregate budgets.
- Decorative SVG is silent and unfocusable. While it loads or if it fails, a **static geometric fallback** remains behind semantic HTML; gameplay labels, states, controls, and results do not depend on decoration or sound.

## Raster Formats

The runtime raster audit found no suitable raster assets. Current visuals are compact scalable SVG vectors that preserve sharp resizing and `currentColor` theme treatment; rasterizing them would duplicate payloads and reduce flexibility without improving delivery. AVIF/WebP variants are therefore not applicable to the current asset set.

If a future approved raster asset is necessary, serve it with `<picture>` in this fallback order: **AVIF, then WebP, then the source format**. Add every variant to the inventory and include the full selected-theme aggregate in budget tests.

## Generated Runtime Assets

These project-original outputs are reproducible from canonical metadata. Regenerate SVG sprites with `bun scripts/generate-theme-assets.ts` and WAV sprites with `bun scripts/generate-theme-audio.ts`.

<!-- prettier-ignore -->
| Path | Format | Delivery | Theme scope | Canonical source |
| --- | --- | --- | --- | --- |
| `apps/web/public/theme-assets/animals.svg` | SVG | selected-visual | animals | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/animals.wav` | WAV | opt-in-audio | animals | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/nature.svg` | SVG | selected-visual | nature | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/nature.wav` | WAV | opt-in-audio | nature | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/superheroes.svg` | SVG | selected-visual | superheroes | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/superheroes.wav` | WAV | opt-in-audio | superheroes | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/pirates.svg` | SVG | selected-visual | pirates | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/pirates.wav` | WAV | opt-in-audio | pirates | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/ghosts.svg` | SVG | selected-visual | ghosts | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/ghosts.wav` | WAV | opt-in-audio | ghosts | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/sports.svg` | SVG | selected-visual | sports | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/sports.wav` | WAV | opt-in-audio | sports | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/christmas.svg` | SVG | selected-visual | christmas | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/christmas.wav` | WAV | opt-in-audio | christmas | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/halloween.svg` | SVG | selected-visual | halloween | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/halloween.wav` | WAV | opt-in-audio | halloween | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/july-4th.svg` | SVG | selected-visual | july-4th | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/july-4th.wav` | WAV | opt-in-audio | july-4th | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/valentines-day.svg` | SVG | selected-visual | valentines-day | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/valentines-day.wav` | WAV | opt-in-audio | valentines-day | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |
| `apps/web/public/theme-assets/birthday.svg` | SVG | selected-visual | birthday | packages/themes/src/catalog.ts and packages/themes/src/assets.ts |
| `apps/web/public/theme-audio/birthday.wav` | WAV | opt-in-audio | birthday | packages/themes/src/catalog.ts and packages/themes/src/audio.ts |

## Nongenerated Reference Assets

The supplied PDFs are retained only as source references for the canonical pattern review. Their embedded metadata names no author, creator, or license, so this inventory records that uncertainty rather than inferring rights. SHA-256 binds each approval record to the reviewed bytes.

<!-- prettier-ignore -->
| Path | Source | Author | License | Modifications | Approval | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| `docs/christmas-bingo-patterns.pdf` | Project-supplied Bingo pattern reference PDF | Unknown; the supplied PDF metadata contains no author or creator | Reference-only project input; no external reuse license is asserted | None | Approved by the product owner as canonical pattern input through PRD stories US-010 through US-019 | `957ca903236baf3241466678f4c4b7d89a256f9d283c6f76ede631dda1f4a087` |
| `docs/letter-bingo-patterns.pdf` | Project-supplied Bingo pattern reference PDF | Unknown; the supplied PDF metadata contains no author or creator | Reference-only project input; no external reuse license is asserted | None | Approved by the product owner as canonical pattern input through PRD stories US-010 through US-019 | `0284e465b69bdfe08253b4e32440ce0f1e1b6602e7f0de551f0181fe508622a3` |
| `docs/number-bingo-patterns.pdf` | Project-supplied Bingo pattern reference PDF | Unknown; the supplied PDF metadata contains no author or creator | Reference-only project input; no external reuse license is asserted | None | Approved by the product owner as canonical pattern input through PRD stories US-010 through US-019 | `328265d8b67a7aa7dec4313b1a76afb79b0f64ea95360acc8650bbef76893a2f` |
| `docs/shapes-bingo-patterns.pdf` | Project-supplied Bingo pattern reference PDF | Unknown; the supplied PDF metadata contains no author or creator | Reference-only project input; no external reuse license is asserted | None | Approved by the product owner as canonical pattern input through PRD stories US-010 through US-019 | `be160e868df527ee9b1039d45f447190c3f90fe86666250a53b0544492dc74e8` |
