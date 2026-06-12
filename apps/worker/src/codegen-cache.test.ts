import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MockLlmProvider } from "@fig2code/llm";
import type { ClaimedJobPayload } from "@fig2code/spec";
import { processJob } from "./process-job.js";
import { clearCodegenCache, computeCodegenCacheKey } from "./codegen-cache.js";

const goldenResponse = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../packages/llm/fixtures/golden-codegen-response.json",
  ),
  "utf8",
);

function mockProvider() {
  return new MockLlmProvider({
    allowlist: ["anthropic/claude-sonnet"],
    response: goldenResponse,
  });
}

const basePayload: ClaimedJobPayload = {
  jobId: "job-1",
  intent: "component",
  targets: ["web"],
  sessionId: "s1",
  gitToken: "tok",
  prunedSpec: { name: "Button", kind: "component" },
  vcs: {
    provider: "github",
    owner: "acme",
    repo: "app",
    baseBranch: "main",
    defaultPrTarget: "main",
  },
  syncConfig: {
    vcs: {
      provider: "github",
      owner: "acme",
      repo: "app",
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
    llm: { modelId: "anthropic/claude-sonnet", promptProfile: "component-v1" },
  },
};

const noopClient = {
  async patchJob(_jobId: string, patch: Record<string, unknown>) {
    return { id: "job-1", ...patch } as never;
  },
};

describe("codegen cache", () => {
  it("computes identical keys for identical payloads regardless of jobId/secrets", () => {
    const a = computeCodegenCacheKey({ ...basePayload, jobId: "a", gitToken: "x" });
    const b = computeCodegenCacheKey({ ...basePayload, jobId: "b", gitToken: "y" });
    assert.equal(a, b);
  });

  it("changes the key when the design spec changes", () => {
    const a = computeCodegenCacheKey(basePayload);
    const b = computeCodegenCacheKey({
      ...basePayload,
      prunedSpec: { name: "Card", kind: "component" },
    });
    assert.notEqual(a, b);
  });

  it("skips the LLM on a repeat selection of the same component", async () => {
    clearCodegenCache();
    const mock = mockProvider();

    // First push of the component: cache miss → one LLM call.
    const first = await processJob({ ...basePayload, jobId: "job-a" }, noopClient, {
      llmProvider: mock,
      apiKey: "test-key",
    });
    assert.equal(first.status, "validated");
    assert.equal(mock.calls.length, 1);

    // Re-selecting the same component (new jobId, identical design) is a cache
    // hit: the model is not called again, yet the preview result is replayed.
    const second = await processJob({ ...basePayload, jobId: "job-b" }, noopClient, {
      llmProvider: mock,
      apiKey: "test-key",
    });
    assert.equal(second.status, "validated");
    assert.equal(mock.calls.length, 1, "repeat selection must not re-run the LLM");
    assert.equal(second.patchCount, first.patchCount);

    // A different component misses the cache and runs codegen again.
    const third = await processJob(
      {
        ...basePayload,
        jobId: "job-c",
        prunedSpec: { name: "Card", kind: "component" },
      },
      noopClient,
      { llmProvider: mock, apiKey: "test-key" },
    );
    assert.equal(third.status, "validated");
    assert.equal(mock.calls.length, 2, "a new component must run the LLM");
  });

  it("never caches update jobs or jobs carrying editor overrides", async () => {
    clearCodegenCache();
    const mock = mockProvider();
    const overrides = [
      {
        path: "src/components/Button/Button.tsx",
        role: "component",
        content: "export const Button = () => <button>edited</button>;",
      },
    ];

    // Same edit-carrying payload twice: both must hit the LLM, because the
    // output depends on mutable state (repo files, in-progress edits) that
    // the cache key cannot see.
    for (const jobId of ["job-a", "job-b"]) {
      const result = await processJob(
        { ...basePayload, jobId, intent: "component-update", previewFileOverrides: overrides },
        noopClient,
        { llmProvider: mock, apiKey: "test-key" },
      );
      assert.equal(result.status, "validated");
    }
    assert.equal(mock.calls.length, 2, "update jobs must never replay a cached result");
  });
});
