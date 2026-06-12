import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile as readFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import type {
  DetectedProjectConfig,
  Registry,
  ResolveComponentResponse,
  SyncConfig,
  TypographyCatalog,
  VcsConfig,
} from "@fig2code/spec";
import {
  fixturePath,
  onboardLocalRepo,
  onboardRemoteRepo,
  buildTypographyConfigFromRemote,
  buildTokenConfigFromRemote,
  resolveComponentBundle,
} from "@fig2code/repo";
import { createGitHostProvider, GitHostApiError, formatGitHostApiError } from "@fig2code/git-host";
import { createBundleStore, type BundleStore } from "./bundle-store.js";
import { createRepoCloneCache, type RepoCloneCache } from "./repo-cache.js";

export interface ConnectRequestBody {
  vcs: VcsConfig;
  token: string;
  atlassianEmail?: string;
}

export interface ConnectResponseBody {
  sessionId: string;
  repoUrl: string;
  detected: DetectedProjectConfig;
  syncConfig: SyncConfig;
  refs: Array<{ name: string; sha?: string }>;
  workspacePath: string;
}

export interface ReposRouterOptions {
  bundleStore?: BundleStore;
  repoCache?: RepoCloneCache;
}

const execFileAsync = promisify(execFile);

/**
 * Resolve must answer from committed repo content only. The shared clone also
 * holds preview-session artifacts — generated component files written so Vite
 * can serve them — which are untracked by git. Treating those as repo files
 * makes a brand-new component "resolve" to its own generated output: the
 * plugin flips to update mode, the PR baseline becomes phantom files that were
 * never pushed, and Create PR wrongly disables. Returns null when the clone
 * isn't a git repo (tests use plain fixture dirs); callers then allow all
 * files.
 */
async function listGitTrackedFiles(clonePath: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: clonePath,
      maxBuffer: 16 * 1024 * 1024,
    });
    return new Set(stdout.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

export function createReposRouter(options: ReposRouterOptions = {}): Hono {
  const app = new Hono();
  const bundleStore = options.bundleStore ?? createBundleStore();
  const repoCache = options.repoCache ?? createRepoCloneCache();

  app.post("/refs", async (c) => {
    let provider: string | undefined;

    try {
      const body = parseConnectBody(await c.req.json());
      provider = body.vcs.provider;
      const git = createGitHostProvider(body.vcs.provider);
      const refs = await git.listRefs(body.vcs, gitAuth(body));
      return c.json({ refs });
    } catch (error) {
      return repoError(c, error, { provider });
    }
  });

  app.get("/refs", async (c) => {
    const provider = c.req.query("provider");
    const token = c.req.header("x-git-token");

    if (!provider || !token) {
      return c.json({ error: "provider query and x-git-token header required" }, 400);
    }

    const vcs = vcsFromQuery(c.req.query());
    const git = createGitHostProvider(provider);
    const refs = await git.listRefs(vcs, token);

    return c.json({ refs });
  });

  app.post("/connect", async (c) => {
    let targetDir: string | undefined;
    let provider: string | undefined;

    try {
      const body = parseConnectBody(await c.req.json());
      provider = body.vcs.provider;
      targetDir = await mkdtemp(join(tmpdir(), `fig2code-connect-${body.vcs.provider}-`));

      const result = await onboardRemoteRepo({
        vcs: body.vcs,
        token: body.token,
        atlassianEmail: body.atlassianEmail,
        targetDir,
        writeConfig: true,
      });

      const response: ConnectResponseBody = {
        sessionId: randomUUID(),
        repoUrl: formatRepoUrl(body.vcs),
        detected: result.detected,
        syncConfig: result.syncConfig,
        refs: result.refs ?? [],
        workspacePath: targetDir,
      };

      return c.json(response);
    } catch (error) {
      if (targetDir) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
      }
      return repoError(c, error, { provider, upstream: true });
    }
  });

  app.post("/typography", async (c) => {
    try {
      const body = parseTypographyBody(await c.req.json());
      const typography = await buildTypographyConfigFromRemote(body);
      return c.json({ typography });
    } catch (error) {
      return repoError(c, error, { upstream: true });
    }
  });

  app.post("/tokens", async (c) => {
    try {
      const body = parseTokenBody(await c.req.json());
      const tokens = await buildTokenConfigFromRemote(body);
      return c.json({ tokens });
    } catch (error) {
      return repoError(c, error, { upstream: true });
    }
  });

  app.post("/detect/local", async (c) => {
    const body = (await c.req.json()) as {
      localPath: string;
      vcs: VcsConfig;
    };

    const result = await onboardLocalRepo({
      rootDir: body.localPath,
      vcs: body.vcs,
      writeConfig: false,
    });

    return c.json({
      detected: result.detected,
      syncConfig: result.syncConfig,
    });
  });

  app.post("/onboard/local", async (c) => {
    const body = (await c.req.json()) as {
      localPath: string;
      vcs: VcsConfig;
    };

    const result = await onboardLocalRepo({
      rootDir: body.localPath,
      vcs: body.vcs,
      writeConfig: true,
    });

    return c.json(result);
  });

  app.post("/onboard/remote", async (c) => {
    const body = (await c.req.json()) as {
      vcs: VcsConfig;
      token: string;
      targetDir: string;
    };

    const result = await onboardRemoteRepo({
      vcs: body.vcs,
      token: body.token,
      targetDir: body.targetDir,
      writeConfig: true,
    });

    return c.json(result);
  });

  // List repositories the token can access — powers the connect-time repo
  // picker so designers select instead of typing owner/repo by hand.
  app.post("/list", async (c) => {
    let provider: string | undefined;
    try {
      const body = (await c.req.json()) as {
        provider?: string;
        token?: string;
        atlassianEmail?: string;
      };
      provider = body.provider;
      if (!provider || !body.token?.trim()) {
        return c.json({ error: "provider and token are required" }, 400);
      }

      const git = createGitHostProvider(provider);
      const repositories = await git.listRepositories({
        token: body.token.trim(),
        atlassianEmail: body.atlassianEmail?.trim() || undefined,
      });
      return c.json({ repositories });
    } catch (err) {
      if (err instanceof GitHostApiError) {
        const status = err.status === 401 || err.status === 403 ? err.status : 502;
        return c.json({ error: formatGitHostApiError(err, provider ?? "github") }, status);
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to list repositories" },
        500,
      );
    }
  });

  app.post("/resolve-component", async (c) => {
    let provider: string | undefined;
    try {
      const raw = (await c.req.json()) as ResolveComponentRequestBody;
      const body = parseResolveComponentBody(raw);
      provider = body.vcs.provider;

      const clonePath = await repoCache.getOrClone(
        body.vcs,
        body.token,
        body.atlassianEmail,
      );

      const tracked = await listGitTrackedFiles(clonePath);
      const readFile = async (filePath: string): Promise<string | null> => {
        const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
        if (tracked && !tracked.has(normalized)) return null;
        try {
          return await readFs(join(clonePath, filePath), "utf-8");
        } catch {
          return null;
        }
      };

      const bundle = await resolveComponentBundle({
        componentName: body.componentName,
        figmaComponentKey: body.figmaComponentKey,
        figmaNodeId: body.figmaNodeId,
        syncConfig: body.syncConfig,
        detected: body.detected,
        registry: body.registry,
        readFile,
      });

      if (!bundle) {
        const response: ResolveComponentResponse = {
          matched: false,
          reason: `No matching files for "${body.componentName}" in repo`,
        };
        return c.json(response);
      }

      const { bundleId } = bundleStore.store(bundle);
      const response: ResolveComponentResponse = {
        matched: true,
        bundleId,
        bundle,
      };
      return c.json(response);
    } catch (error) {
      return repoError(c, error, { provider, upstream: true });
    }
  });

  app.get("/bundles/:id", (c) => {
    const bundle = bundleStore.get(c.req.param("id"));
    if (!bundle) {
      return c.json({ error: "Bundle not found or expired" }, 404);
    }
    return c.json({ bundle });
  });

  app.get("/fixtures", (c) =>
    c.json({
      tailwind: fixturePath("tailwind-app"),
      styled: fixturePath("styled-app"),
    }),
  );

  return app;
}

