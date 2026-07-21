import { mkdirSync, writeFileSync } from "node:fs";

import {
  renderThemeAssetGalleryHtml,
  renderThemeMoodboardHtml,
  renderThemeMoodboardMarkdown,
  renderThemeSprite,
  themeCatalog,
  validateThemeSprite,
} from "../packages/themes/src/index.js";

const assetDirectory = new URL("../apps/web/public/theme-assets/", import.meta.url);
mkdirSync(assetDirectory, { recursive: true });

for (const theme of themeCatalog) {
  const sprite = renderThemeSprite(theme);
  const validationErrors = validateThemeSprite(sprite);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid ${theme.id} sprite: ${validationErrors.join(" ")}`);
  }
  writeFileSync(new URL(`${theme.id}.svg`, assetDirectory), sprite);
}

writeFileSync(new URL("../docs/theme-assets.html", import.meta.url), renderThemeAssetGalleryHtml());
writeFileSync(
  new URL("../docs/theme-moodboards.html", import.meta.url),
  renderThemeMoodboardHtml(),
);
writeFileSync(
  new URL("../docs/theme-moodboards.md", import.meta.url),
  renderThemeMoodboardMarkdown(),
);
