import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatQaMarkdown } from "./pipeline.js";

describe("codegen", () => {
  it("formats QA markdown summary", () => {
    const md = formatQaMarkdown({
      jobId: "j1",
      gates: [{ name: "tsc", passed: true, exitCode: 0 }],
      retriesUsed: 0,
      passed: true,
      generatedAt: new Date().toISOString(),
    });

    assert.match(md, /PASSED/);
  });
});
