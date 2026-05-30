import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  DetectedProjectConfig,
  ExistingComponentSummary,
  ExistingTokensSummary,
  ExportStyle,
  FileNaming,
  Platform,
  PropsPattern,
  StyleSystem,
  SyncConfig,
} from "@fig2code/spec";
import {
  buildRepoIndex,
  indexChildDirectoryNames,
  indexFindCssFiles,
  indexFindDirsNamed,
  indexFindFilesNamed,
  indexHasFileSuffix,
  indexIsDirectory,
  indexListFiles,
  indexPathExists,
  type RepoIndex,
} from "./repo-index.js";

export interface ScanOptions {
  rootDir: string;
}

export { buildRepoIndex } from "./repo-index.js";
export type { RepoIndex } from "./repo-index.js";

const TAILWIND_CONFIG_NAMES = [
  "tailwind.config.ts",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.cjs",
];

const PRETTIER_CONFIG_NAMES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
];

const STATIC_COMPONENT_CANDIDATES = [
  "src/components",
  "components",
  "src/ui",
  "packages/ui/src/components",
  "packages/ui/src",
  "packages/ui/src/components/ui",
  "packages/design-system/src/components",
  "libs/ui/src/components",
];

const COMPONENT_SUBDIRS = ["ui", "primitives", "core", "base", "shared"];

const UTILITY_FOLDER_NAMES = new Set([
  "data",
  "hooks",
  "runtime",
  "utils",
  "lib",
  "types",
  "constants",
  "helpers",
  "internal",
  "shared",
  "common",
  "test-utils",
  "testing",
  "__tests__",
  "styles",
  "style",
  "theme",
  "themes",
  "motion",
  "animation",
  "assets",
  "preset",
  "presets",
  "icons",
  "logo",
]);

const EXCLUDED_COMPONENT_FILES = new Set([
  "index.tsx",
  "index.ts",
  "types.tsx",
  "types.ts",
  "utils.tsx",
  "utils.ts",
  "context.tsx",
  "context.ts",
  "provider.tsx",
  "provider.ts",
]);

export async function detectProjectConfig(options: ScanOptions): Promise<DetectedProjectConfig> {
  const { rootDir } = options;

  const index = await buildRepoIndex(rootDir);

  const [workspaceDeps, tailwindConfigPath] = await Promise.all([
    collectWorkspaceDepsFromIndex(index),
    Promise.resolve(findTailwindConfigFromIndex(index)),
  ]);

  const platforms = detectPlatforms(workspaceDeps);
  const styleSystem = await detectStyleSystemFromIndex(index, workspaceDeps, tailwindConfigPath);
  const testFramework = detectTestFrameworkFromIndex(index, workspaceDeps);
  const storyFormat = detectStoryFormatFromIndex(index);
  const formatter = detectFormatterFromIndex(index, workspaceDeps);
  const componentPaths = findComponentPathsFromIndex(index);
  const tokenPaths = findTokenPathsFromIndex(index);
  const iconPaths = findIconPathsFromIndex(index);
  const fontPaths = findFontPathsFromIndex(index);

  const [existingComponents, fileNaming] = await Promise.all([
    Promise.resolve(listExistingComponentsFromIndex(index, componentPaths, testFramework)),
    Promise.resolve(detectFileNamingFromIndex(index, componentPaths)),
  ]);

  const [existingTokens, exportStyle, propsPattern] = await Promise.all([
    Promise.resolve(detectExistingTokensFromIndex(index, tokenPaths, styleSystem)),
    detectExportStyle(rootDir, existingComponents),
    detectPropsPattern(rootDir, existingComponents),
  ]);

  return {
    styleSystem,
    tailwindConfigPath: styleSystem === "tailwind" ? tailwindConfigPath : undefined,
    componentPaths,
    tokenPaths,
    iconPaths,
    fontPaths,
    exportStyle,
    propsPattern,
    fileNaming,
    testFramework,
    storyFormat,
    formatter,
    hasCodeConnect: existingComponents.some((c) => c.hasCodeConnect),
    platforms,
    existingComponents,
    existingTokens,
  };
}

