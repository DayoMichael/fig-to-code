import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { CapabilitiesResponse } from "@fig2code/spec";
import { MODEL_CATALOG } from "@fig2code/llm";
import { createReposRouter } from "./repos.js";
import { createJobsRouter } from "./jobs.js";
import { createRepoCloneCache } from "./repo-cache.js";

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
    allowHeaders: ["Content-Type", "x-git-token", "x-atlassian-email", "x-llm-token", "x-worker-secret"],
    maxAge: 86_400,
  }),
);

const repoCache = createRepoCloneCache();
app.route("/repos", createReposRouter({ repoCache }));
app.route("/", createJobsRouter({ repoCache }));

app.get("/health", (c) => c.json({ ok: true, service: "fig2code-api" }));

app.get("/capabilities", (c) => {
  const response: CapabilitiesResponse = {
    models: MODEL_CATALOG.map((model) => ({
      provider: model.provider,
      modelId: model.modelId,
      label: model.label,
      maxContextHint: model.maxContextHint,
    })),
    gitHosts: [
      { provider: "github", label: "GitHub", authMethods: ["pat", "oauth", "github_app"] },
      { provider: "bitbucket", label: "Bitbucket Cloud", authMethods: ["api_token", "oauth"] },
      { provider: "gitlab", label: "GitLab", authMethods: ["pat", "oauth"] },
    ],
  };
  return c.json(response);
});

const port = Number(process.env.PORT ?? 3000);

if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Fig2Code API listening on http://localhost:${port}`);
  });
}

export default app;
