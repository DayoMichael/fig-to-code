import type { LlmCompletionRequest, LLMProvider, ResolvedModel } from "./types.js";
import { UnknownModelError } from "./types.js";

export interface MockLlmProviderOptions {
  providerId?: string;
  allowlist: readonly string[];
  response: string | ((request: LlmCompletionRequest) => string | Promise<string>);
}

export class MockLlmProvider implements LLMProvider {
  readonly providerId: string;
  readonly calls: LlmCompletionRequest[] = [];
  private readonly allowlist: readonly string[];
  private readonly response: MockLlmProviderOptions["response"];

  constructor(options: MockLlmProviderOptions) {
    this.providerId = options.providerId ?? "mock";
    this.allowlist = options.allowlist;
    this.response = options.response;
  }

  resolveModel(modelId: string): ResolvedModel {
    if (!this.allowlist.includes(modelId as (typeof this.allowlist)[number])) {
      throw new UnknownModelError(modelId);
    }

    const [, slug] = modelId.split("/");
    return { provider: this.providerId, normalizedModelId: slug ?? modelId };
  }

  async complete(request: LlmCompletionRequest): Promise<string> {
    this.calls.push(request);
    return typeof this.response === "function"
      ? await this.response(request)
      : this.response;
  }
}
