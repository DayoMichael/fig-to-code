import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bitbucketAuthorizationHeader } from "./auth.js";

describe("bitbucketAuthorizationHeader", () => {
  it("uses Basic auth when Atlassian email is provided", () => {
    const header = bitbucketAuthorizationHeader({
      token: "api-token",
      atlassianEmail: "designer@acme.com",
    });

    assert.equal(header, `Basic ${Buffer.from("designer@acme.com:api-token", "utf8").toString("base64")}`);
  });

  it("falls back to Bearer auth for repository access tokens", () => {
    const header = bitbucketAuthorizationHeader({ token: "repo-access-token" });
    assert.equal(header, "Bearer repo-access-token");
  });
});