export function detectedConfigToSyncConfig(
  detected: DetectedProjectConfig,
  vcs: SyncConfig["vcs"],
): SyncConfig {
  const primaryComponentPath = detected.componentPaths[0] ?? "src/components";
  const tokenPaths =
    detected.tokenPaths.length > 0
      ? detected.tokenPaths
      : detected.tailwindConfigPath
        ? [detected.tailwindConfigPath]
        : ["src/tokens"];
  const primaryIconPath = detected.iconPaths[0] ?? "src/icons";
  const example =
    detected.existingComponents[0]?.path ??
    join(primaryComponentPath, "Button", "Button.tsx");

  const config: SyncConfig = {
    vcs,
    platforms: detected.platforms.length > 0 ? detected.platforms : ["web"],
    conventions: {
      exportStyle: detected.exportStyle,
      propsPattern: detected.propsPattern,
      fileNaming: detected.fileNaming,
      testFramework: detected.testFramework,
      storyFormat: detected.storyFormat,
      formatter: detected.formatter === "prettier" ? "prettier" : "auto",
    },
    llm: {
      modelId: "anthropic/claude-sonnet",
      promptProfile: "component-v1",
      compaction: { mode: "off" },
    },
  };

  if (config.platforms.includes("web")) {
    config.web = {
      styleSystem: detected.styleSystem,
      componentPath: primaryComponentPath,
      tokenPaths,
      iconPath: primaryIconPath,
      exampleComponent: example,
    };
  }

  if (config.platforms.includes("native")) {
    config.native = {
      componentPath: "src/native/components",
      tokenPaths: ["src/native/tokens"],
      iconPath: "src/native/icons",
      exampleComponent: "src/native/components/Button/Button.tsx",
    };
  }

  return config;
}

async function collectWorkspaceDepsFromIndex(index: RepoIndex): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  const pkgPaths = indexFindFilesNamed(index, "package.json");

  const packages = await Promise.all(
    pkgPaths.map((relPath) => readJsonSafe<Record<string, unknown>>(join(index.rootDir, relPath))),
  );

  for (const pkg of packages) {
    Object.assign(
      merged,
      pkg?.dependencies as Record<string, string> | undefined,
      pkg?.devDependencies as Record<string, string> | undefined,
      pkg?.peerDependencies as Record<string, string> | undefined,
    );
  }

  return merged;
}

async function detectStyleSystemFromIndex(
  index: RepoIndex,
  deps: Record<string, string>,
  tailwindConfigPath: string | undefined,
): Promise<StyleSystem> {
  if (tailwindConfigPath) return "tailwind";
  if (deps.tailwindcss || deps["@tailwindcss/postcss"]) return "tailwind";
  if (indexHasFileSuffix(index, ".module.css")) return "css-modules";
  if (deps["styled-components"]) return "styled-components";
  if (deps["@emotion/styled"] || deps["@emotion/react"]) return "styled-components";
  if (await hasTailwindAtRulesFromIndex(index)) return "tailwind";
  if (indexHasFileSuffix(index, ".css")) return "vanilla-css";
  return "unknown";
}

function detectPlatforms(deps: Record<string, string>): Platform[] {
  const platforms: Platform[] = ["web"];
  if (deps["react-native"] || deps.expo) {
    platforms.push("native");
  }
  return platforms;
}

function detectTestFrameworkFromIndex(
  index: RepoIndex,
  deps: Record<string, string>,
): DetectedProjectConfig["testFramework"] {
  const fromDeps = detectTestFrameworkFromDeps(deps);
  if (fromDeps !== "none") return fromDeps;
  if (hasTestFilesFromIndex(index)) return "jest";
  return "none";
}

function detectTestFrameworkFromDeps(
  deps: Record<string, string>,
): DetectedProjectConfig["testFramework"] {
  if (deps.vitest) return "vitest";
  if (deps.jest) return "jest";
  if (deps["@playwright/test"] || deps.playwright) return "jest";
  return "none";
}

