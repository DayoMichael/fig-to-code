import type { VcsConfig } from "@fig2code/spec";
import type { GitHostAuth } from "./auth.js";
import { asGitHostAuth } from "./auth.js";
import { GitHostApiError, bitbucketFetch, readJson } from "./fetch.js";
import { cloneRepository } from "./clone.js";
import type {
  CloneOptions,
  GitHostCapabilities,
  GitHostProvider,
  PullRequestInput,
  PullRequestResult,
  RefSummary,
  WriteFilesInput,
  RepositorySummary,
} from "./types.js";
import { asBitbucketVcs, defaultBranch } from "./vcs.js";

interface BitbucketPaged<T> {
  values: T[];
  next?: string;
}

interface BitbucketBranch {
  name: string;
  target: { hash: string };
}

interface BitbucketPullRequest {
  links: { html: { href: string } };
  id: number;
}

function isBitbucketDirectoryListing(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as { values?: unknown; pagelen?: unknown };
    return Array.isArray(parsed.values) && typeof parsed.pagelen === "number";
  } catch {
    return false;
  }
}

export class BitbucketProvider implements GitHostProvider {
  readonly capabilities: GitHostCapabilities = {
    provider: "bitbucket",
    supportsAtomicMultiFileCommit: false,
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
    const credentials = asGitHostAuth(auth);
    const bb = asBitbucketVcs(vcs);
    const branch = ref ?? defaultBranch(vcs);
    const encodedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    const url =
      `https://api.bitbucket.org/2.0/repositories/${bb.workspace}/${bb.repo}` +
      `/src/${encodeURIComponent(branch)}/${encodedPath}`;

    const response = await bitbucketFetch(url, {
      auth: credentials,
      headers: { Accept: "text/plain" },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new GitHostApiError(response.status, await response.text());
    }

    const text = await response.text();
    if (isBitbucketDirectoryListing(text)) {
      return null;
    }

    return text;
  }

  async listRefs(vcs: VcsConfig, auth: GitHostAuth | string): Promise<RefSummary[]> {
    const credentials = asGitHostAuth(auth);
    const bb = asBitbucketVcs(vcs);
    const refs: RefSummary[] = [];
    let url =
      `https://api.bitbucket.org/2.0/repositories/${bb.workspace}/${bb.repo}` +
      `/refs/branches?pagelen=100`;

    while (url) {
      const response = await bitbucketFetch(url, { auth: credentials });
      const page = await readJson<BitbucketPaged<BitbucketBranch>>(response);

      for (const branch of page.values) {
        refs.push({ name: branch.name, sha: branch.target.hash });
      }

      url = page.next ?? "";
    }

    return refs;
  }

  async writeFiles(
    vcs: VcsConfig,
    auth: GitHostAuth | string,
    input: WriteFilesInput,
  ): Promise<string> {
    const credentials = asGitHostAuth(auth);
    const bb = asBitbucketVcs(vcs);
    const applicable = input.patches.filter(
      (patch) => patch.action !== "delete" && patch.content !== undefined,
    );

    if (applicable.length === 0) {
      throw new Error("No file patches to commit");
    }

    const baseSha = await this.getBranchSha(bb.workspace, bb.repo, credentials, input.baseBranch);
    const headSha = await this.tryGetBranchSha(
      bb.workspace,
      bb.repo,
      credentials,
      input.headBranch,
    );
    const parentSha = headSha ?? baseSha;

    const form = new URLSearchParams();
    form.set("branch", input.headBranch);
    form.set("parents", parentSha);
    form.set("message", input.message);

    for (const patch of applicable) {
      const pathKey = patch.path.startsWith("/") ? patch.path : `/${patch.path}`;
      form.set(pathKey, patch.content ?? "");
    }

    const response = await bitbucketFetch(
      `https://api.bitbucket.org/2.0/repositories/${bb.workspace}/${bb.repo}/src`,
      {
        method: "POST",
        auth: credentials,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    );

    if (!response.ok) {
      throw new GitHostApiError(
        response.status,
        await response.text(),
        "commit files to Bitbucket",
      );
    }

    return input.headBranch;
  }

  async openPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const credentials = asGitHostAuth({
      token: input.token,
      atlassianEmail: input.atlassianEmail,
    });
    const bb = asBitbucketVcs(input.vcs);
    const response = await bitbucketFetch(
      `https://api.bitbucket.org/2.0/repositories/${bb.workspace}/${bb.repo}/pullrequests`,
      {
        method: "POST",
        auth: credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: input.title,
          description: input.body,
          source: { branch: { name: input.headBranch } },
          destination: { branch: { name: input.baseBranch } },
        }),
      },
    );

