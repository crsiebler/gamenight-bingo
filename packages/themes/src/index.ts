export {
  getTheme,
  themeAudioRoles,
  themeAssetRoles,
  themeAccessibilityPolicy,
  themeCatalog,
  type CatalogThemeId,
  type HexColor,
  type ThemeColorSet,
  type ThemeAssetRole,
  type ThemeAudioAssets,
  type ThemeAudioCue,
  type ThemeAudioRole,
  type ThemeDefinition,
  type ThemeMoodboard,
  type ThemeTokens,
  type ThemeVisualAssets,
  type ThemeVisualMotif,
} from "./catalog.js";
export { renderThemeAudioSprite } from "./audio.js";
export {
  assetBudgets,
  assetInventory,
  assetOptimizationPolicy,
  renderAssetInventoryMarkdown,
} from "./asset-inventory.js";
export { renderThemeAssetGalleryHtml, renderThemeSprite, validateThemeSprite } from "./assets.js";
export {
  renderThemeMoodboardHtml,
  renderThemeMoodboardMarkdown,
  themeCssVariables,
} from "./preview.js";
