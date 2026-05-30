import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StorybookHarnessSupport {
  viteAliases: Record<string, string>;
  harnessDependencies: Record<string, string>;
  optimizeIncludes: string[];
  previewAnnotationsPath?: string;
}

/** Packages required to run stories via composeStories (not Storybook CLI/addons). */
const STORYBOOK_HARNESS_PACKAGES = [
  "@storybook/react",
  "@storybook/test",
] as const;

/** Optional peers stories/components import at runtime — safe for Vite optimizeDeps. */
const STORYBOOK_PEER_PACKAGES = [
  "lucide-react",
  "clsx",
  "class-variance-authority",
  "tailwind-merge",
  "next-themes",
  "sonner",
] as const;

/** Storybook addons/blocks are dev-only; never install or pre-bundle them in the harness. */
export const STORYBOOK_TOOLING_PREFIXES = [
  "@storybook/addon-",
  "@storybook/blocks",
  "@storybook/react-vite",
  "@storybook/types",
  "@storybook/global",
  "storybook",
] as const;

export function isStorybookToolingPackage(name: string): boolean {
  return STORYBOOK_TOOLING_PREFIXES.some(
    (prefix) => name === prefix || name.startsWith(prefix),
  );
}

export function sanitizeStorybookHarnessDependencies(
  dependencies: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (!isStorybookToolingPackage(name)) {
      out[name] = version;
    }
  }
  return out;
}

function viteOptimizablePackages(
  harnessDependencies: Record<string, string>,
): string[] {
  const allow = new Set<string>([
    ...STORYBOOK_HARNESS_PACKAGES,
    ...STORYBOOK_PEER_PACKAGES,
  ]);
  return Object.keys(harnessDependencies).filter((name) => allow.has(name));
}

