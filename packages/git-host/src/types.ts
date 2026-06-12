import type { FilePatch } from "@fig2code/spec";
import type { VcsConfig } from "@fig2code/spec";
import type { GitHostAuth } from "./auth.js";

export type { GitHostAuth } from "./auth.js";

export interface GitHostCapabilities {
  provider: string;
  supportsAtomicMultiFileCommit: boolean;
  supportsPullRequests: boolean;
}

export interface RefSummary {
  name: string;
  sha?: string;
}

export interface CloneOptions {
  vcs: VcsConfig;
  token: string;
  targetDir: string;
  branch?: string;
  /** Distinguishes Bitbucket API tokens (email-paired) from OAuth/repo tokens for the git username. */
  atlassianEmail?: string;
}

/** A repository the authenticated user can access — for the connect-time picker. */
export interface RepositorySummary {
  provider: "github" | "bitbucket";
  /** "owner/repo" or "workspace/repo" — display label and stable id. */
  fullName: string;
  /** GitHub owner or Bitbucket workspace. */
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
}

export interface PullRequestInput {
  vcs: VcsConfig;
  token: string;
  atlassianEmail?: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface WriteFilesInput {
  headBranch: string;
  baseBranch: string;
  message: string;
  patches: FilePatch[];
}

export interface PullRequestResult {
  url: string;
  number?: number;
}

export interface GitHostProvider {
  readonly capabilities: GitHostCapabilities;

  cloneRepo(options: CloneOptions): Promise<void>;
  readFile(vcs: VcsConfig, auth: GitHostAuth | string, path: string, ref?: string): Promise<string | null>;
  listRefs(vcs: VcsConfig, auth: GitHostAuth | string): Promise<RefSummary[]>;
  writeFiles(
    vcs: VcsConfig,
    auth: GitHostAuth | string,
    input: WriteFilesInput,
  ): Promise<string>;
  openPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
  /** List repositories the authenticated user can access (for the connect picker). */
  listRepositories(auth: GitHostAuth | string): Promise<RepositorySummary[]>;
}
