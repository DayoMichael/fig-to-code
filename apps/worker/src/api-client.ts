import type { ClaimedJobPayload, JobRecord } from "@fig2code/spec";

export interface WorkerApiClientOptions {
  apiBase: string;
  workerSecret?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The worker secret authenticates the claim/patch channel that carries git and
 * LLM tokens. The well-known dev default is only acceptable on a developer
 * machine — in production it would let anyone steal queued job secrets.
 */
export function resolveWorkerSecret(explicit?: string): string {
  const secret = explicit?.trim() || process.env.WORKER_SECRET?.trim();
  if (secret) return secret;
  const isProduction =
    process.env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_ENVIRONMENT);
  if (isProduction) {
    throw new Error(
      "WORKER_SECRET must be set in production — refusing to run with the public dev default",
    );
  }
  console.warn(
    "[fig2code] WORKER_SECRET not set — using the insecure dev default (local development only)",
  );
  return "dev-worker-secret";
}

export function createWorkerApiClient(options: WorkerApiClientOptions) {
  const apiBase = options.apiBase.replace(/\/+$/, "");
  const workerSecret = resolveWorkerSecret(options.workerSecret);
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
