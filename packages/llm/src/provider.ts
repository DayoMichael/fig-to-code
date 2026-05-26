import { AnthropicProvider } from "./anthropic.js";
import type { FetchImpl } from "./anthropic.js";
import {
  DEFAULT_ALLOWLIST,
  UnknownModelError,
  type LlmCompletionRequest,
  type LLMProvider,
} from "./types.js";

export type { LlmCompletionRequest, LLMProvider, ResolvedModel } from "./types.js";
export { DEFAULT_ALLOWLIST, UnknownModelError } from "./types.js";

export interface CreateLlmProviderOptions {
  allowlist?: readonly string[];
  fetchImpl?: FetchImpl;
}

export function createLlmProvider(
  provider: string,
  options: CreateLlmProviderOptions = {},
): LLMProvider {
  const allowlist = options.allowlist ?? DEFAULT_ALLOWLIST;

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider({ allowlist, fetchImpl: options.fetchImpl });
    case "openai":
      return new OpenAiProviderStub(allowlist);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

export function resolveProviderFromModelId(modelId: string): string {
  const [provider] = modelId.split("/");
  if (!provider) throw new UnknownModelError(modelId);
  return provider;
}

export function createLlmProviderForModel(
  modelId: string,
  options: CreateLlmProviderOptions = {},
): LLMProvider {
  return createLlmProvider(resolveProviderFromModelId(modelId), options);
}

abstract class BaseProviderStub implements LLMProvider {
  constructor(
    readonly providerId: string,
    private readonly allowlist: readonly string[],
  ) {}

  resolveModel(modelId: string) {
    if (!this.allowlist.includes(modelId as (typeof DEFAULT_ALLOWLIST)[number])) {
      throw new UnknownModelError(modelId);
    }
    const [, slug] = modelId.split("/");
    return { provider: this.providerId, normalizedModelId: slug ?? modelId };
  }

  abstract complete(request: LlmCompletionRequest): Promise<string>;
}

/** Second vendor stub — keeps LLMProvider portability honest early. */
class OpenAiProviderStub extends BaseProviderStub {
  constructor(allowlist: readonly string[]) {
    super("openai", allowlist);
  }

  async complete(_request: LlmCompletionRequest): Promise<string> {
    throw new Error("OpenAI provider ships after Anthropic MVP adapter");
  }
}

export {
  parseCodegenOutput,
  extractCodegenJson,
  repairInvalidJsonEscapes,
  validateCodegenOutput,
} from "./parse.js";
