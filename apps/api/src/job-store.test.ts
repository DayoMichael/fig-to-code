import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnqueueJobRequest } from "@fig2code/spec";
import { createJobStore } from "./job-store.js";

const syntheticRequest: EnqueueJobRequest = {
  intent: "component",
  sessionId: "session-1",
  targets: ["web"],
  prunedSpec: {
    name: "Button",
    kind: "component",
    variants: { variant: ["primary"] },
    slots: { label: { type: "text", required: true } },
  },
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
  },
};

describe("job-store", () => {
  it("enqueues and claims jobs in FIFO order", () => {
    const store = createJobStore();
    const first = store.enqueue(syntheticRequest, { gitToken: "tok-1" });
    const second = store.enqueue(
      { ...syntheticRequest, sessionId: "session-2" },
      { gitToken: "tok-2" },
    );

    assert.equal(first.status, "queued");
    assert.equal(first.componentName, "Button");

    const claimed = store.claimNext();
    assert.equal(claimed?.jobId, first.id);
    assert.equal(claimed?.gitToken, "tok-1");
    assert.equal(store.get(first.id)?.status, "running");

    const claimedSecond = store.claimNext();
    assert.equal(claimedSecond?.jobId, second.id);
    assert.equal(store.get(first.id)?.id, first.id);
    assert.notEqual(store.getStored(first.id)?.secrets.gitToken, undefined);
  });

  it("does not expose secrets in public job records", () => {
    const store = createJobStore();
    const job = store.enqueue(syntheticRequest, { gitToken: "secret-token" });
    const fetched = store.get(job.id)!;

    assert.equal((fetched as { gitToken?: string }).gitToken, undefined);
  });
});
