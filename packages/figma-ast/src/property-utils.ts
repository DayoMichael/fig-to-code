import type { FigmaComponentPropertyDefinition } from "./snapshot.js";

/** Strip Figma internal suffix, e.g. "Show Title#2184:0" → "Show Title". */
export function propertyBaseName(key: string): string {
  const hash = key.indexOf("#");
  return (hash >= 0 ? key.slice(0, hash) : key).trim();
}

export function camelCase(input: string): string {
  const parts = input.split(/[\s/_-]+/).filter(Boolean);
  return parts
    .map((p, i) =>
      i === 0
        ? p.charAt(0).toLowerCase() + p.slice(1)
        : p.charAt(0).toUpperCase() + p.slice(1),
    )
    .join("");
}

export function slugifyValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function sanitizeComponentName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\s/_-]/g, "")
    .trim()
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Parse variant component names like "Type=Warning, Show Title=True". */
export function parseVariantName(name: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const segment of name.split(",")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;

    const rawKey = segment.slice(0, eq).trim();
    const rawValue = segment.slice(eq + 1).trim();
    if (!rawKey || !rawValue) continue;

    result[camelCase(rawKey)] = rawValue;
  }

  return result;
}

export function normalizePropertyDefinitions(
  defs: Record<string, FigmaComponentPropertyDefinition> | undefined,
): Array<{ key: string; baseName: string; propName: string; def: FigmaComponentPropertyDefinition }> {
  if (!defs) return [];

  return Object.entries(defs).map(([key, def]) => ({
    key,
    baseName: propertyBaseName(key),
    propName: camelCase(propertyBaseName(key)),
    def,
  }));
}

export function isIconPropertyName(baseName: string): boolean {
  return /icon/i.test(baseName);
}

export function rgbToToken(color: { r: number; g: number; b: number }): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `token:color/raw/${r}-${g}-${b}`;
}
