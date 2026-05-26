import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLlmProviderForModel,
  parseCodegenOutput,
  UnknownModelError,
} from "./provider.js";

describe("llm", () => {
  it("resolves anthropic provider from model id", () => {
    const provider = createLlmProviderForModel("anthropic/claude-sonnet");
    assert.equal(provider.providerId, "anthropic");
  });

  it("rejects unknown models", () => {
    const provider = createLlmProviderForModel("anthropic/claude-sonnet");
    assert.throws(
      () => provider.resolveModel("anthropic/not-allowed"),
      UnknownModelError,
    );
  });

  it("parses codegen JSON output", () => {
    const output = parseCodegenOutput(
      JSON.stringify({ patches: [{ path: "a.tsx", action: "create", content: "" }] }),
    );
    assert.equal(output.patches.length, 1);
  });
});
