import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  StyleSystem,
  TypographyCatalog,
  TypographyConfig,
  TypographyScaleEntry,
  VcsConfig,
} from "@fig2code/spec";
import { createGitHostProvider } from "@fig2code/git-host";

export interface BuildTypographyConfigInput {
  rootDir: string;
  fontPaths: string[];
  tokenPaths?: string[];
  tailwindConfigPath?: string;
  styleSystem?: StyleSystem;
}

export async function buildTypographyConfig(
  input: BuildTypographyConfigInput,
): Promise<TypographyConfig> {
  const sources = await collectTypographySourcesFromDisk(input);
  const catalog = parseTypographyFromSources(sources, input.fontPaths, input.styleSystem);
  return {
    fontPaths: input.fontPaths,
    catalog,
  };
}

export interface BuildRemoteTypographyConfigInput {
  vcs: VcsConfig;
  token: string;
  atlassianEmail?: string;
  fontPaths: string[];
  tokenPaths?: string[];
  tailwindConfigPath?: string;
  styleSystem?: StyleSystem;
}

export async function buildTypographyConfigFromRemote(
  input: BuildRemoteTypographyConfigInput,
): Promise<TypographyConfig> {
  const git = createGitHostProvider(input.vcs.provider);
  const auth = {
    token: input.token,
    atlassianEmail: input.atlassianEmail,
  };
  const sources = await collectTypographySourcesFromGit(input, git.readFile.bind(git), auth);
  const catalog = parseTypographyFromSources(sources, input.fontPaths, input.styleSystem);

  return {
    fontPaths: input.fontPaths,
    catalog,
  };
}

export async function parseTypographyCatalog(
  input: BuildTypographyConfigInput,
): Promise<TypographyCatalog> {
  const sources = await collectTypographySourcesFromDisk(input);
  return parseTypographyFromSources(sources, input.fontPaths, input.styleSystem);
}

function parseTypographyFromSources(
  sources: TypographySource[],
  fontPaths: string[],
  styleSystem?: StyleSystem,
): TypographyCatalog {
  const families: Record<string, string> = {};
  const scales: TypographyScaleEntry[] = [];

  for (const source of sources) {
    if (source.path.endsWith(".json")) {
      mergeScales(scales, parseTypographyJson(source.content, source.path));
      continue;
    }

    if (source.path.includes("tailwind.config") || source.content.includes("fontSize:")) {
      mergeScales(scales, parseTailwindTypography(source.content, styleSystem));
      continue;
    }

    mergeFamilies(families, parseCssFontFamilies(source.content));
    mergeScales(scales, parseCssTypography(source.content, styleSystem));
  }

  return {
    fontPaths,
    families,
    scales: dedupeScales(scales),
  };
}

export function typographyToTokenResolver(
  catalog: TypographyCatalog,
  styleSystem?: StyleSystem,
): Record<string, string> {
  const resolver: Record<string, string> = {};

  for (const scale of catalog.scales) {
    resolver[`typography/${scale.name}`] = scale.usage;
  }

  for (const [name] of Object.entries(catalog.families)) {
    resolver[`typography/family/${name}`] =
      styleSystem === "tailwind" ? `font-${name}` : catalog.families[name]!;
  }

  return resolver;
}

interface TypographySource {
  path: string;
  content: string;
}

async function collectTypographySourcesFromDisk(
  input: BuildTypographyConfigInput,
): Promise<TypographySource[]> {
  const paths = new Set<string>([
    ...input.fontPaths,
    ...(input.tokenPaths ?? []),
    ...(input.tailwindConfigPath ? [input.tailwindConfigPath] : []),
  ]);

  const sources: TypographySource[] = [];

  for (const relPath of paths) {
    if (!relPath) continue;

    const absPath = join(input.rootDir, relPath);
    const content = await readFile(absPath, "utf8").catch(() => null);
    if (content != null) {
      sources.push({ path: relPath, content });
    }
  }

  return sources;
}

