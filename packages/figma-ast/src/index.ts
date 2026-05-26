export { pruneNodeTree, sanitizeComponentName } from "./prune.js";
export type { FigmaNodeSnapshot, FigmaComponentPropertyDefinition } from "./snapshot.js";
export type { PruneOptions } from "./prune.js";
export {
  camelCase,
  parseVariantName,
  propertyBaseName,
  sanitizeComponentName as sanitizeFigmaComponentName,
} from "./property-utils.js";
export {
  matchColorToToken,
  matchSpacingToToken,
  matchRadiusToToken,
  normalizeColorTokenName,
} from "./token-match.js";
export {
  matchTypographyToTokens,
  parseFontWeightFromStyle,
} from "./typography.js";
