#!/usr/bin/env node
/**
 * Manual test helper for M1/M2 against real GitHub or Bitbucket repos.
 *
 * Usage:
 *   FIG2CODE_GIT_TOKEN=ghp_xxx pnpm test-onboard github acme my-repo
 *   FIG2CODE_GIT_TOKEN=... FIG2CODE_ATLASSIAN_EMAIL=you@acme.com pnpm test-onboard bitbucket acme-team my-repo
 *
 * Optional env:
 *   FIG2CODE_CLONE_DIR=/tmp/my-clone
 *   FIG2CODE_BASE_BRANCH=main
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHostProvider } from "@fig2code/git-host";
import { onboardRemoteRepo } from "@fig2code/repo";
import type { BitbucketVcsConfig, GitHubVcsConfig } from "@fig2code/spec";

const [provider, slugA, slugB] = process.argv.slice(2);
const token = process.env.FIG2CODE_GIT_TOKEN;
const atlassianEmail = process.env.FIG2CODE_ATLASSIAN_EMAIL;
const baseBranch = process.env.FIG2CODE_BASE_BRANCH ?? "main";

if (!provider || !slugA || !slugB || !token) {
  console.error(`
Usage:
  FIG2CODE_GIT_TOKEN=... pnpm test-onboard github <owner> <repo>
  FIG2CODE_GIT_TOKEN=... pnpm test-onboard bitbucket <workspace> <repo>

Environment:
  FIG2CODE_GIT_TOKEN         Bitbucket API token or GitHub PAT (required)
  FIG2CODE_ATLASSIAN_EMAIL   Atlassian account email (required for Bitbucket)
  FIG2CODE_CLONE_DIR     Where to clone (default: temp dir)
  FIG2CODE_BASE_BRANCH   Branch to clone (default: main)
`);
  process.exit(1);
}

const targetDir =
  process.env.FIG2CODE_CLONE_DIR ??
  (await mkdtemp(join(tmpdir(), `fig2code-${provider}-`)));

const vcs =
  provider === "github"
    ? ({
        provider: "github",
        owner: slugA,
        repo: slugB,
        baseBranch,
        defaultPrTarget: baseBranch,
      } satisfies GitHubVcsConfig)
    : provider === "bitbucket"
      ? ({
          provider: "bitbucket",
          workspace: slugA,
          repo: slugB,
          baseBranch,
          defaultPrTarget: baseBranch,
        } satisfies BitbucketVcsConfig)
      : null;

if (!vcs) {
  console.error(`Unsupported provider: ${provider}`);
  process.exit(1);
}

if (provider === "bitbucket" && !atlassianEmail?.trim()) {
  console.error("FIG2CODE_ATLASSIAN_EMAIL is required for Bitbucket API tokens.");
  process.exit(1);
}

try {
  const git = createGitHostProvider(vcs.provider);
  console.log(`Listing refs for ${provider}:${slugA}/${slugB}...`);
  const refs = await git.listRefs(vcs, {
    token,
    atlassianEmail: atlassianEmail?.trim(),
  });
  console.log(`Found ${refs.length} branches:`, refs.slice(0, 5).map((r) => r.name).join(", "));

  console.log(`Cloning into ${targetDir}...`);
  const result = await onboardRemoteRepo({
    vcs,
    token,
    atlassianEmail: atlassianEmail?.trim(),
    targetDir,
    writeConfig: true,
  });

  console.log("\nDetection summary:");
  console.log(`  Style system:   ${result.detected.styleSystem}`);
  console.log(`  Test framework: ${result.detected.testFramework}`);
  console.log(`  Components:     ${result.detected.existingComponents.map((c) => c.name).join(", ") || "(none)"}`);
  console.log(`\nWrote: ${result.configPath}`);
  console.log("\nSync config preview:");
  console.log(JSON.stringify(result.syncConfig, null, 2));
} catch (error) {
  console.error("Onboard failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`\nClone left at: ${targetDir}`);
console.log("Set FIG2CODE_CLONE_DIR to control the destination.");
