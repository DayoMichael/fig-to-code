import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGitHostProvider, UnsupportedGitHostError } from "./provider.js";

describe("git-host factory", () => {
  it("creates github and bitbucket providers", () => {
    assert.equal(createGitHostProvider("github").capabilities.provider, "github");
    assert.equal(createGitHostProvider("bitbucket").capabilities.provider, "bitbucket");
  });

  it("rejects unknown hosts", () => {
    assert.throws(() => createGitHostProvider("unknown"), UnsupportedGitHostError);
  });
});
