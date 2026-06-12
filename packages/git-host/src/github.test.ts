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

  it("writeFiles creates a new branch from base with one commit via the Git Data API", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    setFetchImplementation(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, method, body });

      if (u.includes("/git/ref/heads%2Fmain")) {
        return new Response(JSON.stringify({ object: { sha: "base-sha" } }), { status: 200 });
      }
      if (u.includes("/git/ref/heads%2Ffig2code%2Fbutton-job1")) {
        return new Response("missing", { status: 404 }); // head branch doesn't exist yet
      }
      if (u.includes("/git/commits/base-sha")) {
        return new Response(
          JSON.stringify({ sha: "base-sha", tree: { sha: "base-tree" } }),
          { status: 200 },
        );
      }
      if (u.endsWith("/git/trees") && method === "POST") {
        return new Response(JSON.stringify({ sha: "new-tree" }), { status: 201 });
      }
      if (u.endsWith("/git/commits") && method === "POST") {
        return new Response(
          JSON.stringify({ sha: "new-commit", tree: { sha: "new-tree" } }),
          { status: 201 },
        );
      }
      if (u.endsWith("/git/refs") && method === "POST") {
        return new Response(JSON.stringify({ ref: "refs/heads/fig2code/button-job1" }), {
          status: 201,
        });
      }
      throw new Error(`Unexpected request: ${method} ${u}`);
    });

    const provider = new GitHubProvider();
    const branch = await provider.writeFiles(vcs, "token", {
      headBranch: "fig2code/button-job1",
      baseBranch: "main",
      message: "Fig2Code: Button",
      patches: [
        { path: "src/components/Button/Button.tsx", action: "create", content: "export {};" },
        { path: "src/components/Button/index.ts", action: "create", content: "export {};" },
        { path: "old.ts", action: "delete" }, // deletes are skipped, matching Bitbucket
      ],
    });

    assert.equal(branch, "fig2code/button-job1");
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    const tree = (treeCall?.body as { base_tree: string; tree: Array<{ path: string }> });
    assert.equal(tree.base_tree, "base-tree");
    assert.deepEqual(
      tree.tree.map((entry) => entry.path),
      ["src/components/Button/Button.tsx", "src/components/Button/index.ts"],
    );
    const refCall = calls.find((c) => c.url.endsWith("/git/refs") && c.method === "POST");
    assert.deepEqual(refCall?.body, { ref: "refs/heads/fig2code/button-job1", sha: "new-commit" });
  });

  it("writeFiles appends to an existing head branch instead of recreating it", async () => {
    const refUpdates: unknown[] = [];
    setFetchImplementation(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/git/ref/heads%2Fmain")) {
        return new Response(JSON.stringify({ object: { sha: "base-sha" } }), { status: 200 });
      }
      if (u.includes("/git/ref/heads%2Ffig2code%2Fbutton-job1")) {
        return new Response(JSON.stringify({ object: { sha: "head-sha" } }), { status: 200 });
      }
      if (u.includes("/git/commits/head-sha")) {
        return new Response(
          JSON.stringify({ sha: "head-sha", tree: { sha: "head-tree" } }),
          { status: 200 },
        );
      }
      if (u.endsWith("/git/trees")) {
        return new Response(JSON.stringify({ sha: "t2" }), { status: 201 });
      }
      if (u.endsWith("/git/commits") && method === "POST") {
        return new Response(JSON.stringify({ sha: "c2", tree: { sha: "t2" } }), { status: 201 });
      }
      if (u.includes("/git/refs/heads/") && method === "PATCH") {
        refUpdates.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`Unexpected request: ${method} ${u}`);
    });

    const provider = new GitHubProvider();
    await provider.writeFiles(vcs, "token", {
      headBranch: "fig2code/button-job1",
      baseBranch: "main",
      message: "Fig2Code: Button (retry)",
      patches: [{ path: "a.ts", action: "update", content: "export {};" }],
    });

    assert.deepEqual(refUpdates, [{ sha: "c2", force: false }]);
  });

  it("openPullRequest returns the created PR url and number", async () => {
    setFetchImplementation(async (url, init) => {
      assert.match(String(url), /\/repos\/acme\/design-system\/pulls$/);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.head, "fig2code/button-job1");
      assert.equal(body.base, "main");
      return new Response(
        JSON.stringify({ number: 42, html_url: "https://github.com/acme/design-system/pull/42" }),
        { status: 201 },
      );
    });

    const provider = new GitHubProvider();
    const pr = await provider.openPullRequest({
      vcs,
      token: "token",
      headBranch: "fig2code/button-job1",
      baseBranch: "main",
      title: "Fig2Code: Button",
      body: "body",
    });
    assert.deepEqual(pr, { url: "https://github.com/acme/design-system/pull/42", number: 42 });
  });

  it("openPullRequest reuses an existing open PR on 422", async () => {
    setFetchImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pulls") && init?.method === "POST") {
        return new Response(JSON.stringify({ message: "A pull request already exists" }), {
          status: 422,
        });
      }
      if (u.includes("/pulls?state=open")) {
        assert.match(u, /head=acme%3Afig2code%2Fbutton-job1/);
        return new Response(
          JSON.stringify([
            { number: 7, html_url: "https://github.com/acme/design-system/pull/7" },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${u}`);
    });

    const provider = new GitHubProvider();
    const pr = await provider.openPullRequest({
      vcs,
      token: "token",
      headBranch: "fig2code/button-job1",
      baseBranch: "main",
      title: "Fig2Code: Button",
      body: "body",
    });
    assert.deepEqual(pr, { url: "https://github.com/acme/design-system/pull/7", number: 7 });
  });
});

describe("GitHubProvider.listRepositories", () => {
  afterEach(() => {
    resetFetchImplementation();
  });

  it("maps user repos with owner, default branch, and visibility", async () => {
    setFetchImplementation(async (url) => {
      assert.match(String(url), /\/user\/repos\?per_page=100&page=1/);
      return new Response(
        JSON.stringify([
          {
            full_name: "acme/design-system",
            name: "design-system",
            owner: { login: "acme" },
            default_branch: "develop",
            private: true,
          },
        ]),
        { status: 200 },
      );
    });

    const provider = new GitHubProvider();
    const repos = await provider.listRepositories("token");
    assert.deepEqual(repos, [
      {
        provider: "github",
        fullName: "acme/design-system",
        owner: "acme",
        repo: "design-system",
        defaultBranch: "develop",
        private: true,
      },
    ]);
  });
});
