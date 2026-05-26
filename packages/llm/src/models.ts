export interface ModelDefinition {
  modelId: string;
  provider: "anthropic" | "openai";
  label: string;
  apiModelId: string;
  maxContextHint?: number;
}

function anthropic(
  slug: string,
  apiModelId: string,
  maxContextHint = 200_000,
): ModelDefinition {
  return {
    modelId: `anthropic/${slug}`,
    provider: "anthropic",
    label: slug,
    apiModelId,
    maxContextHint,
  };
}

function openai(slug: string, apiModelId = slug, maxContextHint = 128_000): ModelDefinition {
  return {
    modelId: `openai/${slug}`,
    provider: "openai",
    label: slug,
    apiModelId,
    maxContextHint,
  };
}

/** Deployment allowlist — newest models first within each provider. */
export const MODEL_CATALOG: readonly ModelDefinition[] = [
  anthropic("claude-opus-4-7", "claude-opus-4-7", 1_000_000),
  anthropic("claude-sonnet-4-6", "claude-sonnet-4-6", 1_000_000),
  anthropic("claude-haiku-4-5", "claude-haiku-4-5", 200_000),
  anthropic("claude-opus-4-6", "claude-opus-4-6", 1_000_000),
  anthropic("claude-sonnet-4-5", "claude-sonnet-4-5", 200_000),
  anthropic("claude-opus-4-5", "claude-opus-4-5", 200_000),
  anthropic("claude-opus-4-1", "claude-opus-4-1", 200_000),
  anthropic("claude-sonnet-4", "claude-sonnet-4-20250514", 200_000),
  anthropic("claude-opus-4", "claude-opus-4-20250514", 200_000),
  anthropic("claude-3-7-sonnet", "claude-3-7-sonnet-20250219", 200_000),
  anthropic("claude-3-5-sonnet", "claude-3-5-sonnet-20241022", 200_000),
  anthropic("claude-3-5-haiku", "claude-3-5-haiku-20241022", 200_000),
  anthropic("claude-3-opus", "claude-3-opus-20240229", 200_000),
  anthropic("claude-3-haiku", "claude-3-haiku-20240307", 200_000),
  anthropic("claude-sonnet", "claude-sonnet-4-6", 1_000_000),
  anthropic("claude-opus", "claude-opus-4-7", 1_000_000),

  openai("gpt-5.5", "gpt-5.5", 256_000),
  openai("gpt-5.5-pro", "gpt-5.5-pro", 256_000),
  openai("gpt-5.4", "gpt-5.4", 256_000),
  openai("gpt-5.4-mini", "gpt-5.4-mini", 256_000),
  openai("gpt-5.4-nano", "gpt-5.4-nano", 128_000),
  openai("gpt-5.3-chat-latest", "gpt-5.3-chat-latest", 256_000),
  openai("gpt-5.2", "gpt-5.2", 256_000),
  openai("gpt-5.2-pro", "gpt-5.2-pro", 256_000),
  openai("gpt-5.1", "gpt-5.1", 256_000),
  openai("gpt-5.1-mini", "gpt-5.1-mini", 256_000),
  openai("gpt-5.1-codex", "gpt-5.1-codex", 256_000),
  openai("gpt-5", "gpt-5", 256_000),
  openai("gpt-5-mini", "gpt-5-mini", 256_000),
  openai("gpt-5-nano", "gpt-5-nano", 128_000),
  openai("gpt-5-pro", "gpt-5-pro", 256_000),
  openai("gpt-5-codex", "gpt-5-codex", 256_000),
  openai("gpt-4.1", "gpt-4.1", 128_000),
  openai("gpt-4.1-mini", "gpt-4.1-mini", 128_000),
  openai("gpt-4.1-nano", "gpt-4.1-nano", 128_000),
  openai("o4-mini", "o4-mini", 200_000),
  openai("o3", "o3", 200_000),
  openai("o3-pro", "o3-pro", 200_000),
  openai("o3-mini", "o3-mini", 200_000),
  openai("o1", "o1", 200_000),
  openai("o1-pro", "o1-pro", 200_000),
  openai("o1-mini", "o1-mini", 128_000),
  openai("gpt-4o", "gpt-4o", 128_000),
  openai("gpt-4o-mini", "gpt-4o-mini", 128_000),
  openai("gpt-4-turbo", "gpt-4-turbo", 128_000),
] as const;

export const DEFAULT_ALLOWLIST = MODEL_CATALOG.map((model) => model.modelId) as readonly string[];

export const ANTHROPIC_API_MODELS: Record<string, string> = Object.fromEntries(
  MODEL_CATALOG.filter((model) => model.provider === "anthropic").map((model) => {
    const slug = model.modelId.split("/")[1] ?? model.label;
    return [slug, model.apiModelId];
  }),
);

export const OPENAI_API_MODELS: Record<string, string> = Object.fromEntries(
  MODEL_CATALOG.filter((model) => model.provider === "openai").map((model) => {
    const slug = model.modelId.split("/")[1] ?? model.label;
    return [slug, model.apiModelId];
  }),
);
