import type { FilePatch, VcsConfig } from "@fig2code/spec";
import { asGitHostAuth, type GitHostAuth } from "./auth.js";
import { GitHostApiError, hostFetch, readJson } from "./fetch.js";
import { cloneRepository } from "./clone.js";
import type {
  CloneOptions,
  GitHostCapabilities,
  GitHostProvider,
  PullRequestInput,
  PullRequestResult,
  RefSummary,
} from "./types.js";
import { asGitHubVcs, defaultBranch } from "./vcs.js";

interface GitHubContentResponse {
  content?: string;
  encoding?: string;
}

interface GitHubBranch {
  name: string;
  commit: { sha: string };
}

export class GitHubProvider implements GitHostProvider {
  readonly capabilities: GitHostCapabilities = {
    provider: "github",
    supportsAtomicMultiFileCommit: true,
    supportsPullRequests: true,
  };

  async cloneRepo(options: CloneOptions): Promise<void> {
    await cloneRepository(options);
  }

  async readFile(
    vcs: VcsConfig,
    auth: GitHostAuth | string,
    path: string,
    ref?: string,
  ): Promise<string | null> {
    const { token } = asGitHostAuth(auth);
    const gh = asGitHubVcs(vcs);
    const branch = ref ?? defaultBranch(vcs);
    const encodedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;

    const response = await hostFetch(url, { token });

    if (response.status === 404) {
      return null;
    }

    const data = await readJson<GitHubContentResponse>(response);

    if (!data.content || data.encoding !== "base64") {
      throw new Error(`Unexpected GitHub contents response for ${path}`);
    }

    return Buffer.from(data.content, "base64").toString("utf8");
  }

  async listRefs(vcs: VcsConfig, auth: GitHostAuth | string): Promise<RefSummary[]> {
    const { token } = asGitHostAuth(auth);
    const gh = asGitHubVcs(vcs);
    const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/branches?per_page=100`;
    const response = await hostFetch(url, { token });
    const branches = await readJson<GitHubBranch[]>(response);

    return branches.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
    }));
  }

  async writeFiles(
    _vcs: VcsConfig,
    _auth: GitHostAuth | string,
    _branch: string,
    _message: string,
    _patches: FilePatch[],
  ): Promise<string> {
    throw new Error("GitHubProvider.writeFiles ships in M3 (PR workflow)");
  }

  async openPullRequest(_input: PullRequestInput): Promise<PullRequestResult> {
    throw new Error("GitHubProvider.openPullRequest ships in M3 (PR workflow)");
  }
}

export async function verifyGitHubAccess(
  vcs: VcsConfig,
  auth: GitHostAuth | string,
): Promise<{ defaultBranch: string }> {
  const { token } = asGitHostAuth(auth);
  const gh = asGitHubVcs(vcs);
  const response = await hostFetch(
    `https://api.github.com/repos/${gh.owner}/${gh.repo}`,
    { token },
  );

  if (response.status === 401 || response.status === 403) {
    throw new GitHostApiError(response.status, await response.text());
  }

  const repo = await readJson<{ default_branch: string }>(response);
  return { defaultBranch: repo.default_branch };
}
