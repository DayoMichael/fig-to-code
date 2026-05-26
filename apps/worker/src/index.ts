import type { CreateJobRequest, JobRecord } from "@fig2code/spec";
import { createGitHostProvider } from "@fig2code/git-host";
import {
  buildRegistryHints,
  loadRegistryFromWorkspace,
  loadSyncConfigFromWorkspace,
} from "@fig2code/repo";
import { formatQaMarkdown, runQualityGates } from "@fig2code/codegen";
import { runWorkerLoop } from "./poll.js";

export interface WorkerJobPayload extends CreateJobRequest {
  jobId: string;
  workspaceRoot: string;
  gitToken: string;
}

export interface WorkerResult {
  job: JobRecord;
  qaMarkdown?: string;
}

const MAX_RETRIES = 3;

/**
 * Stateless job executor — clones repo, hydrates context, codegen, gates, PR.
 * M5/M6 flesh out clone + LLM + PR; M0 wires the orchestration skeleton.
 */
export async function executeJob(payload: WorkerJobPayload): Promise<WorkerResult> {
  const now = new Date().toISOString();
  let job: JobRecord = {
    id: payload.jobId,
    status: "running",
    intent: payload.intent,
    createdAt: now,
    updatedAt: now,
    retriesUsed: 0,
  };

  try {
    const syncConfig = await loadSyncConfigFromWorkspace(payload.workspaceRoot);
    if (!syncConfig) {
      throw new Error("Missing .figma/sync-config.json in workspace");
    }

    const registry = await loadRegistryFromWorkspace(payload.workspaceRoot);
    const registryHints = buildRegistryHints(registry);

    job = { ...job, status: "codegen", updatedAt: new Date().toISOString() };

    // M4: runCodegen with LLMProvider
    void registryHints;
    void payload.prunedSpec;

    job = { ...job, status: "gates", updatedAt: new Date().toISOString() };
    const qa = await runQualityGates({ workspaceRoot: payload.workspaceRoot });
    const qaMarkdown = formatQaMarkdown(qa);

    if (!qa.passed && (job.retriesUsed ?? 0) < MAX_RETRIES) {
      job = {
        ...job,
        status: "needs_manual_fix",
        retriesUsed: MAX_RETRIES,
        updatedAt: new Date().toISOString(),
      };
      return { job, qaMarkdown };
    }

    const git = createGitHostProvider(syncConfig.vcs.provider);
    void git;
    void payload.gitToken;

    job = {
      ...job,
      status: qa.passed ? "pr_opened" : "needs_manual_fix",
      updatedAt: new Date().toISOString(),
    };

    return { job, qaMarkdown };
  } catch (error) {
    job = {
      ...job,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    };
    return { job };
  }
}

async function main(): Promise<void> {
  const apiBase = process.env.API_BASE ?? "http://localhost:3000";
  await runWorkerLoop({ apiBase });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