interface ResolveComponentRequestBody {
  vcs: VcsConfig;
  token: string;
  atlassianEmail?: string;
  componentName: string;
  figmaComponentKey?: string;
  figmaNodeId?: string;
  syncConfig: SyncConfig;
  detected?: DetectedProjectConfig;
  registry?: Registry;
}

function parseResolveComponentBody(raw: ResolveComponentRequestBody): ResolveComponentRequestBody {
  if (!raw?.componentName?.trim()) {
    throw new Error("componentName is required");
  }
  if (!raw?.token?.trim()) {
    throw new Error("token is required");
  }
  if (!raw?.vcs?.provider) {
    throw new Error("vcs.provider is required");
  }
  if (!raw?.syncConfig) {
    throw new Error("syncConfig is required");
  }

  raw.componentName = raw.componentName.trim();
  raw.token = raw.token.trim();
  raw.atlassianEmail = raw.atlassianEmail?.trim() || undefined;
  raw.vcs.baseBranch = raw.vcs.baseBranch?.trim() || "main";
  raw.vcs.defaultPrTarget = raw.vcs.defaultPrTarget?.trim() || raw.vcs.baseBranch;

  return raw;
}

function parseConnectBody(raw: unknown): ConnectRequestBody {
  const body = raw as ConnectRequestBody;

  if (!body?.token?.trim()) {
    throw new Error("token is required");
  }

  if (!body?.vcs?.provider) {
    throw new Error("vcs.provider is required");
  }

  if (body.vcs.provider === "github") {
    if (!body.vcs.owner?.trim() || !body.vcs.repo?.trim()) {
      throw new Error("GitHub requires owner and repo");
    }
  }

  if (body.vcs.provider === "bitbucket") {
    if (!body.vcs.workspace?.trim() || !body.vcs.repo?.trim()) {
      throw new Error("Bitbucket requires workspace and repo");
    }
  }

  body.token = body.token.trim();
  body.atlassianEmail = body.atlassianEmail?.trim() || undefined;

  body.vcs.baseBranch = body.vcs.baseBranch?.trim() || "main";
  body.vcs.defaultPrTarget = body.vcs.defaultPrTarget?.trim() || body.vcs.baseBranch;

  return body;
}

