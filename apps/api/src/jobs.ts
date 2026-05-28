import { Hono } from "hono";
import type { EnqueueJobRequest, JobRecord } from "@fig2code/spec";
import {
  createJobStore,
  type JobStore,
  validatePrunedSpec,
} from "./job-store.js";
import {
  createPreviewSessionManager,
  type PreviewSession,
} from "./preview-session.js";
import { createRepoCloneCache, type RepoCloneCache } from "./repo-cache.js";
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

async function proxyToVite(
  c: Context,
  session: PreviewSession,
): Promise<Response> {
  const reqPath = c.req.path;
  const targetUrl = `${session.previewUrl}${reqPath}`;
  try {
    const viteRes = await fetch(targetUrl, {
      method: c.req.method,
      headers: { Accept: c.req.header("accept") ?? "*/*" },
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
        `[fig2code] vite ${viteRes.status} for ${reqPath}:`,
        errorBody.slice(0, 2000),
      );
      return new Response(errorBody, { status: viteRes.status, headers });
    }

    return new Response(viteRes.body as ReadableStream, {
      status: viteRes.status,
      headers,
    });
  } catch (err) {
    console.error(`[fig2code] proxy error: ${targetUrl}`, err);
    return c.json({ error: "Proxy error" }, 502);
  }
}

function previewSessionSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "component";
}

export function createJobsRouter(options: JobsRouterOptions = {}): Hono {
  const store = options.store ?? createJobStore();
  const workerSecret = options.workerSecret ?? process.env.WORKER_SECRET ?? "dev-worker-secret";
  const repoCache = options.repoCache ?? createRepoCloneCache();
  const previewSessions = createPreviewSessionManager(repoCache);
  options.onCleanup?.(() => Promise.all([previewSessions.stopAll(), repoCache.evictAll()]).then(() => {}));

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
        });
      } catch (err) {
        console.error("[fig2code] preview session start failed", err);
        return c.json({ error: "Failed to start preview server" }, 500);
      }
    }

    if (!session.ready) {
      return c.html(previewLoadingHtml(stored.buildPreview.componentName));
    }

    return c.redirect(`/jobs/${c.req.param("id")}/preview/`, 302);
  });

  app.get("/jobs/:id/preview/", async (c) => {
    const stored = store.getStored(c.req.param("id"));
    if (!stored) return c.json({ error: "Not found" }, 404);

    const session = previewSessions.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "No active preview session" }, 404);

    return proxyToVite(c, session);
  });

  app.all("/jobs/:id/preview/*", async (c) => {
    const stored = store.getStored(c.req.param("id"));
    if (!stored) return c.json({ error: "Not found" }, 404);

    const session = previewSessions.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "No active preview session" }, 404);

    return proxyToVite(c, session);
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
    };

    if (!body?.vcs?.provider || !body?.componentPath || !body?.componentName) {
      return c.json({ error: "vcs, componentPath, and componentName are required" }, 400);
    }

    const sessionId = `existing-${previewSessionSlug(body.componentName)}-${Date.now()}`;

    try {
      const session = await previewSessions.startExistingSession(sessionId, {
        componentPath: body.componentPath,
        componentName: body.componentName,
        storyPath: body.storyPath,
        vcs: body.vcs,
        gitToken,
        atlassianEmail: body.atlassianEmail,
        tokenPaths: body.tokenPaths,
      });

      return c.json({
        sessionId,
        previewUrl: `/preview/existing/${sessionId}/`,
        viteUrl: session.previewUrl,
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
    return proxyToVite(c, session);
  });

  app.all("/preview/existing/:sessionId/*", async (c) => {
    const session = previewSessions.getSession(c.req.param("sessionId"));
    if (!session) return c.json({ error: "Preview session not found" }, 404);
    return proxyToVite(c, session);
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
