import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GitHubProvider } from "./github.js";
import { resetFetchImplementation, setFetchImplementation } from "./fetch.js";
import type { GitHubVcsConfig } from "@fig2code/spec";

const vcs: GitHubVcsConfig = {
  provider: "github",
  owner: "acme",
  repo: "design-system",
  baseBranch: "main",
  defaultPrTarget: "main",
};

describe("GitHubProvider", () => {
  afterEach(() => {
    resetFetchImplementation();
  });

  it("readFile decodes base64 contents", async () => {
    setFetchImplementation(async (url) => {
      assert.match(String(url), /\/repos\/acme\/design-system\/contents\/package\.json/);
      return new Response(
        JSON.stringify({
          content: Buffer.from('{"name":"demo"}', "utf8").toString("base64"),
          encoding: "base64",
        }),
        { status: 200 },
      );
    });

    const provider = new GitHubProvider();
    const content = await provider.readFile(vcs, "token", "package.json");
    assert.equal(content, '{"name":"demo"}');
  });

  it("readFile returns null for missing paths", async () => {
    setFetchImplementation(async () => new Response("not found", { status: 404 }));

    const provider = new GitHubProvider();
    const content = await provider.readFile(vcs, "token", ".figma/sync-config.json");
    assert.equal(content, null);
  });

  it("listRefs maps branch names and shas", async () => {
    setFetchImplementation(async (url) => {
      assert.match(String(url), /\/repos\/acme\/design-system\/branches/);
      return new Response(
        JSON.stringify([
          { name: "main", commit: { sha: "abc123" } },
          { name: "develop", commit: { sha: "def456" } },
        ]),
        { status: 200 },
      );
    });

    const provider = new GitHubProvider();
    const refs = await provider.listRefs(vcs, "token");
    assert.deepEqual(refs, [
      { name: "main", sha: "abc123" },
      { name: "develop", sha: "def456" },
    ]);
  });
});
