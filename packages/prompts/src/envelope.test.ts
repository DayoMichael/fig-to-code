import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildComponentEnvelope } from "./envelope.js";

describe("buildComponentEnvelope", () => {
  it("assembles named slots with token estimates", () => {
    const envelope = buildComponentEnvelope({
      profile: "component-v1",
      modelId: "anthropic/claude-sonnet",
      jobFacts: { intent: "component", targets: ["web"] },
      prunedSpec: { name: "Button" },
      projectTokens: { categories: {} },
      tokenResolver: { "color/primary/500": "primary-500" },
      registryHints: { Button: "src/components/Button" },
      exampleStyles: "export const Button = () => null;",
    });

    assert.equal(envelope.profile, "component-v1");
    assert.ok(envelope.slots.some((s) => s.id === "pruned_spec"));
    assert.ok((envelope.estimatedTotalTokens ?? 0) > 0);
    assert.match(
      envelope.slots.find((s) => s.id === "system_core")?.content ?? "",
      /token_resolver/,
    );
  });
});
