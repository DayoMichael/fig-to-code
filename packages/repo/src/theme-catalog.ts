import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ThemeCatalog, ThemeCatalogEntry, ThemeSelection } from "@fig2code/spec";

const THEME_FILE_RE = /^theme-.+\.css$/i;

export function slugThemeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseThemeSelectorAttributes(content: string): {
  attributes: string[];
  values: Record<string, string>;
} {
  const selectorMatch = content.match(/^\s*((?:\[[^\]]+\])+)\s*\{/m);
  if (!selectorMatch?.[1]) {
    return { attributes: [], values: {} };
  }

  const attributes: string[] = [];
  const values: Record<string, string> = {};
  const attrRe = /\[([a-zA-Z0-9_-]+)=["']([^"']+)["']\]/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(selectorMatch[1]))) {
    const key = match[1]!;
    attributes.push(key);
    values[key] = match[2]!;
  }
  return { attributes, values };
}

export function parseThemeFileName(fileName: string): { brand: string; mode: string } | null {
  const match = fileName.match(/^theme-(.+)-([^.]+)\.css$/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    brand: slugThemeToken(match[1]),
    mode: slugThemeToken(match[2]),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveTokensDir(
  rootDir: string,
  tokenPaths: string[],
): Promise<string | null> {
  for (const tokenPath of tokenPaths) {
    const candidate = join(rootDir, tokenPath);
    if (await fileExists(join(candidate, "primitives.css"))) {
      return candidate;
    }
    if ((await fileExists(candidate)) && candidate.endsWith(".css")) {
      return join(candidate, "..");
    }
  }

  return null;
}

export async function discoverThemeCatalog(
  rootDir: string,
  tokenPaths: string[],
): Promise<ThemeCatalog | null> {
  const tokensDir = await resolveTokensDir(rootDir, tokenPaths);
  if (!tokensDir) {
    return null;
  }

  let files: string[] = [];
  try {
    files = await readdir(tokensDir);
  } catch {
    return null;
  }

  const themeFiles = files.filter((name) => THEME_FILE_RE.test(name));
  if (themeFiles.length === 0) {
    return null;
  }

  const attributeSet = new Set<string>();
  const entries: ThemeCatalogEntry[] = [];

  for (const cssFile of themeFiles.sort()) {
    const content = await readFile(join(tokensDir, cssFile), "utf8");
    const parsedSelector = parseThemeSelectorAttributes(content);
    for (const attribute of parsedSelector.attributes) {
      attributeSet.add(attribute);
    }

    const fromName = parseThemeFileName(cssFile);
    const brand =
      parsedSelector.values.brand ??
      parsedSelector.values["data-brand"] ??
      fromName?.brand ??
      "default";
    const mode =
      parsedSelector.values.theme ??
      parsedSelector.values.mode ??
      parsedSelector.values["data-theme"] ??
      fromName?.mode ??
      "default";

    entries.push({
      brand: slugThemeToken(brand),
      mode: slugThemeToken(mode),
      cssFile,
    });
  }

  if (entries.length === 0) {
    return null;
  }

  const attributes =
    attributeSet.size > 0
      ? [...attributeSet]
      : inferDefaultAttributes(entries);

  const tokensDirRelative = relative(rootDir, tokensDir).split("\\").join("/");
  const defaultSelection = pickDefaultThemeSelection(entries);

  return {
    tokensDir: tokensDirRelative,
    attributes,
    entries,
    default: defaultSelection,
  };
}

function inferDefaultAttributes(entries: ThemeCatalogEntry[]): string[] {
  const brands = new Set(entries.map((entry) => entry.brand));
  if (brands.size > 1) {
    return ["data-brand", "data-theme"];
  }
  return ["data-theme"];
}

function pickDefaultThemeSelection(entries: ThemeCatalogEntry[]): ThemeSelection | undefined {
  const preferred =
    entries.find((entry) => entry.mode === "light") ??
    entries.find((entry) => entry.mode.includes("light")) ??
    entries[0];
  if (!preferred) {
    return undefined;
  }
  return { brand: preferred.brand, mode: preferred.mode };
}

export function resolveThemeCatalogEntry(
  catalog: ThemeCatalog | null | undefined,
  selection?: Partial<ThemeSelection>,
): ThemeCatalogEntry | null {
  if (!catalog?.entries.length) {
    return null;
  }

  const brand = selection?.brand ? slugThemeToken(selection.brand) : undefined;
  const mode = selection?.mode ? slugThemeToken(selection.mode) : undefined;

  if (brand && mode) {
    const exact = catalog.entries.find(
      (entry) => entry.brand === brand && entry.mode === mode,
    );
    if (exact) {
      return exact;
    }
  }

  if (brand) {
    const byBrand = catalog.entries.find((entry) => entry.brand === brand);
    if (byBrand) {
      return byBrand;
    }
  }

  if (mode) {
    const byMode = catalog.entries.find((entry) => entry.mode === mode);
    if (byMode) {
      return byMode;
    }
  }

  if (catalog.default) {
    return (
      catalog.entries.find(
        (entry) =>
          entry.brand === catalog.default!.brand && entry.mode === catalog.default!.mode,
      ) ?? null
    );
  }

  return catalog.entries[0] ?? null;
}

export function buildThemeHtmlAttributes(
  catalog: ThemeCatalog | null | undefined,
  entry: ThemeCatalogEntry | null,
): Record<string, string> {
  if (!entry) {
    return {};
  }

  const attrs: Record<string, string> = {};
  const attributes = catalog?.attributes.length
    ? catalog.attributes
    : inferDefaultAttributes(catalog?.entries ?? [entry]);

  for (const attribute of attributes) {
    if (attribute === "data-brand" || attribute === "brand") {
      attrs[attribute] = entry.brand;
      continue;
    }
    if (attribute === "data-theme" || attribute === "theme" || attribute === "data-mode") {
      attrs[attribute] = entry.mode;
    }
  }

  if (Object.keys(attrs).length === 0) {
    attrs["data-brand"] = entry.brand;
    attrs["data-theme"] = entry.mode;
  }

  return attrs;
}

export function listThemeBrands(catalog: ThemeCatalog): string[] {
  return [...new Set(catalog.entries.map((entry) => entry.brand))].sort();
}

export function listThemeModes(catalog: ThemeCatalog, brand?: string): string[] {
  const slugBrand = brand ? slugThemeToken(brand) : undefined;
  const entries = slugBrand
    ? catalog.entries.filter((entry) => entry.brand === slugBrand)
    : catalog.entries;
  return [...new Set(entries.map((entry) => entry.mode))].sort();
}
