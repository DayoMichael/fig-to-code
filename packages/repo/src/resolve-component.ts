import { dirname, join } from "node:path";
import type {
  DetectedProjectConfig,
  Registry,
  ResolveComponentRequest,
  ResolvedComponentBundle,
  ResolvedComponentFile,
  ResolvedComponentFileRole,
  ResolvedComponentMatch,
  SyncConfig,
} from "@fig2code/spec";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_RELATED_FILES = 6;

/** Async file reader keyed by repo-relative path. Returns null when the file is missing. */
export type ResolveFileReader = (path: string) => Promise<string | null>;

export interface ResolveComponentInput extends ResolveComponentRequest {
  syncConfig: SyncConfig;
  detected?: DetectedProjectConfig;
  registry?: Registry;
  readFile: ResolveFileReader;
  /** Optional logger for diagnostics. */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

interface PathCandidate {
  path: string;
  role: ResolvedComponentFileRole;
  source: "registry" | "code-connect" | "detected" | "convention";
}

/**
 * Look up the team's existing implementation for a Figma component without
 * compiling any TSX. Returns the component file plus colocated story/test/barrel
 * when present, or `null` when no plausible match exists in the repo.
 */
export async function resolveComponentBundle(
  input: ResolveComponentInput,
): Promise<ResolvedComponentBundle | null> {
  const componentName = input.componentName?.trim();
  if (!componentName) {
    return null;
  }

  const log = input.log ?? (() => {});
  const candidates = collectCandidatePaths(componentName, input);

  log("resolveComponentBundle candidates", {
    componentName,
    candidates: candidates.slice(0, 16),
  });

  const primary = await findFirstComponentFile(candidates, input.readFile);
  if (!primary) {
    return null;
  }

  const canonicalName = canonicalComponentNameFromPath(primary.candidate.path) || componentName;

  const matched: ResolvedComponentFile = {
    path: primary.candidate.path,
    role: "component",
    content: truncate(primary.content),
  };

  const colocated = await loadColocatedFiles(
    primary.candidate.path,
    canonicalName,
    input.readFile,
  );

  const monorepoSupport = await loadMonorepoSupportFiles(
    primary.candidate.path,
    canonicalName,
    input.readFile,
  );

  const seenPaths = new Set<string>();
  const files: ResolvedComponentFile[] = [];
  for (const file of [matched, ...colocated.files, ...monorepoSupport]) {
    if (seenPaths.has(file.path)) {
      continue;
    }
    seenPaths.add(file.path);
    files.push(file);
  }

  const match: ResolvedComponentMatch = {
    source: primary.candidate.source,
    confidence: confidenceFor(primary.candidate.source),
    reason: reasonFor(primary.candidate.source, primary.candidate.path),
  };

  return {
    componentName: canonicalName,
    match,
    files,
    primaryComponentPath: matched.path,
    storyPath: colocated.storyPath,
    testPath: colocated.testPath,
    barrelPath: colocated.barrelPath,
    relatedModules: [],
    truncated: false,
  };
}

function collectCandidatePaths(
  componentName: string,
  input: ResolveComponentInput,
): PathCandidate[] {
  const seen = new Set<string>();
  const out: PathCandidate[] = [];

  const push = (
    path: string | undefined,
    role: ResolvedComponentFileRole,
    source: PathCandidate["source"],
  ): void => {
    if (!path) return;
    const normalized = normalizePath(path);
    if (!normalized || seen.has(`${normalized}|${role}`)) return;
    seen.add(`${normalized}|${role}`);
    out.push({ path: normalized, role, source });
  };

  const registryEntry = input.registry?.components?.[componentName];
  if (registryEntry?.codePaths?.web) {
    push(registryEntry.codePaths.web, "component", "registry");
  }

  const detectedComponent = input.detected?.existingComponents.find(
    (entry) =>
      entry.name === componentName ||
      entry.name.toLowerCase() === componentName.toLowerCase(),
  );
  if (detectedComponent) {
    push(detectedComponent.path, "component", "detected");
  }

  const nameVariants = nameVariantsFor(componentName);
  const componentPaths = collectComponentPaths(input);

  for (const root of componentPaths) {
    for (const variant of nameVariants) {
      push(join(root, variant, `${variant}.tsx`), "component", "convention");
      push(join(root, `${variant}.tsx`), "component", "convention");
      push(join(root, variant, "index.tsx"), "component", "convention");
      push(join(root, variant, "index.ts"), "component", "convention");
    }
    for (const subdir of COMPONENT_SUBDIRS) {
      for (const variant of nameVariants) {
        push(join(root, subdir, variant, `${variant}.tsx`), "component", "convention");
        push(join(root, subdir, `${variant}.tsx`), "component", "convention");
      }
    }
  }

  return out.slice(0, MAX_CANDIDATES);
}

const MAX_CANDIDATES = 32;

const COMPONENT_SUBDIRS = ["ui", "primitives", "core", "base", "shared"];

function nameVariantsFor(componentName: string): string[] {
  const variants = new Set<string>();
  const trimmed = componentName.trim();
  if (!trimmed) return [];

  variants.add(trimmed);
  variants.add(toPascalCase(trimmed));
  variants.add(toCamelCase(trimmed));
  variants.add(toKebabCase(trimmed));
  variants.add(toKebabCase(trimmed).toLowerCase());

  return [...variants].filter(Boolean);
}

function toPascalCase(value: string): string {
  const words = splitWords(value);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function toKebabCase(value: string): string {
  return splitWords(value).map((word) => word.toLowerCase()).join("-");
}

function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function collectComponentPaths(input: ResolveComponentInput): string[] {
  const out = new Set<string>();
  const primary = input.syncConfig.web?.componentPath;
  if (primary) out.add(primary);
  if (input.detected) {
    for (const path of input.detected.componentPaths ?? []) {
      out.add(path);
    }
  }
  if (out.size === 0) {
    out.add("src/components");
  }
  return [...out];
}

async function findFirstComponentFile(
  candidates: PathCandidate[],
  readFile: ResolveFileReader,
): Promise<{ candidate: PathCandidate; content: string } | null> {
  const componentCandidates = candidates.filter((candidate) => candidate.role === "component");
  const prioritized = componentCandidates.filter(
    (candidate) => candidate.source === "registry" || candidate.source === "detected",
  );
  const conventional = componentCandidates.filter(
    (candidate) => candidate.source !== "registry" && candidate.source !== "detected",
  );

  for (const candidate of prioritized) {
    const content = await readFile(candidate.path);
    if (content && content.trim().length > 0) {
      return { candidate, content };
    }
  }

  const batchSize = 8;
  for (let index = 0; index < conventional.length; index += batchSize) {
    const batch = conventional.slice(index, index + batchSize);
    const hits = await Promise.all(
      batch.map(async (candidate) => {
        const content = await readFile(candidate.path);
        if (content && content.trim().length > 0) {
          return { candidate, content };
        }
        return null;
      }),
    );
    const hit = hits.find(Boolean);
    if (hit) {
      return hit;
    }
  }

  return null;
}

interface ColocatedFiles {
  files: ResolvedComponentFile[];
  storyPath?: string;
  testPath?: string;
  barrelPath?: string;
}

async function loadColocatedFiles(
  componentPath: string,
  componentName: string,
  readFile: ResolveFileReader,
): Promise<ColocatedFiles> {
  const dir = dirname(componentPath);
  const fileName = basename(componentPath);
  const baseName = fileName.replace(/\.(tsx|jsx|ts|js)$/i, "");
  const storyCandidates = buildStoryFileCandidates(componentPath, componentName);

  const testCandidates = [
    join(dir, `${baseName}.test.tsx`),
    join(dir, `${baseName}.test.ts`),
    join(dir, `${baseName}.spec.tsx`),
    join(dir, `${baseName}.spec.ts`),
    join(dir, "__tests__", `${baseName}.test.tsx`),
    join(dir, "__tests__", `${baseName}.test.ts`),
  ];

  const barrelCandidates = [
    join(dir, "index.ts"),
    join(dir, "index.tsx"),
  ];

  const codeConnectCandidates = [
    join(dir, `${baseName}.figma.tsx`),
    join(dir, `${baseName}.figma.ts`),
  ];

  const [story, test, barrel, codeConnect] = await Promise.all([
    readFirstExisting(storyCandidates, readFile),
    readFirstExisting(testCandidates, readFile),
    readFirstExisting(barrelCandidates, readFile),
    readFirstExisting(codeConnectCandidates, readFile),
  ]);

  const files: ResolvedComponentFile[] = [];
  if (story) files.push({ path: story.path, role: "story", content: truncate(story.content) });
  if (test) files.push({ path: test.path, role: "test", content: truncate(test.content) });
  if (barrel) files.push({ path: barrel.path, role: "barrel", content: truncate(barrel.content) });
  if (codeConnect) {
    files.push({
      path: codeConnect.path,
      role: "code-connect",
      content: truncate(codeConnect.content),
    });
  }

  return {
    files: files.slice(0, MAX_RELATED_FILES),
    storyPath: story?.path,
    testPath: test?.path,
    barrelPath: barrel?.path,
  };
}

async function loadMonorepoSupportFiles(
  componentPath: string,
  componentName: string,
  readFile: ResolveFileReader,
): Promise<ResolvedComponentFile[]> {
  const files: ResolvedComponentFile[] = [];
  const packageIndexPath = findPackageIndexPath(componentPath);
  if (packageIndexPath) {
    const content = await readFile(packageIndexPath);
    if (content?.trim()) {
      files.push({
        path: packageIndexPath,
        role: "related",
        content: truncate(content),
      });
    }
  }

  const monorepoTestPath = findMonorepoTestPath(componentPath, componentName);
  if (monorepoTestPath) {
    const content = await readFile(monorepoTestPath);
    if (content?.trim()) {
      files.push({
        path: monorepoTestPath,
        role: "test",
        content: truncate(content),
      });
    }
  }

  return files;
}

function findPackageIndexPath(componentPath: string): string | undefined {
  const marker = "packages/ui/src/";
  const idx = componentPath.indexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  return join(componentPath.slice(0, idx + marker.length), "index.ts");
}

function findMonorepoTestPath(componentPath: string, componentName: string): string | undefined {
  if (!componentPath.includes("packages/ui/src/components/")) {
    return undefined;
  }
  const kebab = componentName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  return `packages/ui/src/__tests__/${kebab}.test.tsx`;
}

async function readFirstExisting(
  paths: string[],
  readFile: ResolveFileReader,
): Promise<{ path: string; content: string } | null> {
  for (const path of paths) {
    const content = await readFile(path);
    if (content && content.trim().length > 0) {
      return { path, content };
    }
  }
  return null;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

function confidenceFor(source: PathCandidate["source"]): ResolvedComponentMatch["confidence"] {
  switch (source) {
    case "registry":
      return "high";
    case "code-connect":
      return "high";
    case "detected":
      return "medium";
    default:
      return "low";
  }
}

function reasonFor(source: PathCandidate["source"], path: string): string {
  switch (source) {
    case "registry":
      return `Matched via .figma/registry.json (${path}).`;
    case "code-connect":
      return `Matched via Code Connect file near ${path}.`;
    case "detected":
      return `Matched via repo detection (${path}).`;
    default:
      return `Matched via convention (${path}).`;
  }
}

function truncate(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_FILE_BYTES) {
    return content;
  }
  const slice = content.slice(0, MAX_FILE_BYTES);
  return `${slice}\n// ...[truncated by fig2code resolve]`;
}

/** PascalCase name derived from a component file path (kebab, camel, or spaced input file). */
export function canonicalComponentNameFromPath(componentPath: string): string {
  const baseName = basename(componentPath).replace(/\.(tsx|jsx|ts|js)$/i, "");
  return toPascalCase(baseName);
}

/** Story file paths to probe for a component, including Storybook app conventions. */
export function buildStoryFileCandidates(
  componentPath: string,
  componentName: string,
): string[] {
  const dir = dirname(componentPath);
  const fileName = basename(componentPath);
  const baseName = fileName.replace(/\.(tsx|jsx|ts|js)$/i, "");
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (candidate: string): void => {
    const normalized = normalizePath(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    out.push(normalized);
  };

  for (const ext of [".stories.tsx", ".stories.ts", ".stories.jsx"]) {
    push(join(dir, `${baseName}${ext}`));
  }

  for (const variant of nameVariantsFor(componentName)) {
    const pascal = toPascalCase(variant);
    const kebab = toKebabCase(variant);
    for (const ext of [".stories.tsx", ".stories.ts", ".stories.jsx"]) {
      push(join(dir, `${pascal}${ext}`));
      push(join(dir, `${kebab}${ext}`));
      push(`apps/storybook/src/stories/${pascal}${ext}`);
      push(`apps/storybook/src/stories/${kebab}${ext}`);
    }
  }

  return out;
}
