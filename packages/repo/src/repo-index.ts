import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "storybook-static",
  ".cache",
]);

const MAX_WALK_DEPTH = 8;

export interface RepoIndex {
  rootDir: string;
  files: string[];
  directoryPaths: Set<string>;
  filesInDirectory: Map<string, string[]>;
  dirsNamed: Map<string, string[]>;
  filesNamed: Map<string, string[]>;
}

export async function buildRepoIndex(rootDir: string): Promise<RepoIndex> {
  const files: string[] = [];
  const directoryPaths = new Set<string>();
  const filesInDirectory = new Map<string, string[]>();
  const dirsNamed = new Map<string, string[]>();
  const filesNamed = new Map<string, string[]>();

  async function walk(absPath: string, relPath: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;

    let entries: Dirent[];
    try {
      entries = await readdir(absPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

      const entryRel = relPath ? join(relPath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        if (shouldPruneDirectory(entryRel)) continue;

        directoryPaths.add(entryRel);
        appendMap(dirsNamed, entry.name, entryRel);
        await walk(join(absPath, entry.name), entryRel, depth + 1);
        continue;
      }

      files.push(entryRel);
      appendMap(filesNamed, entry.name, entryRel);

      const parentKey = relPath || ".";
      appendMap(filesInDirectory, parentKey, entry.name);
    }
  }

  await walk(rootDir, "", 0);

  return {
    rootDir,
    files,
    directoryPaths,
    filesInDirectory,
    dirsNamed,
    filesNamed,
  };
}

function shouldPruneDirectory(relPath: string): boolean {
  return relPath.includes("apps/storybook/public");
}

function appendMap(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

export function indexIsDirectory(index: RepoIndex, relPath: string): boolean {
  return index.directoryPaths.has(relPath);
}

export function indexPathExists(index: RepoIndex, relPath: string): boolean {
  return index.directoryPaths.has(relPath) || index.files.includes(relPath);
}

export function indexListFiles(index: RepoIndex, dirRel: string): string[] {
  return index.filesInDirectory.get(dirRel) ?? [];
}

export function indexFindDirsNamed(index: RepoIndex, name: string): string[] {
  return index.dirsNamed.get(name) ?? [];
}

export function indexFindFilesNamed(index: RepoIndex, names: string | string[]): string[] {
  const expected = Array.isArray(names) ? names : [names];
  const matches: string[] = [];
  for (const name of expected) {
    matches.push(...(index.filesNamed.get(name) ?? []));
  }
  return matches;
}

export function indexHasFileSuffix(index: RepoIndex, suffix: string): boolean {
  return index.files.some((file) => file.endsWith(suffix));
}

export function indexChildDirectoryNames(index: RepoIndex, dirRel: string): string[] {
  const prefix = `${dirRel}/`;
  const children = new Set<string>();

  for (const dir of index.directoryPaths) {
    if (!dir.startsWith(prefix)) continue;
    const rest = dir.slice(prefix.length);
    if (!rest.includes("/")) {
      children.add(rest);
    }
  }

  return [...children];
}

export function indexFindCssFiles(index: RepoIndex, limit = 24): string[] {
  return index.files.filter((file) => file.endsWith(".css")).slice(0, limit);
}
