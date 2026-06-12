import type { PromptEnvelope, RepairEnvelope } from "@fig2code/spec";

export interface LlmCompletionRequest {
  envelope: PromptEnvelope | RepairEnvelope;
  apiKey: string;
  /**
   * Called with each text delta as the model streams. Providers that don't
   * support streaming ignore it; `complete` always resolves the full text.
   */
  onText?: (delta: string) => void;
}

export interface ResolvedModel {
  provider: string;
  normalizedModelId: string;
}

export interface LLMProvider {
  readonly providerId: string;
  resolveModel(modelId: string): ResolvedModel;
  complete(request: LlmCompletionRequest): Promise<string>;
}

export class UnknownModelError extends Error {
  constructor(modelId: string) {
    super(`Model "${modelId}" is not on the deployment allowlist`);
    this.name = "UnknownModelError";
  }
}

export { DEFAULT_ALLOWLIST } from "./models.js";
export type { ModelDefinition } from "./models.js";
