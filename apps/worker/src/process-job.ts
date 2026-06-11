import type { ClaimedJobPayload, JobRecord } from "@fig2code/spec";
import { validatePrunedSpec } from "@fig2code/spec";
import { buildJobPreview, runCodegen } from "@fig2code/codegen";
import type { LLMProvider } from "@fig2code/llm";
import { hydrateCodegenContext, type BundleResolver } from "./hydrate-context.js";
import {
  computeCodegenCacheKey,
  getCachedCodegen,
  setCachedCodegen,
  type CachedCodegenResult,
} from "./codegen-cache.js";

export interface JobPatchClient {
  patchJob(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord>;
}

export interface ProcessJobOptions {
  llmProvider?: LLMProvider;
  apiKey?: string;
  apiBase?: string;
  resolveBundle?: BundleResolver;
  fetchImpl?: typeof fetch;
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

  // Repeat selections of an unchanged component produce an identical LLM
  // request. Replay the prior validated result instead of re-running codegen,
  // which keeps the model call off the per-click preview critical path.
  const cacheKey = computeCodegenCacheKey(payload);
  const cached = getCachedCodegen(cacheKey);
  if (cached) {
    return client.patchJob(payload.jobId, {
      status: "validated",
      patchCount: cached.patchCount,
      codegenSummary: cached.codegenSummary,
      changeSummary: cached.changeSummary,
      buildPreview: cached.buildPreview,
    });
  }

  await client.patchJob(payload.jobId, { status: "codegen" });

  try {
    const context = await hydrateCodegenContext({
      payload,
      llmProvider: options.llmProvider,
      apiKey: options.apiKey,
      apiBase: options.apiBase,
      resolveBundle: options.resolveBundle,
      fetchImpl: options.fetchImpl,
    });
    const result = await runCodegen(context);
    const buildPreview = buildJobPreview({
      patches: result.patches,
      prunedSpec: payload.prunedSpec,
      storyFormat: context.syncConfig.conventions?.storyFormat ?? "none",
      tokenCss: context.syncConfig.tokens?.sourceExcerpt,
      tokenCatalog: context.syncConfig.tokens?.catalog,
      existingFiles: context.existingFiles,
    });

    const validated: CachedCodegenResult = {
      patchCount: result.patches.length,
      codegenSummary:
        result.summary ??
        `Generated ${result.patches.length} patch(es) via ${context.syncConfig.llm?.modelId ?? "anthropic/claude-sonnet"}.`,
      changeSummary: result.changeSummary,
      buildPreview,
    };
    setCachedCodegen(cacheKey, validated);

    return client.patchJob(payload.jobId, {
      status: "validated",
      ...validated,
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