function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function findPreviewAnnotationsPath(
  repoClonePath: string,
  storyRepoPath: string,
): Promise<string | undefined> {
  let dir = path.dirname(path.join(repoClonePath, storyRepoPath));

  while (dir.startsWith(repoClonePath)) {
    for (const file of ["preview.tsx", "preview.ts", "preview.jsx", "preview.js"]) {
      const candidate = path.join(dir, ".storybook", file);
      if (await pathExists(candidate)) {
        return toPosixRelative(repoClonePath, candidate);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return undefined;
}

export async function parseStorybookViteAliases(
  repoClonePath: string,
): Promise<Record<string, string>> {
  const candidates = [
    "apps/storybook/.storybook/main.ts",
    "apps/storybook/.storybook/main.js",
    ".storybook/main.ts",
    ".storybook/main.js",
  ];

  for (const rel of candidates) {
    const abs = path.join(repoClonePath, rel);
    if (!(await pathExists(abs))) {
      continue;
    }

    const content = await readFile(abs, "utf-8");
    const aliases: Record<string, string> = {};
    const pattern =
      /find:\s*['"]([^'"]+)['"][\s\S]*?replacement:\s*path\.join\(rootPath,\s*['"]([^'"]+)['"]\)/g;

    for (const match of content.matchAll(pattern)) {
      aliases[match[1]!] = match[2]!;
    }

    if (Object.keys(aliases).length > 0) {
      return aliases;
    }
  }

  return {};
}

async function readJsonFile<T>(absPath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(absPath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export async function resolveStorybookHarnessSupport(
  repoClonePath: string,
  storyRepoPath?: string,
): Promise<StorybookHarnessSupport> {
  const storybookPkgPaths = [
    "apps/storybook/package.json",
    "storybook/package.json",
    "packages/storybook/package.json",
  ];

  let mergedDeps: Record<string, string> = {};
  for (const rel of storybookPkgPaths) {
    const pkg = await readJsonFile<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(path.join(repoClonePath, rel));
    if (!pkg) {
      continue;
    }
    mergedDeps = {
      ...mergedDeps,
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    break;
  }

  const harnessDependencies: Record<string, string> = {
    react: mergedDeps.react ?? "^18.2.0",
    "react-dom": mergedDeps["react-dom"] ?? "^18.2.0",
  };

  for (const [name, version] of Object.entries(mergedDeps)) {
    if (isStorybookToolingPackage(name)) {
      continue;
    }
    if (
      STORYBOOK_HARNESS_PACKAGES.includes(name as (typeof STORYBOOK_HARNESS_PACKAGES)[number]) ||
      STORYBOOK_PEER_PACKAGES.includes(name as (typeof STORYBOOK_PEER_PACKAGES)[number])
    ) {
      harnessDependencies[name] = version;
    }
  }

  for (const pkgName of STORYBOOK_HARNESS_PACKAGES) {
    if (!harnessDependencies[pkgName] && mergedDeps[pkgName]) {
      harnessDependencies[pkgName] = mergedDeps[pkgName]!;
    }
  }

  for (const pkgName of STORYBOOK_PEER_PACKAGES) {
    if (mergedDeps[pkgName]) {
      harnessDependencies[pkgName] = mergedDeps[pkgName]!;
    }
  }

  if (!harnessDependencies["@storybook/react"]) {
    harnessDependencies["@storybook/react"] = "^7.6.7";
  }
  if (!harnessDependencies["@storybook/test"]) {
    harnessDependencies["@storybook/test"] = harnessDependencies["@storybook/react"];
  }

  const viteAliases = await parseStorybookViteAliases(repoClonePath);
  const previewAnnotationsPath = storyRepoPath
    ? await findPreviewAnnotationsPath(repoClonePath, storyRepoPath)
    : undefined;

  return {
    viteAliases,
    harnessDependencies: sanitizeStorybookHarnessDependencies(harnessDependencies),
    optimizeIncludes: viteOptimizablePackages(harnessDependencies),
    previewAnnotationsPath,
  };
}

export function mergeHarnessAliases(
  base: Record<string, string>,
  storybook: Record<string, string>,
): Record<string, string> {
  return { ...base, ...storybook };
}

export function extendHarnessIncludeForStory(
  include: string[],
  storyRepoPath?: string,
  previewAnnotationsPath?: string,
): string[] {
  if (!storyRepoPath) {
    return include;
  }

  const next = new Set(include);
  const storyRoot = storyRepoPath.split("/").slice(0, -1).join("/");
  if (storyRoot) {
    next.add(`../${storyRoot}/**/*`);
  }

  if (previewAnnotationsPath) {
    const storybookConfigDir = previewAnnotationsPath.split("/").slice(0, -1).join("/");
    if (storybookConfigDir) {
      next.add(`../${storybookConfigDir}/**/*`);
    }
    const storybookAppRoot = storybookConfigDir.split("/").slice(0, -1).join("/");
    if (storybookAppRoot) {
      next.add(`../${storybookAppRoot}/**/*`);
    }
  }

  return [...next];
}

const PREVIEW_ANNOTATIONS_SHIM = "preview-annotations.shim.tsx";

const NAMED_IMPORT_RE =
  /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g;

const EXPORT_FROM_RE =
  /export\s*\{\s*([^}]+)\s*\}\s*from\s+['"]([^'"]+)['"]\s*;?/g;

const EXPORT_STAR_RE = /export\s*\*\s*from\s+['"]([^'"]+)['"]\s*;?/g;

function isPreviewAnnotationsImport(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return true;
  }
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    return true;
  }
  if (specifier.startsWith("@") && !specifier.startsWith("@storybook/")) {
    return true;
  }
  return (
    !specifier.startsWith("@storybook/") &&
    !specifier.startsWith("react") &&
    !specifier.startsWith("node:") &&
    (specifier.includes("/") || specifier.startsWith("packages/"))
  );
}

function stripPreviewAnnotationsSource(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("import")) {
        return true;
      }
      if (/from\s+['"]@storybook\/addon-/.test(trimmed)) {
        return false;
      }
      if (/from\s+['"]@storybook\/blocks['"]/.test(trimmed)) {
        return false;
      }
      if (/from\s+['"]storybook\//.test(trimmed)) {
        return false;
      }
      if (/from\s+['"]@storybook\/react-vite['"]/.test(trimmed)) {
        return false;
      }
      return true;
    })
    .join("\n");
}

function parseNamedImportSpecifiers(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const aliasMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        return aliasMatch[2]!;
      }
      return part.replace(/^type\s+/, "").trim();
    })
    .filter(Boolean);
}

function parseExportBindingNames(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const aliasMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
      return aliasMatch ? aliasMatch[2]! : part;
    });
}

function collectDirectExportNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
    names.add(match[1]!);
  }
  for (const match of content.matchAll(/export\s+const\s+(\w+)/g)) {
    names.add(match[1]!);
  }
  for (const match of content.matchAll(/export\s+class\s+(\w+)/g)) {
    names.add(match[1]!);
  }
  for (const match of content.matchAll(/export\s*\{\s*([^}]+)\s*\}(?!\s*from)/g)) {
    for (const name of parseExportBindingNames(match[1]!)) {
      names.add(name);
    }
  }
  if (/export\s+default\b/.test(content)) {
    names.add("default");
  }
  return names;
}

