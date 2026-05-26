import { Hono } from "hono";
import { buildStorybookPreviewHtml, parsePreviewVariantQuery } from "@fig2code/codegen";
import type { EnqueueJobRequest, JobRecord } from "@fig2code/spec";
import {
  createJobStore,
  type JobStore,
  validatePrunedSpec,
} from "./job-store.js";
import { loadPreviewDependencies } from "./preview-resolver.js";

export interface JobsRouterOptions {
  store?: JobStore;
  workerSecret?: string;
}

export function createJobsRouter(options: JobsRouterOptions = {}): Hono {
  const store = options.store ?? createJobStore();
  const workerSecret = options.workerSecret ?? process.env.WORKER_SECRET ?? "dev-worker-secret";

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

    const dependencies = await loadPreviewDependencies(stored, stored.buildPreview);
    const selectedVariants = parsePreviewVariantQuery(c.req.query(), stored.buildPreview.variants);
    const html = buildStorybookPreviewHtml(stored.buildPreview, dependencies, {
      selectedVariants,
      tokenCss: stored.buildPreview.tokenCss,
    });
    if (!html) {
      return c.json({ error: "Generated component preview is unavailable for this job" }, 404);
    }

    return c.html(html);
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
