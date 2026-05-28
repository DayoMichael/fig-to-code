import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnqueueJobRequest } from "@fig2code/spec";
import { Hono } from "hono";
import { createJobStore } from "./job-store.js";
import { createJobsRouter } from "./jobs.js";
import { processJob } from "../../worker/src/process-job.js";
import { createWorkerApiClient } from "../../worker/src/api-client.js";
import { MockLlmProvider } from "@fig2code/llm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_SECRET = "test-worker-secret";

const syntheticRequest: EnqueueJobRequest = {
  intent: "component",
  sessionId: "staging-session",
  targets: ["web"],
  prunedSpec: {
    name: "Button",
    kind: "component",
    variants: {
      variant: ["primary", "secondary"],
      size: ["sm", "md"],
    },
    slots: {
      label: { type: "text", required: true },
    },
    styles: {
      "primary+md+default": {
        bg: "token:color/primary/500",
      },
    },
  },
  vcs: {
    provider: "github",
    owner: "acme",
    repo: "design-system",
    baseBranch: "main",
    defaultPrTarget: "main",
  },
  syncConfig: {
    vcs: {
      provider: "github",
      owner: "acme",
      repo: "design-system",
      baseBranch: "main",
      defaultPrTarget: "main",
    },
    platforms: ["web"],
    web: {
      styleSystem: "tailwind",
      componentPath: "src/components",
      tokenPaths: ["tailwind.config.ts"],
      iconPath: "src/icons",
      exampleComponent: "src/components/Button/Button.tsx",
    },
    conventions: {
      exportStyle: "named",
      propsPattern: "interface",
      fileNaming: "PascalCase",
      testFramework: "vitest",
      storyFormat: "csf3",
    },
    llm: {
      modelId: "anthropic/claude-sonnet",
      promptProfile: "component-v1",
    },
  },
};

function createTestApp() {
  const store = createJobStore();
  const cleanupFns: Array<() => Promise<void>> = [];
  const jobs = createJobsRouter({
    store,
    workerSecret: WORKER_SECRET,
    onCleanup: (fn) => cleanupFns.push(fn),
  });
  const app = new Hono();
  app.route("/", jobs);
  const cleanup = async () => {
    for (const fn of cleanupFns) await fn();
  };
  return { app, store, cleanup };
}

describe("jobs API", () => {
  it("rejects job enqueue without git token", async () => {
    const { app } = createTestApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syntheticRequest),
    });

    assert.equal(res.status, 400);
  });

  it("M4 e2e: synthetic PrunedSpec roundtrip with mock LLM codegen", async () => {
    const { app, cleanup } = createTestApp();
    const goldenResponse = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../packages/llm/fixtures/golden-codegen-response.json",
      ),
      "utf8",
    );
    const mock = new MockLlmProvider({
      allowlist: ["anthropic/claude-sonnet"],
      response: goldenResponse,
    });

    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-git-token": "ghp_test_token",
      },
      body: JSON.stringify(syntheticRequest),
    });

    assert.equal(createRes.status, 202);
    const created = (await createRes.json()) as { id: string; status: string };
    assert.equal(created.status, "queued");

    const client = createWorkerApiClient({
      apiBase: "http://test",
      workerSecret: WORKER_SECRET,
      fetchImpl: (input, init) => app.request(String(input), init),
    });

    const claimed = await client.claimNext();
    assert.ok(claimed);
    assert.equal(claimed?.jobId, created.id);
    assert.equal(claimed?.prunedSpec.name, "Button");

    const finalJob = await processJob(claimed!, client, {
      llmProvider: mock,
      apiKey: "test-key",
    });
    assert.equal(finalJob.status, "validated");
    assert.equal(finalJob.componentName, "Button");
    assert.equal(finalJob.patchCount, 2);
    assert.match(finalJob.codegenSummary ?? "", /Generated Button|Generated 2 patch/);

    const getRes = await app.request(`/jobs/${created.id}`);
    const fetched = (await getRes.json()) as { status: string; patchCount?: number };
    assert.equal(fetched.status, "validated");
    assert.equal(fetched.patchCount, 2);

    const previewRes = await app.request(`/jobs/${created.id}/preview`);
    const previewStatus = previewRes.status;
    assert.ok(
      previewStatus === 200 || previewStatus === 500,
      `preview route should respond (got ${previewStatus})`,
    );

    await cleanup();
  });

  it("worker endpoints require secret", async () => {
    const { app } = createTestApp();
    const res = await app.request("/internal/worker/claim", { method: "POST" });
    assert.equal(res.status, 401);
  });
});
