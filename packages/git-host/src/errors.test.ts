import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHostApiError } from "./fetch.js";
import { formatGitHostApiError } from "./errors.js";

describe("formatGitHostApiError", () => {
  it("returns Bitbucket guidance for 401 when provider is bitbucket", () => {
    const message = formatGitHostApiError(
      new GitHostApiError(401, ""),
      "bitbucket",
    );
    assert.match(message, /Atlassian account email/i);
    assert.match(message, /read:repository:bitbucket/i);
  });

  it("returns generic guidance for 401 when provider is unknown", () => {
    const message = formatGitHostApiError(new GitHostApiError(401, ""), "github");
    assert.match(message, /Authentication failed \(401\)/i);
  });
});
