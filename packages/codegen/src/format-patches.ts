import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import prettier from "prettier";
import type { FilePatch, FormatterPreference, JobBuildPreview } from "@fig2code/spec";

const execFileAsync = promisify(execFile);

const FORMATTABLE_PATH_RE = /\.(tsx?|jsx?|mdx)$/i;

const PRETTIER_CONFIG_CANDIDATES = [
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

const PACKAGE_JSON_CANDIDATES = [
  "package.json",
  "packages/ui/package.json",
  "packages/design-system/package.json",
  "packages/components/package.json",
];

export interface FormatPatchContext {
  formatter?: FormatterPreference;
  repoRoot?: string;
  readFile?: (path: string) => Promise<string | null>;
  existingFiles?: Array<{ path: string; content?: string }>;
}

export function isFormattablePatchPath(filePath: string): boolean {
  return FORMATTABLE_PATH_RE.test(filePath);
}

export async function formatChangedPatches(
  patches: FilePatch[],
  context: FormatPatchContext = {},
): Promise<FilePatch[]> {
  const normalizedContext = withRepoReadFile(context);
  const formatter = await resolveActiveFormatter(normalizedContext);
  if (formatter === "none") {
    return patches;
  }

  const hasFormattable = patches.some(
    (patch) =>
      patch.action !== "delete" &&
      patch.content &&
      isFormattablePatchPath(patch.path),
  );
  if (!hasFormattable) {
    return patches;
  }

  const optionsCache = new Map<string, prettier.Options | null>();

  if (normalizedContext.repoRoot) {
    const cliFormatted = await formatPatchesViaPrettierCli(
      normalizedContext.repoRoot,
      patches,
    );
    if (cliFormatted) {
      return cliFormatted;
    }
  }

  return Promise.all(
    patches.map(async (patch) => {
      if (patch.action === "delete" || !patch.content || !isFormattablePatchPath(patch.path)) {
        return patch;
      }

      try {
        const formatted = await formatPatchContent(
          patch.path,
          patch.content,
          normalizedContext,
          optionsCache,
        );
        if (!formatted || formatted === patch.content) {
          return patch;
        }
        return { ...patch, content: formatted };
      } catch {
        return patch;
      }
    }),
  );
}

function withRepoReadFile(context: FormatPatchContext): FormatPatchContext {
  if (context.readFile || !context.repoRoot) {
    return context;
  }

  return {
    ...context,
    readFile: async (filePath: string) => {
      try {
        const { readFile } = await import("node:fs/promises");
        return await readFile(join(context.repoRoot!, filePath), "utf8");
      } catch {
        return null;
      }
    },
  };
}

async function resolveActiveFormatter(context: FormatPatchContext): Promise<"prettier" | "none"> {
  const preference = context.formatter ?? "auto";
  if (preference === "none") {
    return "none";
  }
  if (preference === "prettier") {
    return "prettier";
  }

  // A repo clone can always run the team's Prettier CLI (plugins + config on disk).
  if (context.repoRoot) {
    return "prettier";
  }

  if (context.readFile) {
    const detected = await detectFormatterViaReadFile(context.readFile);
    if (detected === "prettier") {
      return "prettier";
    }
  }

  if (context.existingFiles?.some((file) => file.content?.trim())) {
    return "prettier";
  }

  return "none";
}

async function detectFormatterViaReadFile(
  readFile: (path: string) => Promise<string | null>,
): Promise<"prettier" | "none"> {
  for (const name of PRETTIER_CONFIG_CANDIDATES) {
    const content = await readFile(name);
    if (content?.trim()) {
      return "prettier";
    }
  }

  const packageJson = await readFirstMatchingFile(readFile, PACKAGE_JSON_CANDIDATES);
  if (!packageJson) {
    return "none";
  }

  try {
    const parsed = JSON.parse(packageJson) as {
      prettier?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (parsed.prettier) {
      return "prettier";
    }
    if (parsed.dependencies?.prettier || parsed.devDependencies?.prettier) {
      return "prettier";
    }
  } catch {
    return "none";
  }

  return "none";
}

async function formatPatchContent(
  filePath: string,
  content: string,
  context: FormatPatchContext,
  optionsCache: Map<string, prettier.Options | null>,
): Promise<string> {
  const options = await resolvePrettierOptions(filePath, context, optionsCache);
  return prettier.format(content, {
    ...(options ?? {}),
    filepath: filePath,
  });
}

async function resolvePrettierOptions(
  filePath: string,
  context: FormatPatchContext,
  optionsCache: Map<string, prettier.Options | null>,
): Promise<prettier.Options | null> {
  const cacheKey = context.repoRoot ?? "__remote__";
  if (optionsCache.has(cacheKey)) {
    return optionsCache.get(cacheKey) ?? null;
  }

  let resolved: prettier.Options | null = null;

  if (context.repoRoot) {
    try {
      resolved = await prettier.resolveConfig(join(context.repoRoot, filePath));
    } catch {
      resolved = null;
    }
  } else if (context.readFile) {
    resolved = await loadPrettierOptionsFromRemote(context.readFile);
  }

  if (!resolved) {
    const sample = pickStyleSample(context.existingFiles, filePath);
    if (sample) {
      resolved = inferPrettierOptionsFromSample(sample);
    }
  }

  optionsCache.set(cacheKey, resolved);
  return resolved;
}

async function loadPrettierOptionsFromRemote(
  readFile: (path: string) => Promise<string | null>,
): Promise<prettier.Options | null> {
  for (const name of PRETTIER_CONFIG_CANDIDATES) {
    const content = await readFile(name);
    if (!content?.trim()) {
      continue;
    }

    if (name.endsWith(".json") || name === ".prettierrc") {
      try {
        const parsed = JSON.parse(content) as prettier.Options;
        return parsed;
      } catch {
        continue;
      }
    }

    if (name.endsWith(".yml") || name.endsWith(".yaml")) {
      continue;
    }
  }

  const packageJson = await readFirstMatchingFile(readFile, PACKAGE_JSON_CANDIDATES);
  if (!packageJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(packageJson) as { prettier?: prettier.Options };
    return parsed.prettier ?? {};
  } catch {
    return null;
  }
}

function pickStyleSample(
  existingFiles: FormatPatchContext["existingFiles"],
  targetPath: string,
): string | undefined {
  if (!existingFiles?.length) {
    return undefined;
  }

  const sameDir = existingFiles.find(
    (file) =>
      file.content?.trim() &&
      file.path !== targetPath &&
      isFormattablePatchPath(file.path) &&
      dirname(file.path) === parentDir(targetPath),
  );
  if (sameDir?.content) {
    return sameDir.content;
  }

  const component = existingFiles.find(
    (file) => file.content?.trim() && isFormattablePatchPath(file.path),
  );
  return component?.content;
}

function inferPrettierOptionsFromSample(sample: string): prettier.Options {
  const useSemicolons = /;\s*(?:\/\/[^\n]*)?\n/.test(sample) || /;\s*$/.test(sample.trim());
  const singleQuote =
    (sample.match(/'/g)?.length ?? 0) > (sample.match(/"/g)?.length ?? 0);
  const indentMatch = sample.match(/^( +|\t)/m);
  let tabWidth = 2;
  let useTabs = false;
  if (indentMatch?.[1]) {
    useTabs = indentMatch[1].startsWith("\t");
    tabWidth = useTabs ? 2 : indentMatch[1].length;
  }

  return {
    semi: useSemicolons,
    singleQuote,
    useTabs,
    tabWidth,
  };
}

function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx >= 0 ? filePath.slice(0, idx) : "";
}

async function readFirstMatchingFile(
  readFile: (path: string) => Promise<string | null>,
  paths: string[],
): Promise<string | null> {
  for (const candidate of paths) {
    const content = await readFile(candidate);
    if (content?.trim()) {
      return content;
    }
  }
  return null;
}

/** Run the repo's own Prettier (plugins + config) on changed files. */
async function formatPatchesViaPrettierCli(
  repoRoot: string,
  patches: FilePatch[],
): Promise<FilePatch[] | null> {
  const formattable = patches.filter(
    (patch) =>
      patch.action !== "delete" &&
      patch.content &&
      isFormattablePatchPath(patch.path),
  );
  if (formattable.length === 0) {
    return patches;
  }

  const writtenPaths: string[] = [];
  const originals = new Map<string, string>();

  try {
    for (const patch of formattable) {
      const relPath = patch.path;
      const absPath = join(repoRoot, relPath);
      originals.set(relPath, patch.content!);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, patch.content!, "utf8");
      writtenPaths.push(relPath);
    }

    await execFileAsync("npx", ["prettier", "--write", ...writtenPaths], {
      cwd: repoRoot,
      env: process.env,
    });

    return Promise.all(
      patches.map(async (patch) => {
        if (!writtenPaths.includes(patch.path) || !patch.content) {
          return patch;
        }
        try {
          const formatted = await readFile(join(repoRoot, patch.path), "utf8");
          return { ...patch, content: formatted };
        } catch {
          return patch;
        }
      }),
    );
  } catch (error) {
    console.warn(
      "[fig2code] prettier CLI formatting failed — falling back to programmatic Prettier:",
      error instanceof Error ? error.message : error,
    );

    await Promise.all(
      [...originals.entries()].map(async ([relPath, content]) => {
        try {
          await writeFile(join(repoRoot, relPath), content, "utf8");
        } catch {
          // best-effort restore after failed format attempt
        }
      }),
    );

    return null;
  }
}

export async function formatJobBuildPreview(
  buildPreview: JobBuildPreview,
  context: FormatPatchContext = {},
): Promise<JobBuildPreview> {
  const patches: FilePatch[] = [];
  const paths = new Set<string>();

  const queue = (filePath: string | undefined, content: string | undefined) => {
    if (!filePath?.trim() || !content || paths.has(filePath)) {
      return;
    }
    paths.add(filePath);
    patches.push({ path: filePath, action: "update", content });
  };

  for (const file of buildPreview.files ?? []) {
    if (file.action === "delete" || !file.content) {
      continue;
    }
    queue(file.path, file.content);
  }
  queue(buildPreview.componentPath, buildPreview.componentContent);
  queue(buildPreview.storyPath, buildPreview.storyContent);

  const formatted = await formatChangedPatches(patches, context);
  const byPath = new Map(formatted.map((patch) => [patch.path, patch.content]));

  return {
    ...buildPreview,
    componentContent: buildPreview.componentPath
      ? (byPath.get(buildPreview.componentPath) ?? buildPreview.componentContent)
      : buildPreview.componentContent,
    storyContent: buildPreview.storyPath
      ? (byPath.get(buildPreview.storyPath) ?? buildPreview.storyContent)
      : buildPreview.storyContent,
    files: (buildPreview.files ?? []).map((file) => ({
      ...file,
      content: byPath.get(file.path) ?? file.content,
    })),
  };
}
