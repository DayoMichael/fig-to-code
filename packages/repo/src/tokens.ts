import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProjectTokensSummary,
  StyleSystem,
  TokenCatalog,
  TokenCategory,
  TokenConfig,
  TokenEntry,
  TokenFormat,
  TypographyCatalog,
  VcsConfig,
} from "@fig2code/spec";
import { createGitHostProvider } from "@fig2code/git-host";
import { typographyToTokenResolver } from "./typography.js";

export interface BuildTokenConfigInput {
  rootDir: string;
  tokenPaths: string[];
  fontPaths?: string[];
  tailwindConfigPath?: string;
  styleSystem?: StyleSystem;
  typographyCatalog?: TypographyCatalog;
}

export interface BuildRemoteTokenConfigInput {
  vcs: VcsConfig;
  token: string;
  atlassianEmail?: string;
  tokenPaths: string[];
  fontPaths?: string[];
  tailwindConfigPath?: string;
  styleSystem?: StyleSystem;
  typographyCatalog?: TypographyCatalog;
}

export async function buildTokenConfig(input: BuildTokenConfigInput): Promise<TokenConfig> {
  const sources = await collectTokenSourcesFromDisk(input);
  return buildTokenConfigFromSources(input.tokenPaths, sources, input.styleSystem, input.typographyCatalog);
}

export async function buildTokenConfigFromRemote(
  input: BuildRemoteTokenConfigInput,
): Promise<TokenConfig> {
  const git = createGitHostProvider(input.vcs.provider);
  const auth = {
    token: input.token,
    atlassianEmail: input.atlassianEmail,
  };
  const sources = await collectTokenSourcesFromGit(input, git.readFile.bind(git), auth);
  return buildTokenConfigFromSources(input.tokenPaths, sources, input.styleSystem, input.typographyCatalog);
}

function buildTokenConfigFromSources(
  tokenPaths: string[],
  sources: TokenSource[],
  styleSystem?: StyleSystem,
  typographyCatalog?: TypographyCatalog,
): TokenConfig {
  const entries: TokenEntry[] = [];
  let format: TokenFormat = "js-object";
  let sourcePath = tokenPaths[0] ?? "src/tokens";
  let sourceExcerpt = "";

  for (const source of sources) {
    if (!sourceExcerpt) {
      sourceExcerpt = truncateSource(source.content);
    }

    if (source.path.includes("tailwind.config") || source.content.includes("theme:")) {
      format = "tailwind-config";
      sourcePath = source.path;
      entries.push(...parseTailwindTheme(source.content, styleSystem));
      continue;
    }

    if (source.path.endsWith(".css") || /--(?:color|spacing|radius)-/.test(source.content)) {
      format = "css-variables";
      sourcePath = source.path;
      entries.push(...parseCssTokenVariables(source.content, styleSystem));
      continue;
    }

    if (source.path.endsWith(".json")) {
      format = "json";
      sourcePath = source.path;
      entries.push(...parseJsonTokens(source.content, styleSystem));
    }
  }

  if (typographyCatalog) {
    entries.push(...typographyEntriesFromCatalog(typographyCatalog, styleSystem));
  }

  return {
    tokenPaths,
    catalog: {
      sourcePath: tokenPaths.length > 1 ? tokenPaths.join(", ") : sourcePath,
      format,
      styleSystem,
      entries: dedupeTokenEntries(entries),
    },
    sourceExcerpt,
  };
}

export function tokenCatalogToResolver(catalog: TokenCatalog): Record<string, string> {
  const resolver: Record<string, string> = {};

  for (const entry of catalog.entries) {
    resolver[`${entry.category}/${entry.name}`] = entry.usage;
  }

  return resolver;
}

export function mergeTokenResolvers(...resolvers: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...resolvers);
}

export function buildCombinedTokenResolver(options: {
  typographyCatalog?: TypographyCatalog;
  tokenCatalog?: TokenCatalog;
  styleSystem?: StyleSystem;
}): Record<string, string> {
  const typography = options.typographyCatalog
    ? typographyToTokenResolver(options.typographyCatalog, options.styleSystem)
    : {};
  const tokens = options.tokenCatalog ? tokenCatalogToResolver(options.tokenCatalog) : {};
  return mergeTokenResolvers(typography, tokens);
}

