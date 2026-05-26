import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildComponentEnvelope } from "./envelope.js";
import type { PrunedSpec } from "@fig2code/spec";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const goldenPrunedSpec = JSON.parse(
  readFileSync(join(fixturesDir, "golden-button-pruned-spec.json"), "utf8"),
) as PrunedSpec;

describe("golden component envelope", () => {
  it("builds a stable component-v1 envelope for the golden Button spec", () => {
    const envelope = buildComponentEnvelope({
      profile: "component-v1",
      modelId: "anthropic/claude-sonnet",
      jobFacts: {
        intent: "component",
        targets: ["web"],
        conventions: {
          exportStyle: "named",
          propsPattern: "interface",
          fileNaming: "PascalCase",
          testFramework: "vitest",
          storyFormat: "csf3",
        },
      },
      prunedSpec: goldenPrunedSpec,
      projectTokens: {
        sourcePath: "tailwind.config.ts",
        format: "tailwind-config",
        categories: { color: [], spacing: [], radius: [], typography: [], fontFamily: [] },
      },
      tokenResolver: { "color/primary/500": "bg-primary-500" },
      registryHints: { Button: "src/components/Button" },
      exampleStyles: "export function Button() { return null; }",
    });

    assert.deepEqual(
      envelope.slots.map((slot) => slot.id),
      [
        "system_core",
        "job_facts",
        "pruned_spec",
        "project_tokens",
        "token_resolver",
        "registry_hints",
        "example_styles",
        "output_contract",
      ],
    );
    assert.equal(envelope.profile, "component-v1");
    assert.equal(envelope.modelId, "anthropic/claude-sonnet");
    assert.ok((envelope.estimatedTotalTokens ?? 0) > 100);
    assert.match(
      envelope.slots.find((slot) => slot.id === "pruned_spec")?.content ?? "",
      /"name":"Button"/,
    );
  });
});
