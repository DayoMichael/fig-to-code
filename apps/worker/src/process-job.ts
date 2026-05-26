import type { ClaimedJobPayload, JobRecord } from "@fig2code/spec";
import { validatePrunedSpec } from "@fig2code/spec";
import { buildJobPreview, runCodegen } from "@fig2code/codegen";
import type { LLMProvider } from "@fig2code/llm";
import { hydrateCodegenContext } from "./hydrate-context.js";

export interface JobPatchClient {
  patchJob(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord>;
}

export interface ProcessJobOptions {
  llmProvider?: LLMProvider;
  apiKey?: string;
}

/**
 * M4: validate PrunedSpec, hydrate prompt context, invoke LLMProvider, parse patches.
 * Workspace apply, gates, and PR ship in M5–M6.
 */
export async function processJob(
  payload: ClaimedJobPayload,
  client: JobPatchClient,
  options: ProcessJobOptions = {},
): Promise<JobRecord> {
  const specError = validatePrunedSpec(payload.prunedSpec);
  if (specError) {
    return client.patchJob(payload.jobId, {
      status: "failed",
      error: specError,
    });
  }

  await client.patchJob(payload.jobId, { status: "codegen" });

  try {
    const context = await hydrateCodegenContext({
      payload,
      llmProvider: options.llmProvider,
      apiKey: options.apiKey,
    });
    const result = await runCodegen(context);

    return client.patchJob(payload.jobId, {
      status: "validated",
      patchCount: result.patches.length,
      codegenSummary:
        result.summary ??
        `Generated ${result.patches.length} patch(es) via ${context.syncConfig.llm?.modelId ?? "anthropic/claude-sonnet"}.`,
      buildPreview: buildJobPreview({
        patches: result.patches,
        prunedSpec: payload.prunedSpec,
        storyFormat: context.syncConfig.conventions?.storyFormat ?? "none",
        tokenCss: context.syncConfig.tokens?.sourceExcerpt,
      }),
    });
  } catch (error) {
    return client.patchJob(payload.jobId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** @deprecated M3 stub — kept for reference tests */
export { processJobM3 } from "./process-m3.js";
