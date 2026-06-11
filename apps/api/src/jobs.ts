import { Hono } from "hono";
import type { EnqueueJobRequest, FilePatch, JobRecord, VcsConfig } from "@fig2code/spec";
import { GitHostApiError, formatGitHostApiError } from "@fig2code/git-host";
import { openJobPullRequest, openPullRequestFromPatches } from "./open-job-pr.js";
import {
  createJobStore,
  type JobStore,
  validatePrunedSpec,
} from "./job-store.js";
import {
  createPreviewSessionManager,
  type PreviewSession,
} from "./preview-session.js";
import { createRepoCloneCache, repoPreviewSessionId, type RepoCloneCache } from "./repo-cache.js";
import type { Context } from "hono";

export interface JobsRouterOptions {
  store?: JobStore;
  workerSecret?: string;
  onCleanup?: (fn: () => Promise<void>) => void;
  repoCache?: RepoCloneCache;
}

const PASS_THROUGH_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "content-encoding",
  "access-control-allow-origin",
];

/** Preserve query strings (e.g. Vite `?import` asset transforms) when forwarding to the dev server. */
export function buildViteProxyTargetUrl(
  previewUrl: string,
  requestUrl: string,
): string {
  const incoming = new URL(requestUrl);
  const viteBase = new URL(previewUrl);
  return `${viteBase.origin}${incoming.pathname}${incoming.search}`;
}

function incomingPathFrom(requestUrl: string): string {
  const incoming = new URL(requestUrl);
  return `${incoming.pathname}${incoming.search}`;
}

/**
 * Re-stream Vite's response body while containing mid-stream failures. If the
 * upstream socket dies (e.g. the Vite child is OOM-killed) or the client aborts,
 * undici throws `terminated`/`UND_ERR_SOCKET`. Caught here, it just ends the
 * stream cleanly instead of bubbling up as an unhandled rejection that could
 * crash the whole API process.
 */
