import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { BitbucketVcsConfig, GitHubVcsConfig, SyncConfig } from "@fig2code/spec";
import {
  fixturePath,
  onboardLocalRepo,
} from "./onboard.js";

const githubVcs: GitHubVcsConfig = {
  provider: "github",
  owner: "acme",
  repo: "tailwind-app",
  baseBranch: "main",
  defaultPrTarget: "main",
};

const bitbucketVcs: BitbucketVcsConfig = {
  provider: "bitbucket",
  workspace: "acme-team",
  repo: "styled-app",
  baseBranch: "main",
  defaultPrTarget: "main",
};

describe("onboardLocalRepo", () => {
  const tempDirs: string[] = [];

  after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function copyFixture(name: "tailwind-app" | "styled-app"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fig2code-onboard-"));
    tempDirs.push(dir);
    await cp(fixturePath(name), dir, { recursive: true });
    return dir;
  }

  it("detects tailwind fixture and writes sync-config.json", async () => {
    const rootDir = await copyFixture("tailwind-app");
    const result = await onboardLocalRepo({ rootDir, vcs: githubVcs });

    assert.equal(result.detected.styleSystem, "tailwind");
    assert.equal(result.detected.testFramework, "vitest");
    assert.equal(result.detected.storyFormat, "csf3");
    assert.ok(result.detected.existingComponents.some((c) => c.name === "Button"));
    assert.equal(result.syncConfig.web?.styleSystem, "tailwind");
    assert.equal(result.syncConfig.vcs.provider, "github");

    const written = JSON.parse(
      await readFile(join(rootDir, ".figma", "sync-config.json"), "utf8"),
    ) as SyncConfig;

    assert.equal(written.web?.componentPath, "src/components");
    assert.equal(written.llm?.modelId, "anthropic/claude-sonnet");
  });

  it("detects styled-components fixture for bitbucket vcs", async () => {
    const rootDir = await copyFixture("styled-app");
    const result = await onboardLocalRepo({ rootDir, vcs: bitbucketVcs, writeConfig: false });

    assert.equal(result.detected.styleSystem, "styled-components");
    assert.equal(result.detected.testFramework, "jest");
    assert.equal(result.syncConfig.vcs.provider, "bitbucket");
    assert.equal(result.syncConfig.web?.exampleComponent, "src/components/Button/Button.tsx");
  });
});