async function collectTypographySourcesFromGit(
  input: BuildRemoteTypographyConfigInput,
  readFileFromGit: (
    vcs: VcsConfig,
    auth: { token: string; atlassianEmail?: string },
    path: string,
    ref?: string,
  ) => Promise<string | null>,
  auth: { token: string; atlassianEmail?: string },
): Promise<TypographySource[]> {
  const paths = new Set<string>([
    ...input.fontPaths,
    ...(input.tokenPaths ?? []),
    ...(input.tailwindConfigPath ? [input.tailwindConfigPath] : []),
  ]);

  const sources: TypographySource[] = [];

  for (const relPath of paths) {
    if (!relPath) continue;
    const content = await readFileFromGit(input.vcs, auth, relPath, input.vcs.baseBranch);
    if (content != null) {
      sources.push({ path: relPath, content });
    }
  }

  return sources;
}

function parseCssFontFamilies(content: string): Record<string, string> {
  const families: Record<string, string> = {};

  for (const match of content.matchAll(
    /--font-family-([\w-]+)\s*:\s*([^;]+);/gi,
  )) {
    families[normalizeTokenName(match[1]!)] = cleanCssValue(match[2]!);
  }

  for (const match of content.matchAll(/@font-face\s*\{[^}]*font-family:\s*['"]?([^;'"]+)['"]?/gi)) {
    const family = match[1]!.trim();
    families[normalizeTokenName(family)] = family;
  }

  return families;
}

function parseCssTypography(content: string, styleSystem?: StyleSystem): TypographyScaleEntry[] {
  const scales: TypographyScaleEntry[] = [];

  for (const match of content.matchAll(
    /--font-size-([\w-]+)\s*:\s*([^;]+);/gi,
  )) {
    const name = normalizeTokenName(match[1]!);
    const fontSize = parseCssSize(match[2]!);
    if (fontSize == null) continue;
    scales.push({
      name,
      usage: cssUsage(name, "font-size", styleSystem),
      fontSize,
    });
  }

  for (const match of content.matchAll(
    /--font-weight-([\w-]+)\s*:\s*([^;]+);/gi,
  )) {
    const name = normalizeTokenName(match[1]!);
    const fontWeight = parseCssWeight(match[2]!);
    if (fontWeight == null) continue;
    scales.push({
      name,
      usage: cssUsage(name, "font-weight", styleSystem),
      fontWeight,
    });
  }

  for (const match of content.matchAll(
    /--line-height-([\w-]+)\s*:\s*([^;]+);/gi,
  )) {
    const name = normalizeTokenName(match[1]!);
    const lineHeight = parseCssSize(match[2]!);
    if (lineHeight == null) continue;
    scales.push({
      name,
      usage: cssUsage(name, "line-height", styleSystem),
      lineHeight,
    });
  }

  for (const match of content.matchAll(
    /--letter-spacing-([\w-]+)\s*:\s*([^;]+);/gi,
  )) {
    const name = normalizeTokenName(match[1]!);
    const letterSpacing = parseCssSize(match[2]!);
    if (letterSpacing == null) continue;
    scales.push({
      name,
      usage: cssUsage(name, "letter-spacing", styleSystem),
      letterSpacing,
    });
  }

  return scales;
}