function guardedProxyStream(
  upstream: ReadableStream<Uint8Array> | null,
  label: string,
): ReadableStream<Uint8Array> | null {
  if (!upstream) return null;
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        console.warn(
          `[fig2code] proxy stream aborted for ${label}:`,
          err instanceof Error ? err.message : err,
        );
        controller.close();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

async function proxyToVite(
  c: Context,
  session: PreviewSession,
  hooks?: {
    recover?: (sessionId: string) => Promise<boolean>;
    getSession?: (sessionId: string) => PreviewSession | undefined;
  },
): Promise<Response> {
  const targetUrl = buildViteProxyTargetUrl(session.previewUrl, c.req.url);
  try {
    const forwardHeaders = new Headers();
    const accept = c.req.header("accept");
    if (accept) {
      forwardHeaders.set("Accept", accept);
    }

    const viteRes = await fetch(targetUrl, {
      method: c.req.method,
      headers: forwardHeaders,
      // Forward the client's abort so a closed browser/iframe cleanly cancels
      // the upstream request instead of leaving undici to throw "terminated".
      signal: c.req.raw.signal,
    });

    const headers = new Headers();
    for (const key of PASS_THROUGH_HEADERS) {
      const val = viteRes.headers.get(key);
      if (val) headers.set(key, val);
    }
    headers.set("access-control-allow-origin", "*");

    if (viteRes.status >= 400) {
      const errorBody = await viteRes.text();
      console.error(
        `[fig2code] vite ${viteRes.status} for ${incomingPathFrom(c.req.url)}:`,
        errorBody.slice(0, 2000),
      );
      return new Response(errorBody, { status: viteRes.status, headers });
    }

    return new Response(guardedProxyStream(viteRes.body, incomingPathFrom(c.req.url)), {
      status: viteRes.status,
      headers,
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined) : undefined;
    const code = cause?.code;
    const isConnectionError =
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "UND_ERR_SOCKET";

    if (hooks?.recover && hooks.getSession && isConnectionError) {
      console.warn(`[fig2code] vite unreachable for ${session.jobId} — recovering`);
      const recovered = await hooks.recover(session.jobId);
      if (recovered) {
        const fresh = hooks.getSession(session.jobId);
        if (fresh) {
          return proxyToVite(c, fresh, hooks);
        }
      }
      return new Response("Preview updating…", {
        status: 503,
        headers: { "Retry-After": "1" },
      });
    }

    console.error(`[fig2code] proxy error: ${targetUrl}`, err);
    return c.json({ error: "Proxy error" }, 502);
  }
}

export function createJobsRouter(options: JobsRouterOptions = {}): Hono {
  const store = options.store ?? createJobStore();
  const workerSecret = options.workerSecret ?? process.env.WORKER_SECRET ?? "dev-worker-secret";
  const repoCache = options.repoCache ?? createRepoCloneCache();
  const previewSessions = createPreviewSessionManager(repoCache);
  options.onCleanup?.(() => Promise.all([previewSessions.stopAll(), repoCache.evictAll()]).then(() => {}));

  const previewProxyHooks = {
    recover: (sessionId: string) => previewSessions.recoverVite(sessionId),
    getSession: (sessionId: string) => previewSessions.getSession(sessionId),
  };

  const app = new Hono();

  app.post("/jobs", async (c) => {
    const body = (await c.req.json()) as EnqueueJobRequest;
    const gitToken = c.req.header("x-git-token")?.trim();

    if (!gitToken) {
      return c.json({ error: "x-git-token header is required" }, 400);
    }

    if (!body?.sessionId?.trim()) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    if (!body?.vcs?.provider) {
      return c.json({ error: "vcs.provider is required" }, 400);
    }

    if (!body?.syncConfig?.platforms?.length) {
      return c.json({ error: "syncConfig.platforms is required" }, 400);
    }

    const specError = validatePrunedSpec(body.prunedSpec);
    if (specError) {
      return c.json({ error: specError }, 400);
    }

    console.log("[fig2code] job enqueue", {
      sessionId: body.sessionId,
      provider: body.vcs.provider,
      component: body.prunedSpec.name,
      kind: body.prunedSpec.kind,
      variants: body.prunedSpec.variants,
      slots: body.prunedSpec.slots,
      styleKeys: Object.keys(body.prunedSpec.styles ?? {}),
      iconPath: body.syncConfig.web?.iconPath,
      componentPath: body.syncConfig.web?.componentPath,
      modelId: body.syncConfig.llm?.modelId,
    });

    const job = store.enqueue(body, {
      gitToken,
      atlassianEmail: c.req.header("x-atlassian-email")?.trim() || undefined,
      llmToken: c.req.header("x-llm-token")?.trim() || undefined,
    });

    return c.json(job, 202);
  });

  app.get("/jobs/:id", (c) => {
    const job = store.get(c.req.param("id"));
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }
    return c.json(job);
  });

  app.post("/jobs/:id/pull-request", async (c) => {
    const gitToken = c.req.header("x-git-token")?.trim();
    if (!gitToken) {
      return c.json({ error: "x-git-token header is required" }, 400);
    }

    const stored = store.getStored(c.req.param("id"));
    if (!stored) {
      return c.json({ error: "Job not found" }, 404);
    }

    if (stored.status !== "validated" && stored.status !== "pr_opened") {
      return c.json({ error: "Job must be validated before opening a pull request" }, 409);
    }

    if (stored.prUrl) {
      return c.json(store.get(c.req.param("id"))!);
    }

    const body = (await c.req.json()) as {
      targetBranch?: string;
      patches?: FilePatch[];
      previewFileOverrides?: Array<{ path: string; role: string; content: string }>;
    };

    const targetBranch =
      body.targetBranch?.trim() ||
      stored.request.vcs.defaultPrTarget ||
      stored.request.vcs.baseBranch;

    if (!targetBranch) {
      return c.json({ error: "targetBranch is required" }, 400);
    }

    try {
      const repoClonePath = await repoCache.getOrClone(
        stored.request.vcs,
        gitToken,
        c.req.header("x-atlassian-email")?.trim() || stored.secrets.atlassianEmail,
      );

      const result = await openJobPullRequest({
        stored: {
          ...stored,
          secrets: {
            ...stored.secrets,
            gitToken,
            atlassianEmail:
              c.req.header("x-atlassian-email")?.trim() || stored.secrets.atlassianEmail,
          },
        },
        targetBranch,
        patches: body.patches,
        previewFileOverrides: body.previewFileOverrides,
        repoClonePath,
      });

      const updated = store.update(c.req.param("id"), {
        status: "pr_opened",
        prUrl: result.prUrl,
      });

      console.log("[fig2code] pull request opened", {
        jobId: stored.id,
        targetBranch,
        headBranch: result.headBranch,
        prUrl: result.prUrl,
      });

      return c.json(updated);
    } catch (err) {
      console.error("[fig2code] pull request failed", err);
      if (err instanceof GitHostApiError) {
        const provider = stored.request.vcs.provider;
        const status = err.status === 401 || err.status === 403 ? err.status : 502;
        return c.json(
          {
            error: formatGitHostApiError(err, provider),
          },
          status,
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to open pull request" },
        500,
      );
    }
  });

  // Open a pull request directly from a set of patches, with no backing codegen
  // job. Used by update mode when a designer manually edits an existing
  // component and pushes those edits as a PR. The repo is the source of truth,
  // so everything needed (vcs config, patches) comes in on the request.
  app.post("/pull-request", async (c) => {
    const gitToken = c.req.header("x-git-token")?.trim();
    if (!gitToken) {
      return c.json({ error: "x-git-token header is required" }, 400);
    }

    const body = (await c.req.json()) as {
      vcs?: VcsConfig;
      componentName?: string;
      targetBranch?: string;
      patches?: FilePatch[];
      branchSuffix?: string;
      formatter?: EnqueueJobRequest["syncConfig"]["conventions"]["formatter"];
    };

    if (!body.vcs?.provider) {
      return c.json({ error: "vcs is required" }, 400);
    }

    const componentName = body.componentName?.trim();
    if (!componentName) {
      return c.json({ error: "componentName is required" }, 400);
    }

    if (!body.patches?.length) {
      return c.json({ error: "patches are required" }, 400);
    }

    const targetBranch =
      body.targetBranch?.trim() || body.vcs.defaultPrTarget || body.vcs.baseBranch;
    if (!targetBranch) {
      return c.json({ error: "targetBranch is required" }, 400);
    }

    const atlassianEmail = c.req.header("x-atlassian-email")?.trim() || undefined;

    try {
      const repoClonePath = await repoCache.getOrClone(body.vcs, gitToken, atlassianEmail);

      const result = await openPullRequestFromPatches({
        vcs: body.vcs,
        auth: { token: gitToken, atlassianEmail },
        componentName,
        targetBranch,
        patches: body.patches,
        branchSuffix: body.branchSuffix?.trim() || `${componentName}-${targetBranch}`,
        formatter: body.formatter,
        repoClonePath,
      });

      console.log("[fig2code] manual pull request opened", {
        component: componentName,
        targetBranch,
        headBranch: result.headBranch,
        prUrl: result.prUrl,
      });

      return c.json({ prUrl: result.prUrl, prNumber: result.prNumber, headBranch: result.headBranch });
    } catch (err) {
      console.error("[fig2code] manual pull request failed", err);
      if (err instanceof GitHostApiError) {
        const status = err.status === 401 || err.status === 403 ? err.status : 502;
        return c.json({ error: formatGitHostApiError(err, body.vcs.provider) }, status);
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to open pull request" },
        500,
      );
    }
  });

  app.get("/jobs/:id/preview", async (c) => {
    const stored = store.getStored(c.req.param("id"));
    if (!stored) {
      return c.json({ error: "Job not found" }, 404);
    }
    if (stored.status !== "validated" || !stored.buildPreview) {
      return c.json({ error: "Preview is available after a validated build" }, 404);
    }

    let session = previewSessions.getSession(c.req.param("id"));

    if (!session) {
      try {
        session = await previewSessions.startSession(c.req.param("id"), stored.buildPreview, {
          tokenCatalog: stored.request.syncConfig.tokens?.catalog,
          vcs: stored.request.vcs,
          gitToken: stored.secrets.gitToken,
          atlassianEmail: stored.secrets.atlassianEmail,
          formatter: stored.request.syncConfig.conventions.formatter,
          tokenPaths: stored.request.syncConfig.web?.tokenPaths,
          themeCatalog: stored.request.syncConfig.themes,
          themeSelection: stored.request.prunedSpec.metadata?.previewTheme,
        });
      } catch (err) {
        console.error("[fig2code] preview session start failed", err);
        return c.json({ error: "Failed to start preview server" }, 500);
      }
    }

    if (!session.ready) {
      return c.html(previewLoadingHtml(stored.buildPreview.componentName));
    }

    // Codegen sessions share one Vite server per repo under a stable base path;
    // redirect there so asset URLs resolve regardless of which job triggered it.
    return c.redirect(session.basePath ?? `/jobs/${c.req.param("id")}/preview/`, 302);
  });

  // The proxy routes resolve by active session only (the id may be the stable
  // base-path id of a reused session, not a currently-stored job).
  app.get("/jobs/:id/preview/", async (c) => {
    const session = previewSessions.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "No active preview session" }, 404);

    return proxyToVite(c, session);
  });

  app.all("/jobs/:id/preview/*", async (c) => {
    const session = previewSessions.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "No active preview session" }, 404);

    return proxyToVite(c, session);
  });

  app.post("/jobs/:id/preview/theme", async (c) => {
    const session = previewSessions.getSession(c.req.param("id"));
    if (!session) {
      return c.json({ error: "No active preview session" }, 404);
    }

    const body = (await c.req.json()) as { brand?: string; mode?: string };
    try {
      const selection = await previewSessions.updatePreviewTheme(c.req.param("id"), body);
      return c.json({ selection });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.put("/jobs/:id/preview/files", async (c) => {
    const stored = store.getStored(c.req.param("id"));
    if (!stored) {
      return c.json({ error: "Job not found" }, 404);
    }

    const session = previewSessions.getSession(c.req.param("id"));
    if (!session) {
      return c.json({ error: "No active preview session" }, 404);
    }

    const body = (await c.req.json()) as { path: string; content: string };
    if (!body?.path || typeof body.content !== "string") {
      return c.json({ error: "path and content are required" }, 400);
    }

    try {
      await previewSessions.writeFile(c.req.param("id"), body.path, body.content);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.delete("/jobs/:id/preview", async (c) => {
    await previewSessions.stopSession(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Existing component preview (no codegen / no token burn)
  // ---------------------------------------------------------------------------

  app.post("/preview/existing", async (c) => {
    const gitToken = c.req.header("x-git-token")?.trim();
    if (!gitToken) {
      return c.json({ error: "x-git-token header is required" }, 400);
    }

    const body = (await c.req.json()) as {
      vcs: import("@fig2code/spec").VcsConfig;
      componentPath: string;
      componentName: string;
      storyPath?: string;
      atlassianEmail?: string;
      tokenPaths?: string[];
      themeCatalog?: import("@fig2code/spec").ThemeCatalog | null;
      themeSelection?: import("@fig2code/spec").PreviewThemeContext;
    };

    if (!body?.vcs?.provider || !body?.componentPath || !body?.componentName) {
      return c.json({ error: "vcs, componentPath, and componentName are required" }, 400);
    }

    const sessionId = repoPreviewSessionId(body.vcs);

    try {
      const { session, reused } = await previewSessions.openExistingPreview(sessionId, {
        componentPath: body.componentPath,
        componentName: body.componentName,
        storyPath: body.storyPath,
        vcs: body.vcs,
        gitToken,
        atlassianEmail: body.atlassianEmail,
        tokenPaths: body.tokenPaths,
        themeCatalog: body.themeCatalog,
        themeSelection: body.themeSelection,
      });

      return c.json({
        sessionId,
        previewUrl: `/preview/existing/${sessionId}/`,
        viteUrl: session.previewUrl,
        reused,
      });
    } catch (err) {
      console.error("[fig2code] existing preview start failed", err);
      return c.json({ error: "Failed to start existing component preview" }, 500);
    }
  });

  app.get("/preview/existing/:sessionId", async (c) => {
    return c.redirect(`/preview/existing/${c.req.param("sessionId")}/`, 302);
  });

  app.get("/preview/existing/:sessionId/", async (c) => {
    const session = previewSessions.getSession(c.req.param("sessionId"));
    if (!session) return c.json({ error: "Preview session not found" }, 404);
    if (!session.ready) {
      return new Response("Preview updating…", {
        status: 503,
        headers: { "Retry-After": "1" },
      });
    }
    return proxyToVite(c, session, previewProxyHooks);
  });

  app.post("/preview/existing/:sessionId/theme", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = previewSessions.getSession(sessionId);
    if (!session) {
      return c.json({ error: "No active preview session" }, 404);
    }

    const body = (await c.req.json()) as { brand?: string; mode?: string };
    try {
      const selection = await previewSessions.updatePreviewTheme(sessionId, body);
      return c.json({ selection });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.put("/preview/existing/:sessionId/files", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = previewSessions.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Preview session not found" }, 404);
    }

    const body = (await c.req.json()) as { path: string; content: string };
    if (!body?.path || typeof body.content !== "string") {
      return c.json({ error: "path and content are required" }, 400);
    }

    try {
      await previewSessions.writeFile(sessionId, body.path, body.content);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.all("/preview/existing/:sessionId/*", async (c) => {
    const session = previewSessions.getSession(c.req.param("sessionId"));
    if (!session) return c.json({ error: "Preview session not found" }, 404);
    if (!session.ready) {
      return new Response("Preview updating…", {
        status: 503,
        headers: { "Retry-After": "1" },
      });
    }
    return proxyToVite(c, session, previewProxyHooks);
  });

  app.delete("/preview/existing/:sessionId", async (c) => {
    await previewSessions.stopSession(c.req.param("sessionId"));
    return c.json({ ok: true });
  });

  const worker = new Hono();

  worker.use("*", async (c, next) => {
    const provided = c.req.header("x-worker-secret");
    if (provided !== workerSecret) {
      return c.json({ error: "Unauthorized worker" }, 401);
    }
    await next();
  });

  worker.post("/claim", (c) => {
    const claimed = store.claimNext();
    if (!claimed) {
      return c.json({ job: null });
    }
    return c.json({ job: claimed });
  });

  worker.patch("/jobs/:id", async (c) => {
    const patch = (await c.req.json()) as Partial<JobRecord>;
    const updated = store.update(c.req.param("id"), patch);
    if (!updated) {
      return c.json({ error: "Job not found" }, 404);
    }
    return c.json(updated);
  });

  app.route("/internal/worker", worker);

  return app;
}

function previewLoadingHtml(componentName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="2" />
  <title>${componentName} · Starting preview…</title>
  <style>
    body {
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      font-family: Inter, system-ui, sans-serif;
      background: #f8fafc;
      color: #6b7280;
    }
    .loader {
      text-align: center;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid #e5e7eb;
      border-top-color: #6b7280;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="loader">
    <div class="spinner"></div>
    <div>Setting up preview for ${componentName}…</div>
  </div>
</body>
</html>`;
}
