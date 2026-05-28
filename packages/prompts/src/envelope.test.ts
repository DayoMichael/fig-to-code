import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildComponentEnvelope, buildComponentUpdateEnvelope } from "./envelope.js";

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

describe("buildComponentUpdateEnvelope", () => {
  it("includes existing_files slot and uses the update profile", () => {
    const envelope = buildComponentUpdateEnvelope({
      profile: "component-update-v1",
      modelId: "anthropic/claude-sonnet",
      jobFacts: {
        intent: "component-update",
        targets: ["web"],
        componentName: "Button",
      },
      prunedSpec: { name: "Button", kind: "component" },
      projectTokens: { categories: {} },
      tokenResolver: {},
      registryHints: { Button: "src/components/Button" },
      exampleStyles: "",
      existingFiles: {
        componentName: "Button",
        files: [
          {
            path: "src/components/Button/Button.tsx",
            role: "component",
            content: "export const Button = () => null;",
          },
        ],
      },
    });

    assert.equal(envelope.profile, "component-update-v1");

    const systemCore = envelope.slots.find((s) => s.id === "system_core")?.content ?? "";
    assert.match(systemCore, /existing_files/);
    assert.match(systemCore, /minimal diff/i);

    const existing = envelope.slots.find((s) => s.id === "existing_files")?.content ?? "";
    assert.match(existing, /Button\.tsx/);
    assert.match(existing, /"role"\s*:\s*"component"/);
  });
});
