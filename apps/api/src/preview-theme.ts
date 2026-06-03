import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ThemeCatalog, ThemeSelection } from "@fig2code/spec";
import {
  buildThemeHtmlAttributes,
  discoverThemeCatalog,
  resolveThemeCatalogEntry,
} from "@fig2code/repo";

export interface PreviewThemeBundle {
  css: string;
  tailwindConfigJson: string;
  htmlAttrs: Record<string, string>;
  selection: ThemeSelection;
}

function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function setNested(
  target: Record<string, unknown>,
  parts: string[],
  value: string,
): void {
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!node[key] || typeof node[key] !== "object") {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

function buildColorTree(paths: string[]): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const tokenPath of paths) {
    const parts = tokenPath.split(".");
    const varSuffix = tokenPath.replace(/\./g, "-");
    setNested(tree, parts, `var(--k-color-${varSuffix})`);
  }
  return tree;
}

function buildTailwindConfigFromColorPaths(paths: string[]): string {
  const spacingKeys = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52,
    56, 60, 64, 72, 80, 96,
  ];
  const spacing = Object.fromEntries(
    spacingKeys.map((key) => [key, `var(--k-spacing-${key})`]),
  );
  Object.assign(spacing, {
    "0.5": "var(--k-spacing-05)",
    "1.5": "var(--k-spacing-15)",
    "2.5": "var(--k-spacing-25)",
    "3.5": "var(--k-spacing-35)",
  });

  const borderRadius: Record<string, string> = {
    none: "var(--k-radius-none)",
    sm: "var(--k-radius-sm)",
    DEFAULT: "var(--k-radius-default)",
    md: "var(--k-radius-md)",
    lg: "var(--k-radius-lg)",
    xl: "var(--k-radius-xl)",
    "2xl": "var(--k-radius-2xl)",
    "3xl": "var(--k-radius-3xl)",
    full: "var(--k-radius-full)",
  };

  return JSON.stringify({
    theme: {
      extend: {
        colors: {
          color: buildColorTree(paths),
        },
        spacing,
        borderRadius,
        fontFamily: {
          body: ["var(--k-typography-family-body)", "system-ui", "sans-serif"],
          heading: ["var(--k-typography-family-heading)", "serif"],
          sans: ["var(--k-typography-family-body)", "system-ui", "sans-serif"],
          mono: ["var(--k-typography-family-mono)", "monospace"],
        },
      },
    },
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findPackageRoot(
  repoClonePath: string,
  componentRepoPath: string,
): Promise<string | null> {
  let dir = path.dirname(path.join(repoClonePath, componentRepoPath));
  while (dir.startsWith(repoClonePath)) {
    if (await fileExists(path.join(dir, "package.json"))) {
      return dir;
    }
    if (dir === repoClonePath) break;
    dir = path.dirname(dir);
  }
  return null;
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function resolveCatalog(
  repoClonePath: string,
  tokenPaths: string[] | undefined,
  themeCatalog?: ThemeCatalog | null,
): Promise<ThemeCatalog | null> {
  if (themeCatalog?.entries.length) {
    return themeCatalog;
  }
  return discoverThemeCatalog(repoClonePath, tokenPaths ?? []);
}

export function isDarkPreviewMode(mode: string | undefined): boolean {
  return Boolean(mode && /dark|night|dim/i.test(mode));
}

/**
 * Load design-token CSS and Tailwind CDN config for preview using the selected brand/mode.
 */
export async function resolvePreviewTheme(
  repoClonePath: string,
  componentRepoPath: string,
  options: {
    tokenPaths?: string[];
    themeCatalog?: ThemeCatalog | null;
    selection?: Partial<ThemeSelection>;
  } = {},
): Promise<PreviewThemeBundle | null> {
  const catalog = await resolveCatalog(
    repoClonePath,
    options.tokenPaths,
    options.themeCatalog,
  );
  if (!catalog?.tokensDir) {
    return null;
  }

  const entry = resolveThemeCatalogEntry(catalog, options.selection);
  if (!entry) {
    return null;
  }

  const tokensDir = path.join(repoClonePath, catalog.tokensDir);
  const themeCssPath = path.join(tokensDir, entry.cssFile);
  if (!(await fileExists(themeCssPath))) {
    return null;
  }

  const packageRoot = await findPackageRoot(repoClonePath, componentRepoPath);
  const cssParts = [
    await readOptional(path.join(tokensDir, "primitives.css")),
    await readOptional(themeCssPath),
    packageRoot ? await readOptional(path.join(packageRoot, "fonts.css")) : "",
  ].filter(Boolean);

  if (cssParts.length === 0) {
    return null;
  }

  const colorPathsFile = packageRoot
    ? path.join(packageRoot, "src/preset/color-token-paths.generated.json")
    : null;
  let colorPaths: string[] = [];
  if (colorPathsFile) {
    try {
      const raw = await readFile(colorPathsFile, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        colorPaths = parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // fall back to CSS-only injection
    }
  }

  const tailwindConfigJson =
    colorPaths.length > 0 ? buildTailwindConfigFromColorPaths(colorPaths) : "{}";

  console.log(
    `[fig2code] preview theme:`,
    `${entry.brand}/${entry.mode}`,
    toPosixRelative(repoClonePath, tokensDir),
    `${colorPaths.length} color paths`,
  );

  return {
    css: cssParts.join("\n\n"),
    tailwindConfigJson,
    htmlAttrs: buildThemeHtmlAttributes(catalog, entry),
    selection: { brand: entry.brand, mode: entry.mode },
  };
}

export async function listAvailableThemeCssFiles(tokensDir: string): Promise<string[]> {
  try {
    const files = await readdir(tokensDir);
    return files.filter((name) => /^theme-.+\.css$/i.test(name)).sort();
  } catch {
    return [];
  }
}
