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

    const stream = Boolean(request.onText);
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
        ...(stream ? { stream: true } : {}),
      }),
    });

    if (!response.ok) {
      // Error responses are plain JSON even on streaming requests.
      const body = (await response.json().catch(() => ({}))) as AnthropicMessageResponse;
      const err = body.error;
      const message = err?.message ?? `Anthropic API error (${response.status})`;
      const prefix = err?.type ? `${err.type}: ` : "";
      throw new Error(`${prefix}${message}`);
    }

    const text = stream
      ? await this.readStreamedText(response, request.onText!)
      : await readCompletionText(response);

    if (!text) {
      throw new Error("Anthropic API returned empty completion");
    }

    return text;
  }

  /** Consume an SSE Messages stream, forwarding text deltas as they arrive. */
  private async readStreamedText(
    response: Response,
    onText: (delta: string) => void,
  ): Promise<string> {
    if (!response.body) {
      throw new Error("Anthropic API returned no response body for stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let text = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; keep the trailing partial.
      const events = buffered.split("\n\n");
      buffered = events.pop() ?? "";

      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let payload: {
            type?: string;
            delta?: { type?: string; text?: string };
            error?: { type?: string; message?: string };
          };
          try {
            payload = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (payload.type === "error" || payload.error) {
            const err = payload.error;
            throw new Error(
              `${err?.type ? `${err.type}: ` : ""}${err?.message ?? "Anthropic stream error"}`,
            );
          }
          if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") {
            const delta = payload.delta.text ?? "";
            if (delta) {
              text += delta;
              onText(delta);
            }
          }
        }
      }
    }

    return text.trim();
  }
}

async function readCompletionText(response: Response): Promise<string> {
  const body = (await response.json()) as AnthropicMessageResponse;
  return (
    body.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim() ?? ""
  );
}