async function resolveModuleFilePath(
  repoClonePath: string,
  fromAbsPath: string,
  specifier: string,
  viteAliases: Record<string, string>,
): Promise<string | undefined> {
  let target = specifier;

  for (const [prefix, aliasRel] of Object.entries(viteAliases).sort(
    (left, right) => right.length - left.length,
  )) {
    if (target === prefix || target.startsWith(`${prefix}/`)) {
      const suffix = target.slice(prefix.length).replace(/^\//, "");
      target = suffix ? path.posix.join(aliasRel, suffix) : aliasRel;
      break;
    }
  }

  if (target.startsWith("@/")) {
    target = path.posix.join("src", target.slice(2));
  }

  const candidates: string[] = [];
  if (path.isAbsolute(target)) {
    candidates.push(target);
  } else if (target.startsWith("packages/") || target.startsWith("apps/") || target.startsWith("src/")) {
    candidates.push(path.join(repoClonePath, target));
  } else {
    candidates.push(path.resolve(path.dirname(fromAbsPath), target));
  }

  const extensions = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"];
  for (const base of candidates) {
    for (const ext of extensions) {
      const candidate = base + ext;
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function resolveModuleExports(
  repoClonePath: string,
  moduleAbsPath: string,
  viteAliases: Record<string, string>,
  seen = new Set<string>(),
): Promise<Set<string>> {
  const normalized = path.normalize(moduleAbsPath);
  if (seen.has(normalized)) {
    return new Set();
  }
  seen.add(normalized);

  let content: string;
  try {
    content = await readFile(normalized, "utf-8");
  } catch {
    return new Set();
  }

  const names = collectDirectExportNames(content);

  for (const match of content.matchAll(EXPORT_FROM_RE)) {
    const reExportPath = await resolveModuleFilePath(
      repoClonePath,
      normalized,
      match[2]!,
      viteAliases,
    );
    const reExports = reExportPath
      ? await resolveModuleExports(repoClonePath, reExportPath, viteAliases, seen)
      : new Set<string>();

    for (const part of match[1]!.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const aliasMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
      const imported = aliasMatch ? aliasMatch[1]! : trimmed;
      const local = aliasMatch ? aliasMatch[2]! : trimmed;
      if (reExports.has(imported) || reExports.has(local)) {
        names.add(local);
      }
    }
  }

  for (const match of content.matchAll(EXPORT_STAR_RE)) {
    const reExportPath = await resolveModuleFilePath(
      repoClonePath,
      normalized,
      match[1]!,
      viteAliases,
    );
    if (!reExportPath) {
      continue;
    }
    const reExports = await resolveModuleExports(
      repoClonePath,
      reExportPath,
      viteAliases,
      seen,
    );
    for (const name of reExports) {
      names.add(name);
    }
  }

  return names;
}

async function fileDeclaresExport(
  fileAbsPath: string,
  exportName: string,
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(fileAbsPath, "utf-8");
  } catch {
    return false;
  }
  if (collectDirectExportNames(content).has(exportName)) {
    return true;
  }
  const patterns = [
    new RegExp(`export\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}`),
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${exportName}\\b`),
    new RegExp(`export\\s+const\\s+${exportName}\\b`),
    new RegExp(`export\\s+class\\s+${exportName}\\b`),
  ];
  return patterns.some((pattern) => pattern.test(content));
}

async function findValueExportFile(
  exportName: string,
  packageRootAbs: string,
): Promise<string | undefined> {
  const directCandidates = [
    path.join(packageRootAbs, `${exportName}.tsx`),
    path.join(packageRootAbs, `${exportName}.ts`),
    path.join(packageRootAbs, "src", `${exportName}.tsx`),
    path.join(packageRootAbs, "src", `${exportName}.ts`),
    path.join(packageRootAbs, "src", "providers", `${exportName}.tsx`),
    path.join(packageRootAbs, "src", "providers", `${exportName}.ts`),
    path.join(packageRootAbs, "src", "provider", `${exportName}.tsx`),
  ];

  for (const candidate of directCandidates) {
    if (await pathExists(candidate) && (await fileDeclaresExport(candidate, exportName))) {
      return candidate;
    }
  }

  const queue = [packageRootAbs];
  const visited = new Set<string>();
  let scanned = 0;
  while (queue.length > 0 && scanned < 500) {
    const dir = queue.shift()!;
    if (visited.has(dir)) {
      continue;
    }
    visited.add(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(abs);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) {
        continue;
      }
      scanned += 1;
      if (await fileDeclaresExport(abs, exportName)) {
        return abs;
      }
    }
  }

  return undefined;
}

function repoRelativeImport(
  repoClonePath: string,
  fromRepoRelPath: string,
  targetAbsPath: string,
): string {
  const fromDir = path.dirname(path.join(repoClonePath, fromRepoRelPath));
  const withoutExt = targetAbsPath.replace(/\.(tsx?|jsx?|mts?|ts|js|mjs)$/, "");
  let rel = toPosixRelative(fromDir, withoutExt);
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel.split(path.sep).join("/");
}

async function rewritePreviewAnnotationImports(
  repoClonePath: string,
  previewAbsPath: string,
  shimRepoRelPath: string,
  source: string,
  viteAliases: Record<string, string>,
): Promise<string | null> {
  let rewritten = source;
  for (const match of [...source.matchAll(NAMED_IMPORT_RE)]) {
    const specifier = match[2]!;
    if (!isPreviewAnnotationsImport(specifier)) {
      continue;
    }

    const modulePath = await resolveModuleFilePath(
      repoClonePath,
      previewAbsPath,
      specifier,
      viteAliases,
    );
    if (!modulePath) {
      return null;
    }

    const imported = parseNamedImportSpecifiers(match[1]!);
    const exported = await resolveModuleExports(
      repoClonePath,
      modulePath,
      viteAliases,
    );

    const directImports = new Map<string, string[]>();
    const fromBarrel: string[] = [];

    for (const name of imported) {
      if (exported.has(name)) {
        fromBarrel.push(name);
        continue;
      }

      const packageRoot = (() => {
        const rel = toPosixRelative(repoClonePath, modulePath);
        const parts = rel.split("/");
        if (parts[0] === "packages" && parts.length >= 2) {
          return path.join(repoClonePath, parts[0]!, parts[1]!);
        }
        return path.dirname(modulePath);
      })();

      const directFile = await findValueExportFile(name, packageRoot);
      if (!directFile) {
        return null;
      }
      const importPath = repoRelativeImport(repoClonePath, shimRepoRelPath, directFile);
      const bucket = directImports.get(importPath) ?? [];
      bucket.push(name);
      directImports.set(importPath, bucket);
    }

    const replacementLines: string[] = [];
    if (fromBarrel.length > 0) {
      replacementLines.push(
        `import { ${fromBarrel.join(", ")} } from '${repoRelativeImport(
          repoClonePath,
          shimRepoRelPath,
          modulePath,
        )}';`,
      );
    }
    for (const [importPath, names] of directImports) {
      replacementLines.push(`import { ${names.join(", ")} } from '${importPath}';`);
    }

    rewritten = rewritten.replace(match[0], replacementLines.join("\n"));
  }

  return rewritten;
}

