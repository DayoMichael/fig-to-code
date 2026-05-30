import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildViteProxyTargetUrl } from "./jobs.js";

describe("buildViteProxyTargetUrl", () => {
  it("preserves Vite asset import query strings through the proxy", () => {
    const target = buildViteProxyTargetUrl(
      "http://127.0.0.1:58676",
      "http://localhost:3000/preview/existing/session/@fs/tmp/asset.png?import",
    );
    assert.equal(
      target,
      "http://127.0.0.1:58676/preview/existing/session/@fs/tmp/asset.png?import",
    );
  });

  it("preserves json import query strings", () => {
    const target = buildViteProxyTargetUrl(
      "http://127.0.0.1:58676",
      "http://localhost:3000/preview/existing/session/src/data/foo.json?import",
    );
    assert.equal(
      target,
      "http://127.0.0.1:58676/preview/existing/session/src/data/foo.json?import",
    );
  });
});
