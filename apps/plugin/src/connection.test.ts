import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVcs, applySetupOverrides, readSetupOverrides, summarizeDetection, validateLlmApiKey } from "./connection.js";
import type { DetectedProjectConfig } from "@fig2code/spec";

describe("plugin connection helpers", () => {
  it("validates anthropic api key prefix", () => {
    assert.equal(validateLlmApiKey("anthropic", "sk-ant-api03-test"), null);
    assert.match(validateLlmApiKey("anthropic", "sk-proj-openai") ?? "", /sk-ant-/);
  });

  it("builds bitbucket vcs config", () => {
    const vcs = buildVcs("bitbucket", "acme-team", "design-system", "develop", "main");
    assert.equal(vcs.provider, "bitbucket");
    if (vcs.provider === "bitbucket") {
      assert.equal(vcs.workspace, "acme-team");
      assert.equal(vcs.defaultPrTarget, "main");
    }
  });

  it("summarizes detection for UI panel", () => {
    const detected: DetectedProjectConfig = {
      styleSystem: "tailwind",
      componentPaths: ["src/components"],
      tokenPaths: ["tailwind.config.ts"],
      iconPaths: [],
      fontPaths: [],
      exportStyle: "named",
      propsPattern: "interface",
      fileNaming: "PascalCase",
      testFramework: "vitest",
      storyFormat: "csf3",
      hasCodeConnect: false,
      platforms: ["web"],
      existingComponents: [{ name: "Button", path: "src/components/Button/Button.tsx", hasTests: true, hasStories: true, hasCodeConnect: false }],
      existingTokens: null,
    };

    const summary = summarizeDetection(detected);
    assert.match(summary, /tailwind/);
    assert.match(summary, /Button/);
  });

  it("applySetupOverrides updates detected and sync config", () => {
    const detected: DetectedProjectConfig = {
      styleSystem: "css-modules",
      componentPaths: ["packages/ui/src"],
      tokenPaths: [],
      iconPaths: [],
      fontPaths: [],
      exportStyle: "named",
      propsPattern: "interface",
      fileNaming: "PascalCase",
      testFramework: "none",
      storyFormat: "csf3",
      hasCodeConnect: false,
      platforms: ["web"],
      existingComponents: [],
      existingTokens: null,
    };

    const connection = {
      vcs: {
        provider: "bitbucket" as const,
        workspace: "acme",
        repo: "ds",
        baseBranch: "master",
        defaultPrTarget: "master",
      },
      syncConfig: {
        vcs: {
          provider: "bitbucket" as const,
          workspace: "acme",
          repo: "ds",
          baseBranch: "master",
          defaultPrTarget: "master",
        },
        platforms: ["web"],
        conventions: {
          exportStyle: "named" as const,
          propsPattern: "interface" as const,
          fileNaming: "PascalCase" as const,
          testFramework: "none" as const,
          storyFormat: "csf3" as const,
        },
        web: {
          styleSystem: "css-modules" as const,
          componentPath: "packages/ui/src",
          tokenPaths: ["src/tokens"],
          iconPath: "src/icons",
          exampleComponent: "packages/ui/src/Button/Button.tsx",
        },
      },
      detected,
      repoUrl: "bitbucket.org/acme/ds",
      sessionId: "s1",
      connectedAt: "2026-01-01T00:00:00.000Z",
      apiBase: "http://localhost:3000",
    };

    const updated = applySetupOverrides(connection, {
      styleSystem: "css-modules",
      componentPath: "packages/ui/src/components",
      tokenPaths: "packages/ui/src/theme/tokens.css, packages/ui/src/theme/spacing.css",
      iconPath: "packages/ui/src/icons",
      fontPaths: "packages/ui/src/fonts",
      testFramework: "jest",
      storyFormat: "csf3",
      fileNaming: "kebab-case",
      baseBranch: "develop",
      defaultPrTarget: "main",
      notes: "Primitives live under packages/ui/src/primitives",
    });

    assert.equal(updated.detected.componentPaths[0], "packages/ui/src/components");
    assert.equal(updated.syncConfig.web?.componentPath, "packages/ui/src/components");
    assert.deepEqual(updated.syncConfig.web?.tokenPaths, [
      "packages/ui/src/theme/tokens.css",
      "packages/ui/src/theme/spacing.css",
    ]);
    assert.equal(updated.syncConfig.conventions.testFramework, "jest");
    assert.equal(updated.syncConfig.conventions.fileNaming, "kebab-case");
    assert.equal(updated.detected.fileNaming, "kebab-case");
    assert.equal(updated.vcs.baseBranch, "develop");
    assert.equal(updated.syncConfig.llm?.notes, "Primitives live under packages/ui/src/primitives");
    assert.ok(updated.setupCorrectedAt);
  });

  it("readSetupOverrides round-trips saved values", () => {
    const connection = applySetupOverrides(
      {
        vcs: {
          provider: "github" as const,
          owner: "acme",
          repo: "ds",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
        syncConfig: {
          vcs: {
            provider: "github" as const,
            owner: "acme",
            repo: "ds",
            baseBranch: "main",
            defaultPrTarget: "main",
          },
          platforms: ["web"],
          conventions: {
            exportStyle: "named",
            propsPattern: "interface",
            fileNaming: "PascalCase",
            testFramework: "vitest",
            storyFormat: "none",
          },
          web: {
            styleSystem: "tailwind",
            componentPath: "src/components",
            tokenPaths: ["tailwind.config.ts"],
            iconPath: "src/icons",
            exampleComponent: "src/components/Button/Button.tsx",
          },
          llm: { modelId: "anthropic/claude-sonnet", notes: "Use kebab-case files" },
        },
        detected: {
          styleSystem: "tailwind",
          componentPaths: ["src/components"],
          tokenPaths: ["tailwind.config.ts"],
          iconPaths: ["src/icons"],
          fontPaths: [],
          exportStyle: "named",
          propsPattern: "interface",
          fileNaming: "PascalCase",
          testFramework: "vitest",
          storyFormat: "none",
          hasCodeConnect: false,
          platforms: ["web"],
          existingComponents: [],
          existingTokens: null,
        },
        repoUrl: "github.com/acme/ds",
        sessionId: "s1",
        connectedAt: "2026-01-01T00:00:00.000Z",
        apiBase: "http://localhost:3000",
      },
      {
        styleSystem: "tailwind",
        componentPath: "src/components",
        tokenPaths: "tailwind.config.ts",
        iconPath: "src/icons",
        fontPaths: "",
        testFramework: "vitest",
        storyFormat: "none",
        fileNaming: "PascalCase",
        baseBranch: "main",
        defaultPrTarget: "main",
        notes: "Use kebab-case files",
      },
    );

    assert.equal(readSetupOverrides(connection).notes, "Use kebab-case files");
  });
});
