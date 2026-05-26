import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClaimedJobPayload, JobRecord } from "@fig2code/spec";
import { processJobM3 } from "./process-m3.js";

describe("processJobM3", () => {
  it("marks invalid specs as failed", async () => {
    const patches: Partial<JobRecord>[] = [];
    const client = {
      async patchJob(_jobId: string, patch: Partial<JobRecord>) {
        patches.push(patch);
        return { id: "job-1", status: patch.status ?? "failed" } as JobRecord;
      },
    };

    const payload = {
      jobId: "job-1",
      intent: "component",
      targets: ["web"],
      sessionId: "s1",
      gitToken: "tok",
      prunedSpec: { name: "", kind: "component" },
      vcs: {
        provider: "github",
        owner: "a",
        repo: "b",
        baseBranch: "main",
        defaultPrTarget: "main",
      },
      syncConfig: syntheticRequest.syncConfig,
    } satisfies ClaimedJobPayload;

    await processJobM3(payload, client);
    assert.equal(patches[0]?.status, "failed");
  });

  it("advances valid specs to validated", async () => {
    const statuses: string[] = [];
    const client = {
      async patchJob(_jobId: string, patch: Partial<JobRecord>) {
        statuses.push(patch.status ?? "unknown");
        return { id: "job-1", status: patch.status ?? "unknown" } as JobRecord;
      },
    };

    await processJobM3(
      {
        jobId: "job-1",
        intent: "component",
        targets: ["web"],
        sessionId: "s1",
        gitToken: "tok",
        prunedSpec: syntheticRequest.prunedSpec,
        vcs: syntheticRequest.vcs,
        syncConfig: syntheticRequest.syncConfig,
      },
      client,
    );

    assert.deepEqual(statuses, ["codegen", "validated"]);
  });
});

const syntheticRequest = {
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
  },
};
