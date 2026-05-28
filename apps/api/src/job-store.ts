import { randomUUID } from "node:crypto";
import type {
  ClaimedJobPayload,
  EnqueueJobRequest,
  JobRecord,
} from "@fig2code/spec";
import { validatePrunedSpec } from "@fig2code/spec";

export interface StoredJobSecrets {
  gitToken: string;
  atlassianEmail?: string;
  llmToken?: string;
}

export interface StoredJob extends JobRecord {
  request: EnqueueJobRequest;
  secrets: StoredJobSecrets;
}

export interface JobStore {
  enqueue(request: EnqueueJobRequest, secrets: StoredJobSecrets): JobRecord;
  get(id: string): JobRecord | undefined;
  getStored(id: string): StoredJob | undefined;
  claimNext(): ClaimedJobPayload | null;
  update(id: string, patch: Partial<JobRecord>): JobRecord | undefined;
}

export function createJobStore(): JobStore {
  const jobs = new Map<string, StoredJob>();

  return {
    enqueue(request, secrets) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const record: StoredJob = {
        id,
        status: "queued",
        intent: request.intent,
        componentName: request.prunedSpec.name,
        createdAt: now,
        updatedAt: now,
        request,
        secrets,
      };
      jobs.set(id, record);
      return toPublicRecord(record);
    },

    get(id) {
      const stored = jobs.get(id);
      return stored ? toPublicRecord(stored) : undefined;
    },

    getStored(id) {
      return jobs.get(id);
    },

    claimNext() {
      for (const stored of jobs.values()) {
        if (stored.status !== "queued") continue;

        const now = new Date().toISOString();
        stored.status = "running";
        stored.updatedAt = now;

        return {
          jobId: stored.id,
          ...stored.request,
          gitToken: stored.secrets.gitToken,
          atlassianEmail: stored.secrets.atlassianEmail,
          llmToken: stored.secrets.llmToken,
        };
      }
      return null;
    },

    update(id, patch) {
      const stored = jobs.get(id);
      if (!stored) return undefined;

      Object.assign(stored, patch, { updatedAt: new Date().toISOString() });
      return toPublicRecord(stored);
    },
  };
}

export function toPublicRecord(stored: StoredJob): JobRecord {
  return {
    id: stored.id,
    status: stored.status,
    intent: stored.intent,
    componentName: stored.componentName,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    prUrl: stored.prUrl,
    error: stored.error,
    retriesUsed: stored.retriesUsed,
    codegenSummary: stored.codegenSummary,
    changeSummary: stored.changeSummary,
    patchCount: stored.patchCount,
    buildPreview: stored.buildPreview,
  };
}

export { validatePrunedSpec };
