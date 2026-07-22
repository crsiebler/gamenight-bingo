export {
  auditPatternCatalog,
  parsePatternCatalogSourceDiagrams,
  type PatternCatalogAuditInput,
  type PatternCatalogAuditIssue,
  type PatternCatalogAuditIssueCode,
  type PatternCatalogSourceDiagram,
  type PatternCatalogSourceDisposition,
} from "./audit.js";
export {
  PatternCatalogSchema,
  PatternCategorySchema,
  PatternDefinitionSchema,
  PatternMaskSchema,
  PatternModeSchema,
  PatternSourceSchema,
  PatternSourceExampleSchema,
  patternCatalog,
  type PatternDefinition,
} from "./catalog.js";
export { generateCorePatternDocumentation } from "./documentation.js";
export {
  PatternCardStateSchema,
  calculatePatternProgress,
  matchesPattern,
  type PatternCardState,
  type PatternProgress,
  type PatternProgressInput,
} from "./matcher.js";
export {
  createChristmasPatternPreviews,
  createLetterPatternPreviews,
  createNumberPatternPreviews,
  createShapePatternPreviews,
  generateChristmasPatternPreviewHtml,
  generateLetterPatternPreviewHtml,
  generateNumberPatternPreviewHtml,
  generateShapePatternPreviewHtml,
  type PatternPreview,
  type PatternPreviewClassification,
  type PatternPreviewSourceFile,
  type PatternPreviewThumbnail,
} from "./previews.js";
