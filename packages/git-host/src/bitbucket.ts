import type { FilePatch, VcsConfig } from "@fig2code/spec";
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

function isBitbucketDirectoryListing(text: string, _contentType: string | null): boolean {
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
    if (isBitbucketDirectoryListing(text, response.headers.get("content-type"))) {
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
    _vcs: VcsConfig,
    _token: string,
    _branch: string,
    _message: string,
    _patches: FilePatch[],
  ): Promise<string> {
    throw new Error("BitbucketProvider.writeFiles ships in M3 (PR workflow)");
  }

  async openPullRequest(_input: PullRequestInput): Promise<PullRequestResult> {
    throw new Error("BitbucketProvider.openPullRequest ships in M3 (PR workflow)");
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
