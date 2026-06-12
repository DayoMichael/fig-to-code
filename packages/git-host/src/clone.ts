import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VcsConfig } from "@fig2code/spec";
import { cloneUrl, defaultBranch } from "./vcs.js";

const execFileAsync = promisify(execFile);

export interface CloneRepoOptions {
  vcs: VcsConfig;
  token: string;
  targetDir: string;
  branch?: string;
  /** Distinguishes Bitbucket API tokens (email-paired) from OAuth/repo tokens for the git username. */
  atlassianEmail?: string;
}

export async function cloneRepository(options: CloneRepoOptions): Promise<void> {
  const branch = options.branch ?? defaultBranch(options.vcs);
  const url = cloneUrl(options.vcs, options.token, {
    atlassianEmail: options.atlassianEmail,
  });

  try {
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--branch", branch, url, options.targetDir],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      throw new Error("git is not installed or not on PATH");
    }
    throw new Error(`git clone failed: ${message}`);
  }
}
