import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MockLlmProvider } from "@fig2code/llm";
import { processJob } from "./process-job.js";

const goldenResponse = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../packages/llm/fixtures/golden-codegen-response.json",
  ),
  "utf8",
);

describe("processJob", () => {
  it("fails invalid specs before codegen", async () => {
    const patches: Array<Partial<{ status: string; error?: string }>> = [];
    const client = {
      async patchJob(_jobId: string, patch: Partial<{ status: string; error?: string }>) {
        patches.push(patch);
        return { id: "job-1", status: patch.status ?? "failed" } as never;
      },
    };

    await processJob(
      {
        jobId: "job-1",
        intent: "component",
        targets: ["web"],
        sessionId: "s1",
        gitToken: "tok",
        prunedSpec: { name: "", kind: "component" },
        vcs: syntheticPayload.vcs,
        syncConfig: syntheticPayload.syncConfig,
      },
      client,
      { llmProvider: mockProvider(), apiKey: "test-key" },
    );

    assert.equal(patches[0]?.status, "failed");
  });

  it("runs mock codegen and stores patch metadata", async () => {
    const mock = mockProvider();
    const client = {
      async patchJob(_jobId: string, patch: Record<string, unknown>) {
        return { id: "job-1", ...patch } as never;
      },
    };

    const result = await processJob(
      {
        jobId: "job-1",
        intent: "component",
        targets: ["web"],
        sessionId: "s1",
        gitToken: "tok",
        prunedSpec: syntheticPayload.prunedSpec,
        vcs: syntheticPayload.vcs,
        syncConfig: syntheticPayload.syncConfig,
      },
      client,
      { llmProvider: mock, apiKey: "test-key" },
    );

    assert.equal(result.status, "validated");
    // component + story + test + package index export
    assert.equal(result.patchCount, 4);
    assert.equal(mock.calls.length, 1);
  });

  it("dispatches component-update intent through the update profile and existing_files slot", async () => {
    const mock = mockProvider();
    const client = {
      async patchJob(_jobId: string, patch: Record<string, unknown>) {
        return { id: "job-1", ...patch } as never;
      },
    };

    const result = await processJob(
      {
        jobId: "job-1",
        intent: "component-update",
        targets: ["web"],
        sessionId: "s1",
        gitToken: "tok",
        prunedSpec: syntheticPayload.prunedSpec,
        vcs: syntheticPayload.vcs,
        syncConfig: syntheticPayload.syncConfig,
        bundleId: "bundle-test-1",
      },
      client,
      {
        llmProvider: mock,
        apiKey: "test-key",
        resolveBundle: async () => ({
          componentName: "Button",
          match: {
            source: "registry",
            confidence: "high",
            reason: "matched via registry",
          },
          files: [
            {
              path: "src/components/Button/Button.tsx",
              role: "component",
              content: "export const Button = () => null;",
            },
            {
              path: "src/components/Button/Button.stories.tsx",
              role: "story",
              content: "export default { component: Button };",
            },
          ],
          primaryComponentPath: "src/components/Button/Button.tsx",
          storyPath: "src/components/Button/Button.stories.tsx",
        }),
      },
    );

    assert.equal(result.status, "validated");
    assert.equal(mock.calls.length, 1);

    const envelope = mock.calls[0]?.envelope;
    assert.ok(envelope);
    assert.equal(envelope!.profile, "component-update-v1");

    const existingFilesSlot = envelope!.slots.find((s) => s.id === "existing_files");
    assert.ok(existingFilesSlot, "existing_files slot present");
    assert.match(existingFilesSlot!.content, /Button\.tsx/);
  });
});

function mockProvider() {
  return new MockLlmProvider({
    allowlist: ["anthropic/claude-sonnet"],
    response: goldenResponse,
  });
}

const syntheticPayload = {
  prunedSpec: {
    name: "Button",
    kind: "component" as const,
  },
  vcs: {
    provider: "github" as const,
    owner: "acme",
    repo: "app",
    baseBranch: "main",
    defaultPrTarget: "main",
  },
  syncConfig: {
    vcs: {
      provider: "github" as const,
      owner: "acme",
      repo: "app",
      baseBranch: "main",
      defaultPrTarget: "main",
    },
    platforms: ["web" as const],
    web: {
      styleSystem: "tailwind" as const,
      componentPath: "src/components",
      tokenPaths: ["tailwind.config.ts"],
      iconPath: "src/icons",
      exampleComponent: "src/components/Button/Button.tsx",
    },
    conventions: {
      exportStyle: "named" as const,
      propsPattern: "interface" as const,
      fileNaming: "PascalCase" as const,
      testFramework: "vitest" as const,
      storyFormat: "csf3" as const,
    },
    llm: {
      modelId: "anthropic/claude-sonnet",
      promptProfile: "component-v1",
    },
  },
};
