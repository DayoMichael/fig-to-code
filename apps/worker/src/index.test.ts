import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeJob } from "./index.js";

describe("worker", () => {
  it("fails gracefully when sync-config is missing", async () => {
    const result = await executeJob({
      jobId: "test-job",
      intent: "component",
      prunedSpec: { name: "Button", kind: "component" },
      targets: ["web"],
      workspaceRoot: "/tmp/nonexistent-fig2code-workspace",
      gitToken: "stub",
    });

    assert.equal(result.job.status, "failed");
    assert.ok(result.job.error?.includes("sync-config"));
  });
});