export function buildProjectTokensSummary(config: TokenConfig): ProjectTokensSummary {
  const categories: ProjectTokensSummary["categories"] = {
    color: [],
    spacing: [],
    radius: [],
    typography: [],
    fontFamily: [],
  };

  for (const entry of config.catalog.entries) {
    categories[entry.category].push({
      name: entry.name,
      usage: entry.usage,
      value: entry.value,
    });
  }

  return {
    sourcePath: config.catalog.sourcePath,
    format: config.catalog.format,
    styleSystem: config.catalog.styleSystem,
    categories,
    sourceExcerpt: config.sourceExcerpt,
  };
}

function typographyEntriesFromCatalog(
  catalog: TypographyCatalog,
  styleSystem?: StyleSystem,
): TokenEntry[] {
  const entries: TokenEntry[] = [];

  for (const scale of catalog.scales) {
    const category: TokenCategory =
      scale.fontFamily != null
        ? "fontFamily"
        : scale.fontSize != null || scale.lineHeight != null
          ? "typography"
          : "typography";

    entries.push({
      category,
      name: scale.name,
      usage: scale.usage,
      value: formatTypographyValue(scale),
    });
  }

  for (const [name] of Object.entries(catalog.families)) {
    entries.push({
      category: "fontFamily",
      name,
      usage: styleSystem === "tailwind" ? `font-${name}` : catalog.families[name]!,
    });
  }

  return entries;
}

function formatTypographyValue(scale: TypographyCatalog["scales"][number]): string | undefined {
  const parts = [
    scale.fontSize != null ? `${scale.fontSize}px` : "",
    scale.lineHeight != null ? `/${scale.lineHeight}px` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("") : undefined;
}

interface TokenSource {
  path: string;
  content: string;
}

async function collectTokenSourcesFromDisk(
  input: BuildTokenConfigInput,
): Promise<TokenSource[]> {
  const paths = mergeTokenSourcePaths(input);

  const sources: TokenSource[] = [];

  for (const relPath of paths) {
    const content = await readFile(join(input.rootDir, relPath), "utf8").catch(() => null);
    if (content != null) {
      sources.push({ path: relPath, content });
    }
  }

  return sources;
}

async function collectTokenSourcesFromGit(
  input: BuildRemoteTokenConfigInput,
  readFileFromGit: (
    vcs: VcsConfig,
    auth: { token: string; atlassianEmail?: string },
    path: string,
    ref?: string,
  ) => Promise<string | null>,
  auth: { token: string; atlassianEmail?: string },
): Promise<TokenSource[]> {
  const paths = mergeTokenSourcePaths(input);

  const sources: TokenSource[] = [];

  for (const relPath of paths) {
    const content = await readFileFromGit(input.vcs, auth, relPath, input.vcs.baseBranch);
    if (content != null) {
      sources.push({ path: relPath, content });
    }
  }

  return sources;
}

/** Collect unique repo paths that may define design tokens (colors, spacing, typography, tailwind). */
export function mergeTokenSourcePaths(input: {
  tokenPaths?: string[];
  fontPaths?: string[];
  tailwindConfigPath?: string;
}): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const path of [
    ...(input.tokenPaths ?? []),
    ...(input.fontPaths ?? []),
    ...(input.tailwindConfigPath ? [input.tailwindConfigPath] : []),
  ]) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }

  return merged;
}

function parseTailwindTheme(content: string, styleSystem?: StyleSystem): TokenEntry[] {
  const entries: TokenEntry[] = [];
  const themeBlock = extractConfigBlock(content, "theme") ?? content;

  const colorsBlock = extractConfigBlock(themeBlock, "colors");
  if (colorsBlock) {
    entries.push(...parseTailwindColors(colorsBlock, styleSystem));
  }

  const spacingBlock = extractConfigBlock(themeBlock, "spacing");
  if (spacingBlock) {
    entries.push(...parseTailwindSpacing(spacingBlock, styleSystem));
  }

  const radiusBlock =
    extractConfigBlock(themeBlock, "borderRadius") ?? extractConfigBlock(themeBlock, "radius");
  if (radiusBlock) {
    entries.push(...parseTailwindRadius(radiusBlock, styleSystem));
  }

  const fontFamilyBlock = extractConfigBlock(themeBlock, "fontFamily");
  if (fontFamilyBlock) {
    entries.push(...parseTailwindFontFamilies(fontFamilyBlock, styleSystem));
  }

  const fontSizeBlock = extractConfigBlock(themeBlock, "fontSize");
  if (fontSizeBlock) {
    entries.push(...parseTailwindFontSizes(fontSizeBlock, styleSystem));
  }

  return entries;
}

