import type { ClaimedJobPayload, JobRecord } from "@fig2code/spec";

export interface WorkerApiClientOptions {
  apiBase: string;
  workerSecret?: string;
  fetchImpl?: typeof fetch;
}

export function createWorkerApiClient(options: WorkerApiClientOptions) {
  const apiBase = options.apiBase.replace(/\/+$/, "");
  const workerSecret = options.workerSecret ?? process.env.WORKER_SECRET ?? "dev-worker-secret";
  const fetchImpl = options.fetchImpl ?? fetch;

  async function claimNext(): Promise<ClaimedJobPayload | null> {
    const res = await fetchImpl(`${apiBase}/internal/worker/claim`, {
      method: "POST",
      headers: {
        "x-worker-secret": workerSecret,
      },
    });

    if (!res.ok) {
      throw new Error(`Worker claim failed (${res.status})`);
    }

    const body = (await res.json()) as { job: ClaimedJobPayload | null };
    return body.job;
  }

  async function patchJob(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const res = await fetchImpl(`${apiBase}/internal/worker/jobs/${jobId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-worker-secret": workerSecret,
      },
      body: JSON.stringify(patch),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Worker patch failed (${res.status})`);
    }

    return (await res.json()) as JobRecord;
  }

  return { claimNext, patchJob };
}

export type WorkerApiClient = ReturnType<typeof createWorkerApiClient>;
