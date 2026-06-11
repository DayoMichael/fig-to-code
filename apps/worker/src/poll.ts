import type { ClaimedJobPayload } from "@fig2code/spec";
import { createWorkerApiClient, type WorkerApiClient } from "./api-client.js";
import { processJob, type ProcessJobOptions } from "./process-job.js";

export interface WorkerPollOptions extends ProcessJobOptions {
  apiBase?: string;
  pollIntervalMs?: number;
  client?: WorkerApiClient;
  processJobFn?: typeof processJob;
}

export async function pollAndProcessOnce(
  options: WorkerPollOptions = {},
): Promise<boolean> {
  const client =
    options.client ??
    createWorkerApiClient({
      apiBase: options.apiBase ?? process.env.API_BASE ?? "http://localhost:3000",
    });
  const processJobFn = options.processJobFn ?? processJob;

  const claimed = await client.claimNext();
  if (!claimed) {
    return false;
  }

  await processJobFn(claimed, client, options);
  return true;
}

export async function runWorkerLoop(options: WorkerPollOptions = {}): Promise<never> {
  // Idle back-off between claim attempts. Kept short — this is dead time
  // between a designer's click and the job being picked up. Override with
  // WORKER_POLL_MS if the claim endpoint is remote/rate-limited.
  const intervalMs = options.pollIntervalMs ?? Number(process.env.WORKER_POLL_MS ?? 200);
  const apiBase = options.apiBase ?? process.env.API_BASE ?? "http://localhost:3000";

  console.log(`Fig2Code worker polling ${apiBase} every ${intervalMs}ms when idle`);

  for (;;) {
    let processed = false;
    try {
      processed = await pollAndProcessOnce({ ...options, apiBase });
    } catch (error) {
      console.error(
        "Worker poll error:",
        error instanceof Error ? error.message : String(error),
      );
    }
    // Drain the queue immediately when there is work; only back off when idle so
    // a fresh push isn't waiting a full interval to be claimed.
    if (!processed) {
      await sleep(intervalMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processClaimedJob(
  payload: ClaimedJobPayload,
  client: WorkerApiClient,
  options: ProcessJobOptions = {},
): Promise<void> {
  await processJob(payload, client, options);
}
