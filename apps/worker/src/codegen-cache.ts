import { createHash } from "node:crypto";
import type { ClaimedJobPayload, JobRecord } from "@fig2code/spec";

/**
 * In-memory, per-worker cache of validated codegen results.
 *
 * The same Figma component re-selected with an unchanged design produces an
 * identical LLM request, yet every click otherwise re-runs a full (multi-second)
 * model completion on the critical path before the preview can render. Caching
 * the validated outcome by a content hash of the inputs that determine the
 * output lets a repeat selection skip both context hydration and the LLM call.
 *
 * The key intentionally covers spec + model + intent + the sync config (which
 * carries `llm.modelId`), plus the update-only inputs (`bundleId`,
 * `previewFileOverrides`) that change an update's output. Any real design or
 * configuration change alters the hash and misses the cache, so we never serve
 * a stale component.
 */

/** The validated fields we replay on a cache hit (everything except status). */
export type CachedCodegenResult = Pick<
  JobRecord,
  "patchCount" | "codegenSummary" | "changeSummary" | "buildPreview"
>;

/** Cap entries so a long-lived worker can't grow unbounded. Oldest evicted first. */
const MAX_ENTRIES = 50;

const cache = new Map<string, CachedCodegenResult>();

/**
 * Stable JSON: recursively sort object keys so semantically-equal payloads hash
 * identically regardless of property order. Arrays keep their order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function computeCodegenCacheKey(payload: ClaimedJobPayload): string {
  const keyInputs = {
    intent: payload.intent,
    prunedSpec: payload.prunedSpec,
    syncConfig: payload.syncConfig,
    bundleId: payload.bundleId ?? null,
    previewFileOverrides: payload.previewFileOverrides ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(keyInputs)))
    .digest("hex");
}

export function getCachedCodegen(key: string): CachedCodegenResult | undefined {
  return cache.get(key);
}

export function setCachedCodegen(key: string, result: CachedCodegenResult): void {
  // Refresh recency: delete then re-insert so iteration order is LRU-ish.
  cache.delete(key);
  cache.set(key, result);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Test/maintenance hook. */
export function clearCodegenCache(): void {
  cache.clear();
}
