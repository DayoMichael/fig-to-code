import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnthropicProvider } from "./anthropic.js";
import { DEFAULT_ALLOWLIST } from "./types.js";

describe("AnthropicProvider", () => {
  it("calls the Messages API with envelope content", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const provider = new AnthropicProvider({
      allowlist: DEFAULT_ALLOWLIST,
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: '{"patches":[],"summary":"ok"}' }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const raw = await provider.complete({
      apiKey: "test-key",
      envelope: {
        profile: "component-v1",
        modelId: "anthropic/claude-sonnet",
        slots: [
          { id: "system_core", content: "system rules" },
          { id: "output_contract", content: "{}" },
          { id: "pruned_spec", content: '{"name":"Button"}' },
        ],
      },
    });

    assert.match(capturedUrl, /\/v1\/messages$/);
    assert.equal(capturedBody.model, "claude-sonnet-4-6");
    assert.equal(capturedBody.system, "## system_core\nsystem rules\n\n## output_contract\n{}");
    assert.match(raw, /"patches"/);
  });

  it("surfaces Anthropic API errors", async () => {
    const provider = new AnthropicProvider({
      allowlist: DEFAULT_ALLOWLIST,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
          status: 401,
        }),
    });

    await assert.rejects(
      () =>
        provider.complete({
          apiKey: "bad",
          envelope: {
            profile: "component-v1",
            modelId: "anthropic/claude-sonnet",
            slots: [{ id: "system_core", content: "x" }],
          },
        }),
      /invalid api key/,
    );
  });
});
