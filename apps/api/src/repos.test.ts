import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { Hono } from "hono";
import { fixturePath } from "@fig2code/repo";
import { setFetchImplementation, resetFetchImplementation } from "@fig2code/git-host";
import type { ResolveComponentResponse } from "@fig2code/spec";
import app from "./index.js";
import { createBundleStore } from "./bundle-store.js";
import { createReposRouter, formatRepoUrl } from "./repos.js";
import type { RepoCloneCache } from "./repo-cache.js";

const execFileAsync = promisify(execFile);

async function createResolveTestRepoCache(
  files: Record<string, string>,
): Promise<{ repoCache: RepoCloneCache; clonePath: string }> {
  const clonePath = await mkdtemp(join(tmpdir(), "fig2code-resolve-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(clonePath, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
  const repoCache: RepoCloneCache = {
    getOrClone: async () => clonePath,
    evict: async () => {
      await rm(clonePath, { recursive: true, force: true });
    },
    evictAll: async () => {
      await rm(clonePath, { recursive: true, force: true });
    },
  };
  return { repoCache, clonePath };
}

describe("repos routes", () => {
  it("GET /repos/fixtures lists fixture paths", async () => {
    const res = await app.request("/repos/fixtures");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tailwind: string; styled: string };
    assert.ok(body.tailwind.includes("tailwind-app"));
    assert.ok(body.styled.includes("styled-app"));
  });

  it("POST /repos/detect/local runs auto-detect on tailwind fixture", async () => {
    const res = await app.request("/repos/detect/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: fixturePath("tailwind-app"),
        vcs: {
          provider: "github",
          owner: "acme",
          repo: "tailwind-app",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      detected: { styleSystem: string };
      syncConfig: { web?: { styleSystem?: string } };
    };
    assert.equal(body.detected.styleSystem, "tailwind");
    assert.equal(body.syncConfig.web?.styleSystem, "tailwind");
  });

  it("POST /repos/refs accepts Bitbucket without email for repository access tokens", async () => {
    const res = await app.request("/repos/refs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vcs: {
          provider: "bitbucket",
          workspace: "acme",
          repo: "app",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
        token: "secret",
      }),
    });

    assert.notEqual(res.status, 400);
  });

  it("POST /repos/refs rejects missing token", async () => {
    const res = await app.request("/repos/refs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vcs: {
          provider: "bitbucket",
          workspace: "acme",
          repo: "app",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
        token: "",
      }),
    });

    assert.equal(res.status, 400);
  });

  it("formatRepoUrl builds bitbucket url", () => {
    assert.equal(
      formatRepoUrl({
        provider: "bitbucket",
        workspace: "acme-team",
        repo: "design-system",
        baseBranch: "main",
        defaultPrTarget: "main",
      }),
      "bitbucket.org/acme-team/design-system",
    );
  });

  it("POST /repos/resolve-component returns matched bundle and stores it for retrieval", async () => {
    const bundleStore = createBundleStore({ ttlMs: 60_000 });
    const componentSrc = "export const Button = () => null;\n";
    const storySrc =
      "import { Button } from './Button';\nexport default { component: Button };\n";
    const { repoCache, clonePath } = await createResolveTestRepoCache({
      "src/components/Button/Button.tsx": componentSrc,
      "src/components/Button/Button.stories.tsx": storySrc,
    });
    const repos = createReposRouter({ bundleStore, repoCache });
    const reposApp = new Hono();
    reposApp.route("/repos", repos);

    try {
      const res = await reposApp.request("/repos/resolve-component", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "ghp_test",
          componentName: "Button",
          vcs: {
            provider: "github",
            owner: "acme",
            repo: "design-system",
            baseBranch: "main",
            defaultPrTarget: "main",
          },
          syncConfig: {
            vcs: {
              provider: "github",
              owner: "acme",
              repo: "design-system",
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
        }),
      });

      assert.equal(res.status, 200);
      const body = (await res.json()) as ResolveComponentResponse;
      assert.equal(body.matched, true);
      assert.ok(body.bundleId);
      assert.equal(body.bundle?.componentName, "Button");

      const filesByRole = (body.bundle?.files ?? []).map((f) => f.role).sort();
      assert.deepEqual(filesByRole, ["component", "story"]);

      const bundleRes = await reposApp.request(`/repos/bundles/${body.bundleId}`);
      assert.equal(bundleRes.status, 200);
      const bundleBody = (await bundleRes.json()) as {
        bundle: { componentName: string };
      };
      assert.equal(bundleBody.bundle.componentName, "Button");
    } finally {
      await rm(clonePath, { recursive: true, force: true });
    }
  });

  it("POST /repos/resolve-component returns matched:false when no files exist", async () => {
    const { repoCache, clonePath } = await createResolveTestRepoCache({});
    const repos = createReposRouter({ repoCache });
    const reposApp = new Hono();
    reposApp.route("/repos", repos);

    try {
      const res = await reposApp.request("/repos/resolve-component", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "ghp_test",
          componentName: "GhostComponent",
          vcs: {
            provider: "github",
            owner: "acme",
            repo: "design-system",
            baseBranch: "main",
            defaultPrTarget: "main",
          },
          syncConfig: {
            vcs: {
              provider: "github",
              owner: "acme",
              repo: "design-system",
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
        }),
      });

      assert.equal(res.status, 200);
      const body = (await res.json()) as ResolveComponentResponse;
      assert.equal(body.matched, false);
      assert.equal(body.bundleId, undefined);
    } finally {
      await rm(clonePath, { recursive: true, force: true });
    }
  });

  it("POST /repos/resolve-component ignores untracked clone files (preview artifacts)", async () => {
    // A real git clone where Button is committed but Phantom only exists as
    // untracked files — exactly what the preview session leaves behind after
    // generating a new component. Phantom must NOT resolve as a repo match,
    // while the committed Button still does.
    const clonePath = await mkdtemp(join(tmpdir(), "fig2code-resolve-git-"));
    const git = (args: string[]) => execFileAsync("git", args, { cwd: clonePath });
    await git(["init"]);
    await git(["config", "user.email", "test@test.invalid"]);
    await git(["config", "user.name", "test"]);
    await mkdir(join(clonePath, "src/components/Button"), { recursive: true });
    await writeFile(
      join(clonePath, "src/components/Button/Button.tsx"),
      "export const Button = () => null;\n",
      "utf-8",
    );
    await git(["add", "."]);
    await git(["commit", "-m", "init"]);
    await mkdir(join(clonePath, "src/components/Phantom"), { recursive: true });
    await writeFile(
      join(clonePath, "src/components/Phantom/Phantom.tsx"),
      "export const Phantom = () => null;\n",
      "utf-8",
    );

    const repoCache: RepoCloneCache = {
      getOrClone: async () => clonePath,
      evict: async () => {},
      evictAll: async () => {},
    };
    const repos = createReposRouter({ repoCache });
    const reposApp = new Hono();
    reposApp.route("/repos", repos);

    const resolveBody = (componentName: string) =>
      JSON.stringify({
        token: "ghp_test",
        componentName,
        vcs: {
          provider: "github",
          owner: "acme",
          repo: "design-system",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
        syncConfig: {
          vcs: {
            provider: "github",
            owner: "acme",
            repo: "design-system",
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
      });

    try {
      const phantomRes = await reposApp.request("/repos/resolve-component", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: resolveBody("Phantom"),
      });
      assert.equal(phantomRes.status, 200);
      const phantom = (await phantomRes.json()) as ResolveComponentResponse;
      assert.equal(phantom.matched, false, "untracked preview artifacts must not resolve");

      const buttonRes = await reposApp.request("/repos/resolve-component", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: resolveBody("Button"),
      });
      assert.equal(buttonRes.status, 200);
      const button = (await buttonRes.json()) as ResolveComponentResponse;
      assert.equal(button.matched, true, "committed files must still resolve");
    } finally {
      await rm(clonePath, { recursive: true, force: true });
    }
  });
});
