import type { VcsConfig } from "@fig2code/spec";
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
  RepositorySummary,
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

interface GitHubRefResponse {
  object: { sha: string };
}

interface GitHubCommitResponse {
  sha: string;
  tree: { sha: string };
}

interface GitHubTreeResponse {
  sha: string;
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
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

  /**
   * Commit all patches as ONE commit on `headBranch` via the Git Data API
   * (tree with inline blob contents → commit → ref create/update). The branch
   * is created from `baseBranch` if it doesn't exist; if it does, the commit
   * is appended on top so retried jobs don't lose history.
   */
  async writeFiles(
    vcs: VcsConfig,
    auth: GitHostAuth | string,
    input: import("./types.js").WriteFilesInput,
  ): Promise<string> {
    const { token } = asGitHostAuth(auth);
    const gh = asGitHubVcs(vcs);
    const repoApi = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;

    // Match Bitbucket's behavior: only create/update patches are committed.
    const applicable = input.patches.filter(
      (patch) => patch.action !== "delete" && patch.content !== undefined,
    );
    if (applicable.length === 0) {
      throw new Error("No file patches to commit");
    }

    const baseSha = await this.getRefSha(repoApi, token, input.baseBranch);
    if (!baseSha) {
      throw new Error(`Base branch "${input.baseBranch}" not found on GitHub`);
    }
    const headSha = await this.getRefSha(repoApi, token, input.headBranch);
    const parentSha = headSha ?? baseSha;

    const parentCommitRes = await hostFetch(`${repoApi}/git/commits/${parentSha}`, { token });
    const parentCommit = await readJson<GitHubCommitResponse>(parentCommitRes);

    const treeRes = await hostFetch(`${repoApi}/git/trees`, {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: parentCommit.tree.sha,
        tree: applicable.map((patch) => ({
          path: patch.path.replace(/^\/+/, ""),
          mode: "100644",
          type: "blob",
          content: patch.content ?? "",
        })),
      }),
    });
    const tree = await readJson<GitHubTreeResponse>(treeRes);

    const commitRes = await hostFetch(`${repoApi}/git/commits`, {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: input.message,
        tree: tree.sha,
        parents: [parentSha],
      }),
    });
    const commit = await readJson<GitHubCommitResponse>(commitRes);

    if (headSha) {
      const updateRes = await hostFetch(
        `${repoApi}/git/refs/heads/${encodeURIComponent(input.headBranch)}`,
        {
          token,
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sha: commit.sha, force: false }),
        },
      );
      await readJson<unknown>(updateRes);
    } else {
      const createRes = await hostFetch(`${repoApi}/git/refs`, {
        token,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: `refs/heads/${input.headBranch}`, sha: commit.sha }),
      });
      await readJson<unknown>(createRes);
    }

    return input.headBranch;
  }

  async openPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const { token } = asGitHostAuth({ token: input.token });
    const gh = asGitHubVcs(input.vcs);
    const repoApi = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;

    const response = await hostFetch(`${repoApi}/pulls`, {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      }),
    });

    if (!response.ok) {
      // 422 covers "a pull request already exists" — reuse the open PR so a
      // retried job links back to it instead of failing.
      if (response.status === 422) {
        const existing = await this.findOpenPullRequest(repoApi, token, gh.owner, input);
        if (existing) {
          return existing;
        }
      }
      throw new GitHostApiError(response.status, await response.text(), "open GitHub pull request");
    }

    const pr = await readJson<GitHubPullRequest>(response);
    return { url: pr.html_url, number: pr.number };
  }

  /** Repos the user owns or collaborates on, newest activity first. */
  async listRepositories(auth: GitHostAuth | string): Promise<RepositorySummary[]> {
    const { token } = asGitHostAuth(auth);
    const repos: RepositorySummary[] = [];

    for (let page = 1; page <= 3; page++) {
      const response = await hostFetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        { token },
      );
      const batch = await readJson<
        Array<{
          full_name: string;
          name: string;
          owner: { login: string };
          default_branch: string;
          private: boolean;
        }>
      >(response);

      repos.push(
        ...batch.map((repo) => ({
          provider: "github" as const,
          fullName: repo.full_name,
          owner: repo.owner.login,
          repo: repo.name,
          defaultBranch: repo.default_branch || "main",
          private: repo.private,
        })),
      );
      if (batch.length < 100) break;
    }

    return repos;
  }

  private async getRefSha(
    repoApi: string,
    token: string,
    branch: string,
  ): Promise<string | null> {
    const response = await hostFetch(
      `${repoApi}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
      { token },
    );
    if (response.status === 404) return null;
    const ref = await readJson<GitHubRefResponse>(response);
    return ref.object.sha;
  }

  private async findOpenPullRequest(
    repoApi: string,
    token: string,
    owner: string,
    input: PullRequestInput,
  ): Promise<PullRequestResult | null> {
    const url =
      `${repoApi}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.headBranch}`)}` +
      `&base=${encodeURIComponent(input.baseBranch)}`;
    const response = await hostFetch(url, { token });
    if (!response.ok) return null;
    const prs = (await response.json()) as GitHubPullRequest[];
    const pr = prs[0];
    return pr ? { url: pr.html_url, number: pr.number } : null;
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
