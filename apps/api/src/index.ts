import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { CapabilitiesResponse } from "@fig2code/spec";
import { MODEL_CATALOG } from "@fig2code/llm";
import { createReposRouter } from "./repos.js";
import { createJobsRouter } from "./jobs.js";
import { createAuthRouter, resolveOAuthProviders } from "./auth.js";
import { createRepoCloneCache } from "./repo-cache.js";
import { startHealthWatchdog } from "./watchdog.js";

// A mid-stream proxy failure (e.g. an OOM-killed Vite child closing its socket)
// surfaces as an undici "terminated"/UND_ERR_SOCKET rejection. Log and keep the
// API alive rather than letting one bad preview stream take the server down.
process.on("unhandledRejection", (reason) => {
  console.error("[fig2code] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fig2code] uncaughtException:", err);
});

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => origin ?? "*",
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-git-token", "x-atlassian-email", "x-llm-token", "x-worker-secret", "x-job-token"],
    maxAge: 86_400,
  }),
);

// A client configured with a trailing-slash API base produces `//jobs/...`
// paths that match no route. Collapse duplicate slashes and redirect (307
// preserves method + body) instead of dead-ending in a bare 404. Runs after
// cors() so the redirect response still carries CORS headers.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (/\/{2,}/.test(url.pathname)) {
    const normalized = url.pathname.replace(/\/{2,}/g, "/");
    return c.redirect(`${normalized}${url.search}`, 307);
  }
  await next();
});

app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  return c.json(
    {
      error: `No route for ${c.req.method} ${pathname}. Check the plugin's API base URL (no trailing slash, e.g. http://localhost:${process.env.PORT ?? 3000}).`,
    },
    404,
  );
});

const repoCache = createRepoCloneCache();
app.route("/repos", createReposRouter({ repoCache }));
app.route("/auth", createAuthRouter());
app.route("/", createJobsRouter({ repoCache }));

app.get("/health", (c) => c.json({ ok: true, service: "fig2code-api" }));

const oauthProviders = resolveOAuthProviders();

app.get("/capabilities", (c) => {
  const response: CapabilitiesResponse = {
    models: MODEL_CATALOG.map((model) => ({
      provider: model.provider,
      modelId: model.modelId,
      label: model.label,
      maxContextHint: model.maxContextHint,
    })),
    // Advertise only what is actually available on THIS deployment: PAT/API
    // tokens always work; OAuth appears only when the server has provider app
    // credentials configured, so the plugin never offers a flow that can't
    // complete.
    gitHosts: [
      {
        provider: "github",
        label: "GitHub",
        authMethods: ["pat", ...(oauthProviders.github ? ["oauth" as const] : [])],
      },
      {
        provider: "bitbucket",
        label: "Bitbucket Cloud",
        authMethods: ["api_token", ...(oauthProviders.bitbucket ? ["oauth" as const] : [])],
      },
    ],
  };
  return c.json(response);
});

const port = Number(process.env.PORT ?? 3000);

if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Fig2Code API listening on http://localhost:${port}`);
    startHealthWatchdog({ port });
  });
}

export default app;