async function previewAnnotationsImportsResolve(
  repoClonePath: string,
  previewAbsPath: string,
  source: string,
  viteAliases: Record<string, string>,
): Promise<boolean> {
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    const specifier = match[2]!;
    if (!isPreviewAnnotationsImport(specifier)) {
      continue;
    }
    const modulePath = await resolveModuleFilePath(
      repoClonePath,
      previewAbsPath,
      specifier,
      viteAliases,
    );
    if (!modulePath) {
      return false;
    }
    const exported = await resolveModuleExports(
      repoClonePath,
      modulePath,
      viteAliases,
    );
    for (const name of parseNamedImportSpecifiers(match[1]!)) {
      if (!exported.has(name)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Storybook preview.tsx often imports app providers from package barrels that do
 * not re-export them (e.g. AppProvider from a package barrel). Build a
 * harness-local shim with direct imports, or omit annotations when unfixable.
 */
export async function preparePreviewAnnotationsForHarness(
  repoClonePath: string,
  harnessPath: string,
  previewRepoRelPath: string,
  viteAliases: Record<string, string>,
): Promise<string | undefined> {
  const previewAbsPath = path.join(repoClonePath, previewRepoRelPath);
  if (!(await pathExists(previewAbsPath))) {
    return undefined;
  }

  const raw = await readFile(previewAbsPath, "utf-8");
  const cleaned = stripPreviewAnnotationsSource(raw);

  if (await previewAnnotationsImportsResolve(repoClonePath, previewAbsPath, cleaned, viteAliases)) {
    return previewRepoRelPath;
  }

  const shimRepoRelPath = path.posix.join(
    toPosixRelative(repoClonePath, harnessPath),
    PREVIEW_ANNOTATIONS_SHIM,
  );
  const rewritten = await rewritePreviewAnnotationImports(
    repoClonePath,
    previewAbsPath,
    shimRepoRelPath,
    cleaned,
    viteAliases,
  );

  if (!rewritten) {
    console.warn(
      `[fig2code] preview annotations at ${previewRepoRelPath} import unresolved symbols — skipping decorators`,
    );
    return undefined;
  }

  if (
    !(await previewAnnotationsImportsResolve(
      repoClonePath,
      path.join(repoClonePath, shimRepoRelPath),
      rewritten,
      viteAliases,
    ))
  ) {
    console.warn(
      `[fig2code] preview annotation shim still has unresolved imports — skipping decorators`,
    );
    return undefined;
  }

  const shimAbsPath = path.join(harnessPath, PREVIEW_ANNOTATIONS_SHIM);
  await writeFile(shimAbsPath, rewritten, "utf-8");
  console.log(`[fig2code] wrote preview annotation shim → ${shimRepoRelPath}`);
  return shimRepoRelPath;
}
