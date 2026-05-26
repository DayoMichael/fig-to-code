import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrunedSpec, SyncConfig } from "./index.js";

describe("@fig2code/spec", () => {
  it("exports PrunedSpec shape used by MVP Button flow", () => {
    const spec: PrunedSpec = {
      name: "Button",
      kind: "component",
      variants: {
        variant: ["primary", "secondary"],
        size: ["sm", "md"],
      },
      slots: {
        label: { type: "text", required: true },
      },
      styles: {
        "primary+md+default": {
          bg: "token:color/primary/500",
        },
      },
    };

    assert.equal(spec.name, "Button");
  });

  it("exports SyncConfig with llm block", () => {
    const config: SyncConfig = {
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
      },
    };

    assert.equal(config.llm?.modelId, "anthropic/claude-sonnet");
  });
});
