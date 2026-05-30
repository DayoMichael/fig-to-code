import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DetectedProjectConfig, Registry, SyncConfig } from "@fig2code/spec";
import { resolveComponentBundle } from "./resolve-component.js";

const baseSyncConfig: SyncConfig = {
  vcs: {
    provider: "github",
    owner: "acme",
    repo: "design-system",
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
};

describe("resolveComponentBundle", () => {
  it("returns null when no candidate file is found", async () => {
    const bundle = await resolveComponentBundle({
      componentName: "Button",
      syncConfig: baseSyncConfig,
      readFile: async () => null,
    });
    assert.equal(bundle, null);
  });

  it("matches via convention path and collects colocated files", async () => {
    const files: Record<string, string> = {
      "src/components/Button/Button.tsx": "export const Button = () => null;",
      "src/components/Button/Button.stories.tsx":
        "export default { component: Button };",
      "src/components/Button/index.ts": "export * from './Button';",
    };
    const bundle = await resolveComponentBundle({
      componentName: "Button",
      syncConfig: baseSyncConfig,
      readFile: async (path) => files[path] ?? null,
    });

    assert.ok(bundle);
    assert.equal(bundle!.componentName, "Button");
    assert.equal(bundle!.primaryComponentPath, "src/components/Button/Button.tsx");
    assert.equal(bundle!.storyPath, "src/components/Button/Button.stories.tsx");
    assert.equal(bundle!.barrelPath, "src/components/Button/index.ts");
    assert.equal(bundle!.match.source, "convention");
    assert.deepEqual(
      bundle!.files.map((f) => f.role).sort(),
      ["barrel", "component", "story"],
    );
  });

  it("prefers registry path when available", async () => {
    const registry: Registry = {
      components: {
        Button: {
          figmaNodeId: "1:1",
          lastSynced: new Date().toISOString(),
          hash: "deadbeef",
          codePaths: { web: "packages/ui/src/Button.tsx" },
        },
      },
      screens: {},
    };

    const files: Record<string, string> = {
      "packages/ui/src/Button.tsx": "export const Button = () => null;",
    };

    const bundle = await resolveComponentBundle({
      componentName: "Button",
      syncConfig: baseSyncConfig,
      registry,
      readFile: async (path) => files[path] ?? null,
    });

    assert.ok(bundle);
    assert.equal(bundle!.match.source, "registry");
    assert.equal(bundle!.primaryComponentPath, "packages/ui/src/Button.tsx");
  });

  it("prefers detected component path before falling back to conventions", async () => {
    const detected: DetectedProjectConfig = {
      styleSystem: "tailwind",
      componentPaths: ["src/components"],
      tokenPaths: [],
      iconPaths: [],
      fontPaths: [],
      exportStyle: "named",
      propsPattern: "interface",
      fileNaming: "PascalCase",
      testFramework: "vitest",
      storyFormat: "csf3",
      formatter: "none",
      hasCodeConnect: false,
      platforms: ["web"],
      existingComponents: [
        {
          name: "Button",
          path: "src/components/forms/Button/Button.tsx",
          hasTests: true,
          hasStories: true,
          hasCodeConnect: false,
        },
      ],
      existingTokens: null,
    };

    const files: Record<string, string> = {
      "src/components/forms/Button/Button.tsx":
        "export const Button = () => null;",
    };

    const bundle = await resolveComponentBundle({
      componentName: "Button",
      syncConfig: baseSyncConfig,
      detected,
      readFile: async (path) => files[path] ?? null,
    });

    assert.ok(bundle);
    assert.equal(bundle!.match.source, "detected");
    assert.equal(
      bundle!.primaryComponentPath,
      "src/components/forms/Button/Button.tsx",
    );
  });

  it("resolves spaced Figma names to PascalCase stories", async () => {
    const files: Record<string, string> = {
      "packages/ui/src/components/ui/inline-alert.tsx":
        "export const InlineAlert = () => null;",
      "apps/storybook/src/stories/InlineAlert.stories.tsx": `
const meta = { args: { type: "Warning" } };
export default meta;
`,
    };

    const bundle = await resolveComponentBundle({
      componentName: "Inline Alert",
      syncConfig: {
        ...baseSyncConfig,
        web: {
          ...baseSyncConfig.web!,
          componentPath: "packages/ui/src/components/ui",
        },
      },
      readFile: async (path) => files[path] ?? null,
    });

    assert.ok(bundle);
    assert.equal(bundle!.componentName, "InlineAlert");
    assert.equal(
      bundle!.storyPath,
      "apps/storybook/src/stories/InlineAlert.stories.tsx",
    );
  });

  it("falls back to apps/storybook stories when no colocated story exists", async () => {
    const files: Record<string, string> = {
      "packages/ui/src/components/ui/avatar.tsx":
        "export const Avatar = () => null;",
      "apps/storybook/src/stories/Avatar.stories.tsx": `
const meta = { args: { type: "Initial", initials: "JD" } };
export default meta;
`,
    };

    const bundle = await resolveComponentBundle({
      componentName: "Avatar",
      syncConfig: {
        ...baseSyncConfig,
        web: {
          ...baseSyncConfig.web!,
          componentPath: "packages/ui/src/components/ui",
        },
      },
      readFile: async (path) => files[path] ?? null,
    });

    assert.ok(bundle);
    assert.equal(
      bundle!.storyPath,
      "apps/storybook/src/stories/Avatar.stories.tsx",
    );
    assert.equal(
      bundle!.files.find((file) => file.role === "story")?.path,
      "apps/storybook/src/stories/Avatar.stories.tsx",
    );
  });

  it("includes package index and monorepo test in the bundle", async () => {
    const files: Record<string, string> = {
      "packages/ui/src/components/ui/inline-alert.tsx":
        "export const InlineAlert = () => null;",
      "apps/storybook/src/stories/InlineAlert.stories.tsx":
        "export const Default = { args: {} };",
      "packages/ui/src/index.ts":
        "export { Button } from './components/ui/button';\nexport { Avatar } from './components/ui/avatar';\n",
      "packages/ui/src/__tests__/inline-alert.test.tsx":
        "describe('InlineAlert', () => { it('renders', () => {}); });",
    };

    const bundle = await resolveComponentBundle({
      componentName: "InlineAlert",
      syncConfig: {
        ...baseSyncConfig,
        web: {
          ...baseSyncConfig.web!,
          componentPath: "packages/ui/src/components/ui",
        },
      },
      readFile: async (path) => files[path] ?? null,
    });

    assert.ok(bundle);
    assert.equal(
      bundle!.files.find((file) => file.role === "related")?.path,
      "packages/ui/src/index.ts",
    );
    assert.equal(
      bundle!.files.find((file) => file.role === "test")?.path,
      "packages/ui/src/__tests__/inline-alert.test.tsx",
    );
  });
});