function parseTokenPaths(raw: unknown): string[] {
  const source = raw as { tokenPaths?: unknown; tokenPath?: unknown };

  if (Array.isArray(source.tokenPaths)) {
    const paths = source.tokenPaths.map(String).map((entry) => entry.trim()).filter(Boolean);
    if (paths.length > 0) {
      return paths;
    }
  }

  if (typeof source.tokenPath === "string" && source.tokenPath.trim()) {
    return source.tokenPath
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  throw new Error("tokenPaths array is required");
}

function parseTypographyBody(raw: unknown) {
  const body = parseConnectBody(raw) as ConnectRequestBody & {
    fontPaths: string[];
    tokenPaths?: string[];
    tokenPath?: string;
    tailwindConfigPath?: string;
    styleSystem?: DetectedProjectConfig["styleSystem"];
  };

  const source = raw as {
    fontPaths?: string[];
    tokenPaths?: string[];
    tokenPath?: string;
    tailwindConfigPath?: string;
    styleSystem?: DetectedProjectConfig["styleSystem"];
  };

  if (!Array.isArray(source.fontPaths)) {
    throw new Error("fontPaths array is required");
  }

  return {
    vcs: body.vcs,
    token: body.token,
    atlassianEmail: body.atlassianEmail,
    fontPaths: source.fontPaths.map(String).filter(Boolean),
    tokenPaths: parseTokenPaths(source),
    tailwindConfigPath: source.tailwindConfigPath?.trim() || undefined,
    styleSystem: source.styleSystem,
  };
}

function parseTokenBody(raw: unknown) {
  const body = parseConnectBody(raw) as ConnectRequestBody & {
    tokenPaths: string[];
    fontPaths?: string[];
    tailwindConfigPath?: string;
    styleSystem?: DetectedProjectConfig["styleSystem"];
    typographyCatalog?: TypographyCatalog;
  };

  const source = raw as {
    tokenPaths?: string[];
    tokenPath?: string;
    fontPaths?: string[];
    tailwindConfigPath?: string;
    styleSystem?: DetectedProjectConfig["styleSystem"];
    typographyCatalog?: TypographyCatalog;
  };

  return {
    vcs: body.vcs,
    token: body.token,
    atlassianEmail: body.atlassianEmail,
    tokenPaths: parseTokenPaths(source),
    fontPaths: Array.isArray(source.fontPaths)
      ? source.fontPaths.map(String).map((entry) => entry.trim()).filter(Boolean)
      : undefined,
    tailwindConfigPath: source.tailwindConfigPath?.trim() || undefined,
    styleSystem: source.styleSystem,
    typographyCatalog: source.typographyCatalog,
  };
}

function gitAuth(body: ConnectRequestBody) {
  return {
    token: body.token,
    atlassianEmail: body.atlassianEmail,
  };
}

export function formatRepoUrl(vcs: VcsConfig): string {
  switch (vcs.provider) {
    case "github":
      return `github.com/${vcs.owner}/${vcs.repo}`;
    case "bitbucket":
      return `bitbucket.org/${vcs.workspace}/${vcs.repo}`;
    case "gitlab":
      return `gitlab.com/${vcs.projectIdOrPath}`;
  }
}

function vcsFromQuery(query: Record<string, string | undefined>): VcsConfig {
  if (query.provider === "github") {
    return {
      provider: "github",
      owner: query.owner ?? "",
      repo: query.repo ?? "",
      baseBranch: query.baseBranch ?? "main",
      defaultPrTarget: query.defaultPrTarget ?? query.baseBranch ?? "main",
    };
  }

  if (query.provider === "bitbucket") {
    return {
      provider: "bitbucket",
      workspace: query.workspace ?? "",
      repo: query.repo ?? "",
      baseBranch: query.baseBranch ?? "main",
      defaultPrTarget: query.defaultPrTarget ?? query.baseBranch ?? "main",
    };
  }

  throw new Error(`Unsupported provider ${query.provider}`);
}

function repoError(
  c: { json: (data: unknown, status?: number) => Response },
  error: unknown,
  options: { provider?: string; upstream?: boolean } = {},
) {
  if (error instanceof GitHostApiError) {
    const status =
      error.status === 401 || error.status === 403
        ? error.status
        : options.upstream
          ? 502
          : 500;
    return c.json(
      { error: formatGitHostApiError(error, options.provider) },
      status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const validation =
    message.includes("required") ||
    message.includes("requires") ||
    message.includes("Unsupported provider");

  if (validation) {
    return c.json({ error: message }, 400);
  }

  return c.json({ error: message }, options.upstream ? 502 : 500);
}
