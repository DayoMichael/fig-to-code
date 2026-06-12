import type {
  BitbucketVcsConfig,
  GitHubVcsConfig,
  VcsConfig,
} from "@fig2code/spec";

export function asGitHubVcs(vcs: VcsConfig): GitHubVcsConfig {
  if (vcs.provider !== "github") {
    throw new Error(`Expected github VCS config, got ${vcs.provider}`);
  }
  return vcs;
}

export function asBitbucketVcs(vcs: VcsConfig): BitbucketVcsConfig {
  if (vcs.provider !== "bitbucket") {
    throw new Error(`Expected bitbucket VCS config, got ${vcs.provider}`);
  }
  return vcs;
}

export function cloneUrl(
  vcs: VcsConfig,
  token: string,
  options?: { atlassianEmail?: string },
): string {
  switch (vcs.provider) {
    case "github":
      // x-access-token works for PATs, OAuth tokens, and app tokens alike.
      return `https://x-access-token:${encodeURIComponent(token)}@github.com/${vcs.owner}/${vcs.repo}.git`;
    case "bitbucket": {
      // Mirrors bitbucketAuthorizationHeader: an Atlassian email means an API
      // token (its own git username); OAuth and repository access tokens use
      // x-token-auth.
      const username = options?.atlassianEmail?.trim()
        ? "x-bitbucket-api-token-auth"
        : "x-token-auth";
      return `https://${username}:${encodeURIComponent(token)}@bitbucket.org/${vcs.workspace}/${vcs.repo}.git`;
    }
    default:
      throw new Error(`Clone not supported for provider ${vcs.provider}`);
  }
}

export function defaultBranch(vcs: VcsConfig): string {
  return vcs.baseBranch || "main";
}