function parseTailwindColors(block: string, styleSystem?: StyleSystem): TokenEntry[] {
  const entries: TokenEntry[] = [];
  parseNestedTokenValues(block, "", (name, rawValue) => {
    const hex = normalizeColorValue(rawValue);
    if (!hex) return;
    entries.push({
      category: "color",
      name,
      usage: tailwindColorUsage(name, styleSystem),
      value: hex,
    });
  });
  return entries;
}

function parseTailwindSpacing(block: string, styleSystem?: StyleSystem): TokenEntry[] {
  const entries: TokenEntry[] = [];

  for (const match of block.matchAll(/['"]?([\w.-]+)['"]?\s*:\s*['"]?([^'",\n]+)['"]?/g)) {
    const px = parseCssSize(match[2]!);
    if (px == null) continue;
    entries.push({
      category: "spacing",
      name: match[1]!,
      usage: styleSystem === "tailwind" ? match[1]! : `var(--spacing-${match[1]})`,
      value: String(px),
    });
  }

  return entries;
}

function parseTailwindRadius(block: string, styleSystem?: StyleSystem): TokenEntry[] {
  const entries: TokenEntry[] = [];

  for (const match of block.matchAll(/['"]?([\w.-]+)['"]?\s*:\s*['"]?([^'",\n]+)['"]?/g)) {
    const px = parseCssSize(match[2]!);
    if (px == null) continue;
    entries.push({
      category: "radius",
      name: match[1]!,
      usage: styleSystem === "tailwind" ? `rounded-${match[1]!}` : `var(--radius-${match[1]})`,
      value: String(px),
    });
  }

  return entries;
}

function parseTailwindFontFamilies(block: string, styleSystem?: StyleSystem): TokenEntry[] {
  const entries: TokenEntry[] = [];

  for (const match of block.matchAll(/['"]?([\w-]+)['"]?\s*:\s*\[([^\]]+)\]/g)) {
    const family = match[2]!.split(",")[0]?.replace(/['"]/g, "").trim();
    if (!family) continue;
    entries.push({
      category: "fontFamily",
      name: match[1]!,
      usage: styleSystem === "tailwind" ? `font-${match[1]!}` : family,
      value: family,
    });
  }

  return entries;
}

function parseTailwindFontSizes(block: string, styleSystem?: StyleSystem): TokenEntry[] {
  const entries: TokenEntry[] = [];

  for (const match of block.matchAll(/['"]?([\w-]+)['"]?\s*:\s*\[?\s*['"]?([^'",\]\s]+)/g)) {
    const fontSize = parseCssSize(match[2]!);
    if (fontSize == null) continue;
    entries.push({
      category: "typography",
      name: match[1]!,
      usage: styleSystem === "tailwind" ? `text-${match[1]!}` : match[1]!,
      value: `${fontSize}px`,
    });
  }

  return entries;
}

function parseCssTokenVariables(content: string, styleSystem?: StyleSystem): TokenEntry[] {
  const entries: TokenEntry[] = [];

  for (const match of content.matchAll(/--color-([\w-]+)\s*:\s*([^;]+);/gi)) {
    const hex = normalizeColorValue(match[2]!);
    const name = normalizeTokenName(match[1]!);
    entries.push({
      category: "color",
      name,
      usage: styleSystem === "tailwind" ? tailwindColorUsage(name, styleSystem) : `var(--color-${name})`,
      ...(hex ? { value: hex } : {}),
    });
  }

  for (const match of content.matchAll(/--spacing-([\w-]+)\s*:\s*([^;]+);/gi)) {
    const px = parseCssSize(match[2]!);
    if (px == null) continue;
    const name = normalizeTokenName(match[1]!);
    entries.push({
      category: "spacing",
      name,
      usage: styleSystem === "tailwind" ? name : `var(--spacing-${name})`,
      value: String(px),
    });
  }

  for (const match of content.matchAll(/--radius-([\w-]+)\s*:\s*([^;]+);/gi)) {
    const px = parseCssSize(match[2]!);
    if (px == null) continue;
    const name = normalizeTokenName(match[1]!);
    entries.push({
      category: "radius",
      name,
      usage: styleSystem === "tailwind" ? `rounded-${name}` : `var(--radius-${name})`,
      value: String(px),
    });
  }

  return entries;
}

function parseJsonTokens(content: string, styleSystem?: StyleSystem): TokenEntry[] {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return flattenJsonTokens(parsed, styleSystem);
  } catch {
    return [];
  }
}

function flattenJsonTokens(
  node: Record<string, unknown>,
  styleSystem: StyleSystem | undefined,
  prefix = "",
): TokenEntry[] {
  const entries: TokenEntry[] = [];

  for (const [key, value] of Object.entries(node)) {
    const name = prefix ? `${prefix}/${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if ("value" in record || "$value" in record) {
        const raw = String(record.value ?? record.$value ?? "");
        const hex = normalizeColorValue(raw);
        if (hex) {
          entries.push({
            category: "color",
            name,
            usage: tailwindColorUsage(name, styleSystem),
            value: hex,
          });
        }
        continue;
      }
      entries.push(...flattenJsonTokens(record, styleSystem, name));
      continue;
    }

    const hex = normalizeColorValue(String(value));
    if (hex) {
      entries.push({
        category: "color",
        name,
        usage: tailwindColorUsage(name, styleSystem),
        value: hex,
      });
    }
  }

  return entries;
}

function parseNestedTokenValues(
  block: string,
  prefix: string,
  visit: (name: string, rawValue: string) => void,
): void {
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    const nested = trimmed.match(/^['"]?([\w-]+)['"]?\s*:\s*\{$/);
    if (nested) {
      continue;
    }

    const leaf = trimmed.match(/^['"]?([\w-]+)['"]?\s*:\s*['"]?([^'",]+)['"]?,?$/);
    if (leaf) {
      const name = prefix ? `${prefix}/${leaf[1]!}` : leaf[1]!;
      visit(name, leaf[2]!);
    }
  }

  const nestedBlocks = [...block.matchAll(/['"]?([\w-]+)['"]?\s*:\s*\{([\s\S]*?)\n\s*\},?/g)];
  for (const match of nestedBlocks) {
    const nestedPrefix = prefix ? `${prefix}/${match[1]!}` : match[1]!;
    parseNestedTokenValues(match[2]!, nestedPrefix, visit);
  }
}

function tailwindColorUsage(name: string, styleSystem?: StyleSystem): string {
  if (styleSystem !== "tailwind") {
    return name.replace(/\//g, "-");
  }
  return name.replace(/\//g, "-");
}

function extractConfigBlock(content: string, key: string): string | undefined {
  const pattern = new RegExp(`(?:extend\\s*:\\s*\\{[\\s\\S]*?)?${key}\\s*:\\s*\\{`, "m");
  const match = pattern.exec(content);
  if (!match) return undefined;

  const start = content.indexOf("{", match.index);
  if (start < 0) return undefined;

  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    const char = content[i];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start + 1, i);
      }
    }
  }

  return undefined;
}

export function normalizeColorValue(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/['"]/g, "");
  if (!trimmed) return undefined;

  if (trimmed.startsWith("#")) {
    return normalizeHex(trimmed);
  }

  const rgbMatch = trimmed.match(/^rgba?\(\s*([\d.]+)[\s,/]+([\d.]+)[\s,/]+([\d.]+)/i);
  if (rgbMatch) {
    const r = Number.parseFloat(rgbMatch[1]!);
    const g = Number.parseFloat(rgbMatch[2]!);
    const b = Number.parseFloat(rgbMatch[3]!);
    return rgbToHex(r, g, b);
  }

  return undefined;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function normalizeHex(value: string): string {
  const hex = value.replace("#", "");
  if (hex.length === 3) {
    return `#${hex
      .split("")
      .map((char) => `${char}${char}`)
      .join("")}`.toLowerCase();
  }
  return `#${hex.toLowerCase()}`;
}

function parseCssSize(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith("px")) return Number.parseFloat(trimmed);
  if (trimmed.endsWith("rem")) return Number.parseFloat(trimmed) * 16;
  const numeric = Number.parseFloat(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeTokenName(name: string): string {
  return name.trim().replace(/\s+/g, "-").toLowerCase();
}

function dedupeTokenEntries(entries: TokenEntry[]): TokenEntry[] {
  const seen = new Set<string>();
  const result: TokenEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.category}|${entry.name}|${entry.usage}|${entry.value ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result;
}

function truncateSource(content: string, max = 6_000): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max - 20)}\n...[truncated]`;
}

const TAILWIND_COLOR_UTILITIES =
  "text|bg|border|from|to|via|ring|outline|decoration|fill|stroke|caret|accent";

const COLOR_MATCH_TOLERANCE = 2;

/** Build a Tailwind utility class from a prefix (text/bg/…) and catalog color suffix. */
export function tailwindColorClass(utilityPrefix: string, colorSuffix: string): string {
  return `${utilityPrefix}-${colorSuffix}`;
}

export function findColorEntryByHex(
  hex: string,
  catalog: TokenCatalog,
  tolerance = COLOR_MATCH_TOLERANCE,
): TokenEntry | undefined {
  const target = normalizeColorValue(hex);
  if (!target) return undefined;

  let best: TokenEntry | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const entry of catalog.entries) {
    if (entry.category !== "color" || !entry.value) continue;
    const distance = colorChannelDistance(target, entry.value);
    if (distance <= tolerance && distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }

  return best;
}

export function resolveTailwindColorClass(
  utilityPrefix: string,
  rawColor: string,
  catalog: TokenCatalog,
): string | undefined {
  const entry = findColorEntryByHex(rawColor, catalog);
  if (!entry) return undefined;
  return tailwindColorClass(utilityPrefix, entry.usage);
}

/** Replace Tailwind arbitrary colors (text-[rgb(...)]) with repo token classes. */
export function replaceArbitraryTailwindColors(
  source: string,
  catalog: TokenCatalog | undefined,
): string {
  if (!catalog || catalog.entries.every((entry) => entry.category !== "color")) {
    return source;
  }

  const pattern = new RegExp(`\\b(${TAILWIND_COLOR_UTILITIES})-\\[([^\\]]+)\\]`, "g");
  return source.replace(pattern, (match, utilityPrefix: string, rawColor: string) => {
    if (rawColor.startsWith("var(--")) {
      return match;
    }
    return resolveTailwindColorClass(utilityPrefix, rawColor, catalog) ?? match;
  });
}

const TAILWIND_VARIANT_PREFIX =
  "(?:hover|focus|focus-visible|focus-within|active|disabled|group-hover|peer-hover|peer-focus|data-\\[[^\\]]+\\]):";

/** Collect CSS custom property names declared or referenced in token CSS. */
export function collectCssVariableNamesFromCss(tokenCss: string): string[] {
  const names = new Set<string>();

  for (const match of tokenCss.matchAll(/--([\w-]+)\s*:/g)) {
    names.add(match[1]!);
  }

  for (const match of tokenCss.matchAll(/var\(--([\w-]+)\)/g)) {
    names.add(match[1]!);
  }

  return [...names];
}

/**
 * Convert Tailwind arbitrary CSS-var utilities (e.g. `hover:bg-[var(--k-color-foo)]`)
 * into semantic token classes (`hover:bg-k-color-foo`) when the variable exists in
 * team token CSS. Fig2Code preview extends Tailwind colors from those variables.
 */
export function replaceArbitraryCssVarClasses(
  source: string,
  tokenCss: string | undefined,
): string {
  if (!tokenCss?.trim()) {
    return source;
  }

  const varNames = new Set(collectCssVariableNamesFromCss(tokenCss));
  if (varNames.size === 0) {
    return source;
  }

  const pattern = new RegExp(
    `(${TAILWIND_VARIANT_PREFIX})?(${TAILWIND_COLOR_UTILITIES})-\\[var\\(--([\\w-]+)\\)\\]`,
    "g",
  );

  return source.replace(
    pattern,
    (match, variantPrefix: string | undefined, utilityPrefix: string, varName: string) => {
      if (!varNames.has(varName)) {
        return match;
      }
      return `${variantPrefix ?? ""}${utilityPrefix}-${varName}`;
    },
  );
}

function colorChannelDistance(hexA: string, hexB: string): number {
  const a = hexToRgbChannels(hexA);
  const b = hexToRgbChannels(hexB);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

function hexToRgbChannels(hex: string): { r: number; g: number; b: number } | undefined {
  const normalized = normalizeColorValue(hex);
  if (!normalized) return undefined;
  const value = normalized.replace("#", "");
  if (value.length !== 6) return undefined;
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}
