import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BitbucketProvider } from "./bitbucket.js";
import { resetFetchImplementation, setFetchImplementation } from "./fetch.js";
import type { BitbucketVcsConfig } from "@fig2code/spec";

const vcs: BitbucketVcsConfig = {
  provider: "bitbucket",
  workspace: "acme-team",
  repo: "design-system",
  baseBranch: "main",
  defaultPrTarget: "main",
};

describe("BitbucketProvider", () => {
  afterEach(() => {
    resetFetchImplementation();
  });

  it("readFile returns plain text from src endpoint", async () => {
    setFetchImplementation(async (url, init) => {
      assert.match(String(url), /\/repositories\/acme-team\/design-system\/src\/main\/package\.json/);
      assert.equal((init?.headers as Record<string, string>).Accept, "text/plain");
      return new Response('{"name":"demo"}', { status: 200 });
    });

    const provider = new BitbucketProvider();
    const content = await provider.readFile(vcs, "token", "package.json");
    assert.equal(content, '{"name":"demo"}');
  });

  it("readFile returns null for directory listings", async () => {
    setFetchImplementation(async () =>
      new Response(
        JSON.stringify({
          values: [{ path: "packages/ui/src/icons/etch-icons/etch-anchor.tsx" }],
          pagelen: 10,
          page: 1,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const provider = new BitbucketProvider();
    const content = await provider.readFile(
      vcs,
      "token",
      "packages/ui/src/components/icons/etch-icons",
    );
    assert.equal(content, null);
  });

  it("listRefs paginates branch results", async () => {
    let call = 0;
    setFetchImplementation(async (url, init) => {
      call += 1;
      if (call === 1) {
        assert.match(String(url), /\/refs\/branches/);
        const auth = (init?.headers as Record<string, string>).Authorization;
        assert.match(auth, /^Basic /);
        return new Response(
          JSON.stringify({
            values: [{ name: "main", target: { hash: "abc123" } }],
            next: "https://api.bitbucket.org/2.0/next-page",
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          values: [{ name: "develop", target: { hash: "def456" } }],
        }),
        { status: 200 },
      );
    });

    const provider = new BitbucketProvider();
    const refs = await provider.listRefs(vcs, {
      token: "token",
      atlassianEmail: "designer@acme.com",
    });
    assert.deepEqual(refs, [
      { name: "main", sha: "abc123" },
      { name: "develop", sha: "def456" },
    ]);
  });

  it("retries with Bearer when Basic auth 401s (wrong token kind for an email)", async () => {
    const authHeaders: string[] = [];
    setFetchImplementation(async (_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      authHeaders.push(auth);
      if (auth.startsWith("Basic ")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      return new Response(
        JSON.stringify({ values: [{ name: "main", target: { hash: "abc123" } }] }),
        { status: 200 },
      );
    });

    const provider = new BitbucketProvider();
    // Repository access tokens are Bearer-only; the user filled the email
    // field anyway. The first attempt (Basic) fails, the retry succeeds.
    const refs = await provider.listRefs(vcs, {
      token: "repo-access-token",
      atlassianEmail: "designer@acme.com",
    });
    assert.deepEqual(refs, [{ name: "main", sha: "abc123" }]);
    assert.match(authHeaders[0], /^Basic /);
    assert.equal(authHeaders[1], "Bearer repo-access-token");
  });
});

describe("BitbucketProvider.listRepositories", () => {
  it("maps workspace repos and follows mainbranch", async () => {
    setFetchImplementation(async (url) => {
      assert.match(String(url), /2\.0\/repositories\?role=member/);
      return new Response(
        JSON.stringify({
          values: [
            {
              full_name: "acme-team/app",
              slug: "app",
              is_private: true,
              mainbranch: { name: "trunk" },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const provider = new BitbucketProvider();
    const repos = await provider.listRepositories({ token: "t" });
    assert.deepEqual(repos, [
      {
        provider: "bitbucket",
        fullName: "acme-team/app",
        owner: "acme-team",
        repo: "app",
        defaultBranch: "trunk",
        private: true,
      },
    ]);
    resetFetchImplementation();
  });
});
