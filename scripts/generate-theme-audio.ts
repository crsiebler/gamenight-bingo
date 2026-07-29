import { mkdirSync, writeFileSync } from "node:fs";

import { renderThemeAudioSprite, themeCatalog } from "../packages/themes/src/index.js";

const assetDirectory = new URL("../apps/web/public/theme-audio/", import.meta.url);
mkdirSync(assetDirectory, { recursive: true });

for (const theme of themeCatalog) {
  writeFileSync(new URL(`${theme.id}.wav`, assetDirectory), renderThemeAudioSprite(theme));
}