function hasTestFilesFromIndex(index: RepoIndex): boolean {
  for (const suffix of [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"]) {
    if (indexHasFileSuffix(index, suffix)) return true;
  }
  return false;
}

function detectStoryFormatFromIndex(index: RepoIndex): DetectedProjectConfig["storyFormat"] {
  const hasStories =
    indexHasFileSuffix(index, ".stories.tsx") ||
    indexHasFileSuffix(index, ".stories.ts") ||
    indexHasFileSuffix(index, ".stories.jsx");
  if (!hasStories) return "none";
  return "csf3";
}

export function detectFormatterFromIndex(
  index: RepoIndex,
  deps: Record<string, string>,
): DetectedProjectConfig["formatter"] {
  if (indexFindFilesNamed(index, PRETTIER_CONFIG_NAMES).length > 0) {
    return "prettier";
  }
  if (deps.prettier) {
    return "prettier";
  }
  return "none";
}

function findComponentPathsFromIndex(index: RepoIndex): string[] {
  const scored = new Map<string, number>();

  for (const candidate of STATIC_COMPONENT_CANDIDATES) {
    if (indexIsDirectory(index, candidate)) {
      scored.set(candidate, scoreComponentPathFromIndex(index, candidate));
    }
  }

  for (const relPath of indexFindDirsNamed(index, "components")) {
    scored.set(relPath, scoreComponentPathFromIndex(index, relPath));
  }

  const ranked = [...scored.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  if (ranked.length > 0) {
    return preferDeepestComponentPaths(ranked);
  }

  return ["src/components"];
}

function scoreComponentPathFromIndex(index: RepoIndex, relPath: string): number {
  if (!indexIsDirectory(index, relPath)) return 0;

  const flatCount = listFlatComponentFilesFromIndex(index, relPath).length;
  const folderCount = listFolderComponentEntriesFromIndex(index, relPath).length;
  return flatCount * 3 + folderCount * 4;
}

function preferDeepestComponentPaths(ranked: Array<[string, number]>): string[] {
  const kept: string[] = [];

  for (const [path, score] of ranked) {
    const childIndex = kept.findIndex((existing) => existing.startsWith(`${path}/`));
    if (childIndex >= 0) {
      const childScore = ranked.find(([candidate]) => candidate === kept[childIndex])?.[1] ?? 0;
      if (score > childScore) {
        kept.splice(childIndex, 1);
        kept.push(path);
      }
      continue;
    }

    const parentIndex = kept.findIndex((existing) => path.startsWith(`${existing}/`));
    if (parentIndex >= 0) {
      const parentScore = ranked.find(([candidate]) => candidate === kept[parentIndex])?.[1] ?? 0;
      if (score >= parentScore) {
        kept.splice(parentIndex, 1);
        kept.push(path);
      }
      continue;
    }

    kept.push(path);
  }

  return kept;
}

function findTokenPathsFromIndex(index: RepoIndex): string[] {
  const found: string[] = [];

  const candidates = [
    "src/tokens",
    "styles/variables.css",
    "src/styles/tokens.css",
    "tokens.json",
    "packages/ui/src/tokens",
    "packages/ui/tokens",
    "packages/ui/src/styles",
    "packages/tokens",
    "packages/tokens/build/web",
    "packages/tokens/style-dictionary",
  ];

  for (const candidate of candidates) {
    if (indexPathExists(index, candidate)) {
      found.push(candidate);
    }
  }

  for (const relPath of indexFindDirsNamed(index, "tokens")) {
    if (!found.includes(relPath)) {
      found.push(relPath);
    }
  }

  for (const relPath of indexFindFilesNamed(index, "primitives.css")) {
    const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ".";
    if (!found.includes(dir)) {
      found.push(dir);
    }
  }

  if (indexPathExists(index, "packages/tokens/style-dictionary/config.ts")) {
    if (!found.includes("packages/tokens")) {
      found.push("packages/tokens");
    }
  }

  return dedupePaths(found);
}

function findIconPathsFromIndex(index: RepoIndex): string[] {
  const candidates = [
    "src/icons",
    "assets/icons",
    "src/assets/icons",
    "packages/ui/src/icons",
    "packages/ui/icons",
    "packages/ui/src/components/icons",
  ];
  const found: string[] = [];

  for (const candidate of candidates) {
    if (isIconDirectoryFromIndex(index, candidate)) {
      found.push(candidate);
    }
  }

  for (const relPath of indexFindDirsNamed(index, "icons")) {
    if (isIconDirectoryFromIndex(index, relPath) && !found.includes(relPath)) {
      found.push(relPath);
    }
  }

  return dedupePaths(found);
}

function findFontPathsFromIndex(index: RepoIndex): string[] {
  const candidates = [
    "src/fonts",
    "assets/fonts",
    "public/fonts",
    "src/assets/fonts",
    "packages/ui/src/fonts",
    "packages/ui/fonts.css",
    "packages/ui/src/styles/fonts",
    "src/tokens/typography",
    "tokens/typography.json",
    "src/styles/typography.css",
  ];
  const found: string[] = [];

  for (const candidate of candidates) {
    if (indexPathExists(index, candidate)) {
      found.push(candidate);
    }
  }

  for (const relPath of indexFindFilesNamed(index, "fonts.css")) {
    if (!found.includes(relPath)) {
      found.push(relPath);
    }
  }

  return dedupePaths(found);
}

function findTailwindConfigFromIndex(index: RepoIndex): string | undefined {
  const ranked = dedupePaths(indexFindFilesNamed(index, TAILWIND_CONFIG_NAMES))
    .map((path) => ({ path, score: scoreTailwindConfigPath(path) }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.path;
}

function scoreTailwindConfigPath(path: string): number {
  if (path.includes("packages/ui/")) return 100;
  if (path.startsWith("packages/")) return 80;
  if (path.startsWith("apps/storybook/")) return 20;
  if (path.startsWith("apps/")) return 40;
  return 60;
}

function listExistingComponentsFromIndex(
  index: RepoIndex,
  componentPaths: string[],
  testFramework: DetectedProjectConfig["testFramework"],
): ExistingComponentSummary[] {
  const results: ExistingComponentSummary[] = [];
  const seen = new Set<string>();

  for (const componentPath of componentPaths) {
    collectComponentsFromPath(index, componentPath, results, seen);
  }

  if (testFramework === "none") {
    return results.map((r) => ({ ...r, hasTests: false }));
  }

  return results;
}

function collectComponentsFromPath(
  index: RepoIndex,
  componentPath: string,
  results: ExistingComponentSummary[],
  seen: Set<string>,
): void {
  if (!indexIsDirectory(index, componentPath)) return;

  collectFlatComponents(index, componentPath, results, seen);
  collectFolderComponents(index, componentPath, results, seen);

  for (const subdir of COMPONENT_SUBDIRS) {
    const subRel = join(componentPath, subdir);
    if (!indexIsDirectory(index, subRel)) continue;
    collectFlatComponents(index, subRel, results, seen);
    collectFolderComponents(index, subRel, results, seen);
  }
}

function collectFlatComponents(
  index: RepoIndex,
  relPath: string,
  results: ExistingComponentSummary[],
  seen: Set<string>,
): void {
  const files = listFlatComponentFilesFromIndex(index, relPath);
  if (files.length === 0) return;

  const allFiles = indexListFiles(index, relPath);

  for (const file of files) {
    const componentRel = join(relPath, file);
    if (seen.has(componentRel)) continue;
    seen.add(componentRel);

    const baseName = file.replace(/\.tsx$/, "");
    results.push({
      name: baseName,
      path: componentRel,
      hasTests: componentHasTestsFromIndex(index, relPath, baseName, allFiles),
      hasStories: allFiles.some((f) => f.includes(".stories.")),
      hasCodeConnect: allFiles.some((f) => f.includes(".figma.")),
    });
  }
}

function collectFolderComponents(
  index: RepoIndex,
  relPath: string,
  results: ExistingComponentSummary[],
  seen: Set<string>,
): void {
  for (const entryName of listFolderComponentEntriesFromIndex(index, relPath)) {
    if (!isComponentFolder(entryName)) continue;

    const dir = join(relPath, entryName);
    const files = indexListFiles(index, dir);
    const tsx = files.find(
      (f) => f.endsWith(".tsx") && !f.includes(".test.") && !f.includes(".stories."),
    );
    if (!tsx) continue;

    const componentRel = join(dir, tsx);
    if (seen.has(componentRel)) continue;
    seen.add(componentRel);

    results.push({
      name: entryName,
      path: componentRel,
      hasTests: files.some((f) => f.includes(".test.") || f.includes(".spec.")),
      hasStories: files.some((f) => f.includes(".stories.")),
      hasCodeConnect: files.some((f) => f.includes(".figma.")),
    });
  }
}

function componentHasTestsFromIndex(
  index: RepoIndex,
  relPath: string,
  baseName: string,
  siblingFiles: string[],
): boolean {
  if (
    siblingFiles.some(
      (f) =>
        f === `${baseName}.test.tsx` ||
        f === `${baseName}.spec.tsx` ||
        f === `${baseName}.test.ts` ||
        f === `${baseName}.spec.ts`,
    )
  ) {
    return true;
  }

  const testDir = join(relPath, "__tests__");
  if (!indexIsDirectory(index, testDir)) return false;

  const testFiles = indexListFiles(index, testDir);
  return testFiles.some(
    (f) =>
      f.startsWith(`${baseName}.`) &&
      (f.includes(".test.") || f.includes(".spec.")),
  );
}

function isComponentFolder(name: string): boolean {
  if (UTILITY_FOLDER_NAMES.has(name.toLowerCase())) return false;
  return classifyName(name) !== null;
}

export function classifyName(name: string): FileNaming | null {
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return "PascalCase";
  if (/^[a-z][a-z0-9]+(-[a-z0-9]+)+$/.test(name)) return "kebab-case";
  if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return "camelCase";
  return null;
}

function classifyComponentFileName(name: string): FileNaming | null {
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return "PascalCase";
  if (name.includes("-") && /^[a-z][a-z0-9-]+$/.test(name)) return "kebab-case";
  if (/^[a-z][a-z0-9]+$/.test(name)) return "kebab-case";
  if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return "camelCase";
  return null;
}

export async function detectFileNaming(
  rootDir: string,
  componentPaths: string[],
): Promise<FileNaming> {
  const index = await buildRepoIndex(rootDir);
  return detectFileNamingFromIndex(index, componentPaths);
}

function detectFileNamingFromIndex(index: RepoIndex, componentPaths: string[]): FileNaming {
  const scores: Record<FileNaming, number> = {
    PascalCase: 0,
    "kebab-case": 0,
    camelCase: 0,
  };

  for (const componentPath of componentPaths) {
    if (!indexIsDirectory(index, componentPath)) continue;

    scoreNamingInDirectoryFromIndex(index, componentPath, scores);

    for (const subdir of COMPONENT_SUBDIRS) {
      const subRel = join(componentPath, subdir);
      if (indexIsDirectory(index, subRel)) {
        scoreNamingInDirectoryFromIndex(index, subRel, scores);
      }
    }

    for (const entryName of indexChildDirectoryNames(index, componentPath)) {
      if (UTILITY_FOLDER_NAMES.has(entryName.toLowerCase())) continue;

      const folderStyle = classifyName(entryName);
      if (folderStyle) scores[folderStyle] += 2;

      const dir = join(componentPath, entryName);
      for (const file of indexListFiles(index, dir)) {
        if (!file.endsWith(".tsx") || file.includes(".test.") || file.includes(".stories.")) {
          continue;
        }
        const base = file.replace(/\.tsx$/, "");
        const fileStyle = classifyName(base);
        if (fileStyle) scores[fileStyle] += 1;
      }
    }
  }

  const ranked = (Object.entries(scores) as Array<[FileNaming, number]>).sort(
    (a, b) => b[1] - a[1],
  );
  if (ranked[0]?.[1] > 0) return ranked[0][0];
  return "PascalCase";
}

function scoreNamingInDirectoryFromIndex(
  index: RepoIndex,
  dirRel: string,
  scores: Record<FileNaming, number>,
): void {
  for (const file of listFlatComponentFilesFromIndex(index, dirRel)) {
    const base = file.replace(/\.tsx$/, "");
    const fileStyle = classifyComponentFileName(base);
    if (fileStyle) scores[fileStyle] += 2;
  }
}

async function detectExportStyle(
  rootDir: string,
  components: ExistingComponentSummary[],
): Promise<ExportStyle> {
  const samples = await Promise.all(
    components
      .slice(0, 12)
      .map((component) => readExportStyle(join(rootDir, component.path))),
  );

  let named = 0;
  let defaultExport = 0;

  for (const style of samples) {
    if (style === "named") named += 1;
    if (style === "default") defaultExport += 1;
  }

  if (defaultExport > named) return "default";
  return "named";
}

async function detectPropsPattern(
  rootDir: string,
  components: ExistingComponentSummary[],
): Promise<PropsPattern> {
  const samples = await Promise.all(
    components
      .slice(0, 12)
      .map((component) => readPropsPattern(join(rootDir, component.path))),
  );

  let interfaceCount = 0;
  let typeCount = 0;

  for (const pattern of samples) {
    if (pattern === "interface") interfaceCount += 1;
    if (pattern === "type") typeCount += 1;
  }

  if (typeCount > interfaceCount) return "type";
  return "interface";
}

async function readExportStyle(absPath: string): Promise<ExportStyle | null> {
  const source = await readFile(absPath, "utf8").catch(() => null);
  if (!source) return null;
  if (/export\s+default\s/m.test(source)) return "default";
  if (/export\s+(?:const|function)\s+/m.test(source)) return "named";
  return null;
}

async function readPropsPattern(absPath: string): Promise<PropsPattern | null> {
  const source = await readFile(absPath, "utf8").catch(() => null);
  if (!source) return null;
  if (/interface\s+\w+Props\b/m.test(source)) return "interface";
  if (/type\s+\w+Props\b/m.test(source)) return "type";
  return null;
}

function detectExistingTokensFromIndex(
  index: RepoIndex,
  tokenPaths: string[],
  styleSystem: StyleSystem,
): ExistingTokensSummary | null {
  const path = tokenPaths[0];
  if (!path) return null;

  const hasCssTokens =
    path.endsWith(".css") ||
    (indexIsDirectory(index, path) &&
      indexListFiles(index, path).some((file) => file.endsWith(".css")));

  const format =
    styleSystem === "tailwind" && path.includes("tailwind.config")
      ? "tailwind-config"
      : hasCssTokens
        ? "css-variables"
        : path.endsWith(".css")
          ? "css-variables"
          : path.endsWith(".json")
            ? "json"
            : "js-object";

  return {
    format,
    path,
    colors: [],
    spacing: [],
    radii: [],
  };
}

function listFlatComponentFilesFromIndex(index: RepoIndex, dirRel: string): string[] {
  return indexListFiles(index, dirRel).filter(isComponentTsxFile);
}

function listFolderComponentEntriesFromIndex(index: RepoIndex, dirRel: string): string[] {
  return indexChildDirectoryNames(index, dirRel).filter(isComponentFolder);
}

function isComponentTsxFile(name: string): boolean {
  if (!name.endsWith(".tsx")) return false;
  if (EXCLUDED_COMPONENT_FILES.has(name)) return false;
  if (name.includes(".test.") || name.includes(".spec.")) return false;
  if (name.includes(".stories.")) return false;
  if (name.includes(".figma.")) return false;
  const base = name.replace(/\.tsx$/, "");
  return classifyComponentFileName(base) !== null || classifyName(base) !== null;
}

function isIconDirectoryFromIndex(index: RepoIndex, relPath: string): boolean {
  if (!indexIsDirectory(index, relPath)) return false;
  if (directoryHasIconFilesFromIndex(index, relPath)) return true;

  for (const child of indexChildDirectoryNames(index, relPath)) {
    if (directoryHasIconFilesFromIndex(index, join(relPath, child))) {
      return true;
    }
  }

  return false;
}

function directoryHasIconFilesFromIndex(index: RepoIndex, relPath: string): boolean {
  return indexListFiles(index, relPath).some(
    (f) =>
      f.endsWith(".tsx") ||
      f.endsWith(".ts") ||
      f.endsWith(".svg") ||
      f.endsWith(".jsx"),
  );
}

async function hasTailwindAtRulesFromIndex(index: RepoIndex): Promise<boolean> {
  const cssFiles = indexFindCssFiles(index);
  const checks = await Promise.all(
    cssFiles.map(async (relPath) => {
      const source = await readFile(join(index.rootDir, relPath), "utf8").catch(() => null);
      return Boolean(source && /@tailwind\s/m.test(source));
    }),
  );
  return checks.some(Boolean);
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const path of paths) {
    const normalized = path.replace(/^\.\//, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

async function readJsonSafe<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function loadSyncConfigFromWorkspace(
  rootDir: string,
): Promise<SyncConfig | null> {
  const raw = await readFile(join(rootDir, ".figma", "sync-config.json"), "utf8").catch(
    () => null,
  );
  if (!raw) return null;
  return JSON.parse(raw) as SyncConfig;
}

export async function loadRegistryFromWorkspace(rootDir: string) {
  const raw = await readFile(join(rootDir, ".figma", "registry.json"), "utf8").catch(
    () => null,
  );
  if (!raw) {
    return { components: {}, screens: {} };
  }
  return JSON.parse(raw);
}

export function buildRegistryHints(
  registry: { components?: Record<string, { codePaths?: { web?: string } }> },
): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const [name, entry] of Object.entries(registry.components ?? {})) {
    if (entry.codePaths?.web) {
      hints[name] = entry.codePaths.web;
    }
  }
  return hints;
}

export function relativePathFromRoot(rootDir: string, absPath: string): string {
  return relative(rootDir, absPath);
}