function parseTailwindTypography(content: string, styleSystem?: StyleSystem): TypographyScaleEntry[] {
  const scales: TypographyScaleEntry[] = [];

  const fontSizeBlock = content.match(/fontSize\s*:\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (fontSizeBlock) {
    for (const match of fontSizeBlock.matchAll(/['"]?([\w-]+)['"]?\s*:\s*\[?\s*['"]?([^'",\]\s]+)/g)) {
      const name = match[1]!;
      const fontSize = parseCssSize(match[2]!);
      if (fontSize == null) continue;
      scales.push({
        name,
        usage: tailwindFontSizeUsage(name, styleSystem),
        fontSize,
      });
    }
  }

  const fontWeightBlock = content.match(/fontWeight\s*:\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (fontWeightBlock) {
    for (const match of fontWeightBlock.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]?(\d+)['"]?/g)) {
      scales.push({
        name: match[1]!,
        usage: tailwindFontWeightUsage(match[1]!, styleSystem),
        fontWeight: Number(match[2]),
      });
    }
  }

  const fontFamilyBlock = content.match(/fontFamily\s*:\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (fontFamilyBlock) {
    for (const match of fontFamilyBlock.matchAll(/['"]?([\w-]+)['"]?\s*:\s*\[([^\]]+)\]/g)) {
      const family = match[2]!
        .split(",")[0]
        ?.replace(/['"]/g, "")
        .trim();
      if (!family) continue;
      scales.push({
        name: match[1]!,
        usage: tailwindFontFamilyUsage(match[1]!, styleSystem),
        fontFamily: family,
      });
    }
  }

  return scales;
}

function parseTypographyJson(content: string, path: string): TypographyScaleEntry[] {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return flattenTypographyJson(parsed, path);
  } catch {
    return [];
  }
}

function flattenTypographyJson(
  node: Record<string, unknown>,
  prefix = "",
): TypographyScaleEntry[] {
  const scales: TypographyScaleEntry[] = [];

  for (const [key, value] of Object.entries(node)) {
    const name = prefix ? `${prefix}/${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if ("value" in record || "fontSize" in record || "$value" in record) {
        scales.push(entryFromJsonToken(name, record));
      } else {
        scales.push(...flattenTypographyJson(record, name));
      }
    }
  }

  return scales.filter(Boolean);
}

function entryFromJsonToken(name: string, record: Record<string, unknown>): TypographyScaleEntry {
  const rawValue = String(record.value ?? record.$value ?? record.fontSize ?? "");
  const fontSize = parseCssSize(rawValue);
  const fontWeight = parseCssWeight(String(record.fontWeight ?? record.weight ?? ""));
  const lineHeight = parseCssSize(String(record.lineHeight ?? ""));
  const letterSpacing = parseCssSize(String(record.letterSpacing ?? ""));

  return {
    name: normalizeTokenName(name),
    usage: `var(--${normalizeTokenName(name).replace(/\//g, "-")})`,
    fontSize: fontSize ?? undefined,
    fontWeight: fontWeight ?? undefined,
    lineHeight: lineHeight ?? undefined,
    letterSpacing: letterSpacing ?? undefined,
    fontFamily:
      typeof record.fontFamily === "string"
        ? record.fontFamily
        : typeof record.font === "string"
          ? record.font
          : undefined,
  };
}

function cssUsage(name: string, kind: string, styleSystem?: StyleSystem): string {
  if (styleSystem === "tailwind") {
    if (kind === "font-size") return `text-${name}`;
    if (kind === "font-weight") return `font-${name}`;
    if (kind === "line-height") return `leading-${name}`;
    if (kind === "letter-spacing") return `tracking-${name}`;
  }
  return `var(--${kind}-${name})`;
}

function tailwindFontSizeUsage(name: string, styleSystem?: StyleSystem): string {
  return styleSystem === "tailwind" ? `text-${name}` : name;
}

function tailwindFontWeightUsage(name: string, styleSystem?: StyleSystem): string {
  return styleSystem === "tailwind" ? `font-${name}` : name;
}

function tailwindFontFamilyUsage(name: string, styleSystem?: StyleSystem): string {
  return styleSystem === "tailwind" ? `font-${name}` : name;
}

function parseCssSize(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith("px")) return Number.parseFloat(trimmed);
  if (trimmed.endsWith("rem")) return Number.parseFloat(trimmed) * 16;
  const numeric = Number.parseFloat(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseCssWeight(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const numeric = Number.parseInt(trimmed, 10);
  return Number.isFinite(numeric) ? numeric : null;
}

function cleanCssValue(raw: string): string {
  return raw.trim().replace(/['"]/g, "");
}

function normalizeTokenName(name: string): string {
  return name.trim().replace(/\s+/g, "-").toLowerCase();
}

function mergeFamilies(target: Record<string, string>, source: Record<string, string>): void {
  Object.assign(target, source);
}

function mergeScales(target: TypographyScaleEntry[], source: TypographyScaleEntry[]): void {
  target.push(...source);
}

function dedupeScales(scales: TypographyScaleEntry[]): TypographyScaleEntry[] {
  const seen = new Set<string>();
  const result: TypographyScaleEntry[] = [];

  for (const scale of scales) {
    const key = [
      scale.name,
      scale.fontSize ?? "",
      scale.fontWeight ?? "",
      scale.lineHeight ?? "",
      scale.letterSpacing ?? "",
      scale.fontFamily ?? "",
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(scale);
  }

  return result;
}
