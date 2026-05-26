import type { ClaimedJobPayload, JobRecord } from "@fig2code/spec";
import { validatePrunedSpec } from "@fig2code/spec";

export interface JobPatchClient {
  patchJob(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord>;
}

/**
 * M3 stub: validate PrunedSpec and advance job to `validated`.
 * Clone, LLM codegen, gates, and PR ship in M4–M6.
 */
export async function processJobM3(
  payload: ClaimedJobPayload,
  client: JobPatchClient,
): Promise<JobRecord> {
  const specError = validatePrunedSpec(payload.prunedSpec);
  if (specError) {
    return client.patchJob(payload.jobId, {
      status: "failed",
      error: specError,
    });
  }

  await client.patchJob(payload.jobId, {
    status: "codegen",
  });

  return client.patchJob(payload.jobId, {
    status: "validated",
  });
}
