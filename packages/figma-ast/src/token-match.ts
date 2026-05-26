import type { TokenCatalog } from "@fig2code/spec";

export function normalizeColorTokenName(name: string): string {
  return name.trim().replace(/\//g, "-").replace(/\s+/g, "-").toLowerCase();
}

/**
 * If a Figma variable is bound, use its name directly as the token.
 * Otherwise fall back to raw RGB (which resolve-pruned-spec will handle).
 */
export function matchColorToToken(
  color: { r: number; g: number; b: number },
  _catalog?: TokenCatalog,
  colorToken?: string,
): string {
  if (colorToken) {
    return `token:color/${normalizeColorTokenName(colorToken)}`;
  }

  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `token:color/raw/${r}-${g}-${b}`;
}

/**
 * If a Figma variable is bound for spacing, use its name directly.
 * Otherwise fall back to raw px.
 */
export function matchSpacingToToken(value: number, _catalog?: TokenCatalog, variableToken?: string): string {
  if (variableToken) {
    return `token:spacing/${variableToken}`;
  }
  return `token:spacing/raw/${Math.round(value)}px`;
}

/**
 * If a Figma variable is bound for radius, use its name directly.
 * Otherwise fall back to raw px.
 */
export function matchRadiusToToken(value: number, _catalog?: TokenCatalog, variableToken?: string): string {
  if (variableToken) {
    return `token:radius/${variableToken}`;
  }
  return `token:radius/raw/${Math.round(value)}px`;
}
