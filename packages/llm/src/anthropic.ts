import type { LlmCompletionRequest, LLMProvider, ResolvedModel } from "./types.js";
import { UnknownModelError } from "./types.js";
import { envelopeToMessages } from "./messages.js";

export type FetchImpl = typeof fetch;

export interface AnthropicProviderOptions {
  allowlist: readonly string[];
  fetchImpl?: FetchImpl;
  apiBaseUrl?: string;
}

import { ANTHROPIC_API_MODELS } from "./models.js";

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { type?: string; message?: string };
}

export class AnthropicProvider implements LLMProvider {
  readonly providerId = "anthropic";
  private readonly allowlist: readonly string[];
  private readonly fetchImpl: FetchImpl;
  private readonly apiBaseUrl: string;

  constructor(options: AnthropicProviderOptions) {
    this.allowlist = options.allowlist;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.anthropic.com";
  }

  resolveModel(modelId: string): ResolvedModel {
    if (!this.allowlist.includes(modelId as (typeof this.allowlist)[number])) {
      throw new UnknownModelError(modelId);
    }

    const [, slug] = modelId.split("/");
    const normalizedModelId = slug ?? modelId;
    return { provider: this.providerId, normalizedModelId };
  }

  async complete(request: LlmCompletionRequest): Promise<string> {
    const { normalizedModelId } = this.resolveModel(request.envelope.modelId);
    const apiModel = ANTHROPIC_API_MODELS[normalizedModelId] ?? normalizedModelId;
    const messages = envelopeToMessages(request.envelope);

    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const userMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content }));

    const response = await this.fetchImpl(`${this.apiBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": request.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: apiModel,
        max_tokens: 8192,
        system,
        messages: userMessages,
      }),
    });

    const body = (await response.json()) as AnthropicMessageResponse;

    if (!response.ok) {
      const err = body.error;
      const message = err?.message ?? `Anthropic API error (${response.status})`;
      const prefix = err?.type ? `${err.type}: ` : "";
      throw new Error(`${prefix}${message}`);
    }

    const text = body.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();

    if (!text) {
      throw new Error("Anthropic API returned empty completion");
    }

    return text;
  }
}