    if (!response.ok) {
      if (response.status === 400) {
        const existing = await this.findOpenPullRequest(
          bb.workspace,
          bb.repo,
          credentials,
          input.headBranch,
          input.baseBranch,
        );
        if (existing) {
          return existing;
        }
      }
      throw new GitHostApiError(
        response.status,
        await response.text(),
        "open Bitbucket pull request",
      );
    }

    const pr = await readJson<BitbucketPullRequest>(response);
    return { url: pr.links.html.href, number: pr.id };
  }

  private async tryGetBranchSha(
    workspace: string,
    repo: string,
    auth: GitHostAuth,
    branch: string,
  ): Promise<string | null> {
    const response = await bitbucketFetch(
      `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo}/refs/branches/${encodeURIComponent(branch)}`,
      { auth },
    );

    if (response.status === 404) {
      return null;
    }

    const ref = await readJson<BitbucketBranch>(response);
    return ref.target.hash;
  }

  /** Repositories the authenticated user is a member of, newest activity first. */
  async listRepositories(auth: GitHostAuth | string): Promise<RepositorySummary[]> {
    const credentials = asGitHostAuth(auth);
    const repos: RepositorySummary[] = [];
    let url: string | null =
      "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100&sort=-updated_on";

    for (let page = 0; url && page < 3; page++) {
      const response = await bitbucketFetch(url, { auth: credentials });
      const body = await readJson<{
        values: Array<{
          full_name: string;
          slug: string;
          is_private: boolean;
          mainbranch?: { name?: string };
        }>;
        next?: string;
      }>(response);

      repos.push(
        ...body.values.map((repo) => ({
          provider: "bitbucket" as const,
          fullName: repo.full_name,
          owner: repo.full_name.split("/")[0] ?? "",
          repo: repo.slug,
          defaultBranch: repo.mainbranch?.name || "main",
          private: repo.is_private,
        })),
      );
      url = body.next ?? null;
    }

    return repos;
  }

  private async findOpenPullRequest(
    workspace: string,
    repo: string,
    auth: GitHostAuth,
    headBranch: string,
    baseBranch: string,
  ): Promise<PullRequestResult | null> {
    const query = [
      `source.branch.name="${headBranch.replace(/"/g, '\\"')}"`,
      `destination.branch.name="${baseBranch.replace(/"/g, '\\"')}"`,
      `state="OPEN"`,
    ].join("+AND+");

    const response = await bitbucketFetch(
      `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo}/pullrequests?q=${query}`,
      { auth },
    );

    if (!response.ok) {
      return null;
    }

    const page = await readJson<BitbucketPaged<BitbucketPullRequest>>(response);
    const match = page.values[0];
    return match ? { url: match.links.html.href, number: match.id } : null;
  }

  private async getBranchSha(
    workspace: string,
    repo: string,
    auth: GitHostAuth,
    branch: string,
  ): Promise<string> {
    const response = await bitbucketFetch(
      `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo}/refs/branches/${encodeURIComponent(branch)}`,
      { auth },
    );
    const ref = await readJson<BitbucketBranch>(response);
    return ref.target.hash;
  }
}

export async function verifyBitbucketAccess(
  vcs: VcsConfig,
  auth: GitHostAuth | string,
): Promise<{ defaultBranch: string }> {
  const credentials = asGitHostAuth(auth);
  const bb = asBitbucketVcs(vcs);
  const response = await bitbucketFetch(
    `https://api.bitbucket.org/2.0/repositories/${bb.workspace}/${bb.repo}`,
    { auth: credentials },
  );

  if (response.status === 401 || response.status === 403) {
    throw new GitHostApiError(response.status, await response.text());
  }

  const repo = await readJson<{ mainbranch?: { name: string } }>(response);
  return { defaultBranch: repo.mainbranch?.name ?? "main" };
}
