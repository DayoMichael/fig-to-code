import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VcsConfig } from "@fig2code/spec";
import { cloneRepository } from "@fig2code/git-host";

interface CachedRepo {
  clonePath: string;
  cacheKey: string;
  createdAt: number;
  lastAccessedAt: number;
  depsInstalled: boolean;
  /** Non-null while clone+install is in progress. */
  lock: Promise<string> | null;
}

export interface RepoCloneCache {
  getOrClone(
    vcs: VcsConfig,
    gitToken: string,
    atlassianEmail?: string,
  ): Promise<string>;
  evict(vcs: VcsConfig): Promise<void>;
  evictAll(): Promise<void>;
}

const MAX_CACHE_SIZE = 4;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function repoCacheKey(vcs: VcsConfig): string {
  const branch = vcs.baseBranch || "main";
  switch (vcs.provider) {
    case "github":
      return `github-${vcs.owner}-${vcs.repo}-${branch}`;
    case "bitbucket":
      return `bitbucket-${vcs.workspace}-${vcs.repo}-${branch}`;
    case "gitlab":
      return `gitlab-${vcs.projectIdOrPath}-${branch}`;
  }
}

/** Stable preview session id per connected repo (reuse Vite across component swaps). */
export function repoPreviewSessionId(vcs: VcsConfig): string {
  return `repo-preview-${repoCacheKey(vcs)}`;
}

export function createRepoCloneCache(): RepoCloneCache {
  const cache = new Map<string, CachedRepo>();

  const ttlCheck = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.lastAccessedAt > CACHE_TTL_MS) {
        console.log(`[fig2code] repo cache TTL evict: ${key}`);
        cache.delete(key);
        rm(entry.clonePath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 60_000);
  ttlCheck.unref?.();

  async function evictOldest(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of cache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = cache.get(oldestKey)!;
      cache.delete(oldestKey);
      console.log(`[fig2code] repo cache capacity evict: ${oldestKey}`);
      await rm(entry.clonePath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function getOrClone(
    vcs: VcsConfig,
    gitToken: string,
    _atlassianEmail?: string,
  ): Promise<string> {
    const key = repoCacheKey(vcs);

    const existing = cache.get(key);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      if (existing.lock) return existing.lock;
      return existing.clonePath;
    }

    if (cache.size >= MAX_CACHE_SIZE) {
      await evictOldest();
    }

    const clonePath = path.join(
      tmpdir(),
      `fig2code-repo-${key}-${Date.now()}`,
    );

    const entry: CachedRepo = {
      clonePath,
      cacheKey: key,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      depsInstalled: false,
      lock: null,
    };

    const setupPromise = (async (): Promise<string> => {
      console.log(`[fig2code] cloning repo: ${key} → ${clonePath}`);
      await cloneRepository({ vcs, token: gitToken, targetDir: clonePath });

      console.log(`[fig2code] installing deps in cached clone: ${clonePath}`);
      await installDepsInRepo(clonePath);
      entry.depsInstalled = true;
      entry.lock = null;
      console.log(`[fig2code] repo cache ready: ${key}`);
      return clonePath;
    })();

    entry.lock = setupPromise;
    cache.set(key, entry);

    try {
      return await setupPromise;
    } catch (err) {
      cache.delete(key);
      await rm(clonePath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async function evict(vcs: VcsConfig): Promise<void> {
    const key = repoCacheKey(vcs);
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    await rm(entry.clonePath, { recursive: true, force: true }).catch(() => {});
  }

  async function evictAll(): Promise<void> {
    const entries = [...cache.values()];
    cache.clear();
    await Promise.all(
      entries.map((e) =>
        rm(e.clonePath, { recursive: true, force: true }).catch(() => {}),
      ),
    );
  }

  return { getOrClone, evict, evictAll };
}

async function detectPackageManager(
  repoPath: string,
): Promise<{ cmd: string; args: string[] }> {
  const files = await readdir(repoPath);

  if (files.includes("pnpm-lock.yaml")) {
    return {
      cmd: "pnpm",
      args: ["install", "--no-frozen-lockfile"],
    };
  }
  if (files.includes("yarn.lock")) {
    return {
      cmd: "yarn",
      args: ["install", "--no-immutable"],
    };
  }
  return {
    cmd: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["install", "--no-audit", "--no-fund", "--loglevel", "error"],
  };
}

async function installDepsInRepo(repoPath: string): Promise<void> {
  const { cmd, args } = await detectPackageManager(repoPath);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("exit", (code) => {
      if (code === 0) {
        console.log(`[fig2code] deps installed in ${repoPath}`);
        resolve();
      } else {
        reject(new Error(`${cmd} install failed (exit ${code}): ${stderr}`));
      }
    });

    child.on("error", reject);
  });
}
