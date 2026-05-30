import { access, readFile } from "node:fs/promises";
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
