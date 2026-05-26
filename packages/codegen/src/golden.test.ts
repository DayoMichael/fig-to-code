import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MockLlmProvider, parseCodegenOutput } from "@fig2code/llm";
import type { PrunedSpec } from "@fig2code/spec";
import { runCodegen } from "./pipeline.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const goldenPrunedSpec = JSON.parse(
  readFileSync(join(repoRoot, "prompts/fixtures/golden-button-pruned-spec.json"), "utf8"),
) as PrunedSpec;
const goldenResponse = readFileSync(
  join(repoRoot, "llm/fixtures/golden-codegen-response.json"),
  "utf8",
);

describe("golden codegen flow", () => {
  it("runs codegen against the golden response fixture", async () => {
    const mock = new MockLlmProvider({
      allowlist: ["anthropic/claude-sonnet"],
      response: goldenResponse,
    });

    const result = await runCodegen({
      syncConfig: {
        vcs: {
          provider: "github",
          owner: "acme",
          repo: "app",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
        platforms: ["web"],
        web: {
          styleSystem: "tailwind",
          componentPath: "src/components",
          tokenPaths: ["tailwind.config.ts"],
          iconPath: "src/icons",
          exampleComponent: "src/components/Button/Button.tsx",
        },
        conventions: {
          exportStyle: "named",
          propsPattern: "interface",
          fileNaming: "PascalCase",
          testFramework: "vitest",
          storyFormat: "csf3",
        },
        llm: { modelId: "anthropic/claude-sonnet", promptProfile: "component-v1" },
      },
      prunedSpec: goldenPrunedSpec,
      projectTokens: { categories: {} },
      tokenResolver: {},
      registryHints: { Button: "src/components/Button" },
      exampleStyles: "// example",
      apiKey: "test-key",
      llmProvider: mock,
    });

    assert.equal(result.patches.length, 2);
    assert.match(result.summary ?? "", /Generated Button/);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]?.envelope.modelId, "anthropic/claude-sonnet");
  });

  it("includes team notes in the codegen prompt when configured", async () => {
    const mock = new MockLlmProvider({
      allowlist: ["anthropic/claude-sonnet"],
      response: goldenResponse,
    });

    await runCodegen({
      syncConfig: {
        vcs: {
          provider: "github",
          owner: "acme",
          repo: "app",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
        platforms: ["web"],
        web: {
          styleSystem: "tailwind",
          componentPath: "src/components",
          tokenPaths: ["tailwind.config.ts"],
          iconPath: "src/icons",
          exampleComponent: "src/components/Button/Button.tsx",
        },
        conventions: {
          exportStyle: "named",
          propsPattern: "interface",
          fileNaming: "PascalCase",
          testFramework: "vitest",
          storyFormat: "csf3",
        },
        llm: {
          modelId: "anthropic/claude-sonnet",
          promptProfile: "component-v1",
          notes: "Corrections:\nUse rounded-full for pill buttons.",
        },
      },
      prunedSpec: goldenPrunedSpec,
      projectTokens: { categories: {} },
      tokenResolver: {},
      registryHints: { Button: "src/components/Button" },
      exampleStyles: "// example",
      apiKey: "test-key",
      llmProvider: mock,
    });

    const jobFacts = mock.calls[0]?.envelope.slots.find((slot) => slot.id === "job_facts");
    assert.match(jobFacts?.content ?? "", /Corrections:/);
    assert.match(jobFacts?.content ?? "", /rounded-full/);
  });

  it("golden model output parses to the same patch count", () => {
    const output = parseCodegenOutput(goldenResponse);
    assert.equal(output.patches.length, 2);
  });
});
