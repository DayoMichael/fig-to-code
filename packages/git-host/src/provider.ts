import { BitbucketProvider } from "./bitbucket.js";
import { GitHubProvider } from "./github.js";
import type { GitHostProvider } from "./types.js";

export class UnsupportedGitHostError extends Error {
  constructor(provider: string) {
    super(`Git host provider "${provider}" is not implemented yet`);
    this.name = "UnsupportedGitHostError";
  }
}

export function createGitHostProvider(provider: string): GitHostProvider {
  switch (provider) {
    case "github":
      return new GitHubProvider();
    case "bitbucket":
      return new BitbucketProvider();
    default:
      throw new UnsupportedGitHostError(provider);
  }
}
