import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobBuildPreview } from "@fig2code/spec";
import {
  buildPackageIndexAppendPatch,
  planCodegenFiles,
} from "@fig2code/codegen";
import type { SyncConfig } from "@fig2code/spec";
import {
  buildPatchesFromJobPreview,
  resolveAppendExportPatchesForCommit,
  resolvePullRequestPatches,
} from "./open-job-pr.js";

describe("buildPatchesFromJobPreview", () => {
  const preview: JobBuildPreview = {
    componentName: "Button",
    storyFormat: "csf3",
    componentPath: "src/components/Button/Button.tsx",
    componentContent: "export function Button() {}",
    storyPath: "src/components/Button/Button.stories.tsx",
    storyContent: "export default { component: Button };",
    variantLabel: "Default",
    files: [
      {
        path: "src/components/Button/Button.tsx",
        action: "update",
        content: "export function Button() {}",
      },
    ],
  };

  it("merges preview overrides by path", () => {
    const patches = buildPatchesFromJobPreview(preview, [
      {
        path: "src/components/Button/Button.tsx",
        content: "export function Button() { return null; }",
      },
    ]);

    const componentPatch = patches.find(
      (patch) => patch.path === "src/components/Button/Button.tsx",
    );
    assert.match(componentPatch?.content ?? "", /return null/);
  });

  it("includes story patch when present", () => {
    const patches = buildPatchesFromJobPreview(preview);
    assert.ok(
      patches.some((patch) => patch.path === "src/components/Button/Button.stories.tsx"),
    );
  });

  it("prefers client diff patches over full preview files", () => {
    const patches = resolvePullRequestPatches(preview, {
      patches: [
        {
          path: "src/components/Button/Button.tsx",
          action: "update",
          content: "export function Button() { return null; }",
        },
      ],
    });

    assert.equal(patches.length, 1);
    assert.match(patches[0]?.content ?? "", /return null/);
  });

  it("ignores client patches with missing content", () => {
    const patches = resolvePullRequestPatches(preview, {
      patches: [
        {
          path: "src/components/Button/Button.tsx",
          action: "update",
          content: undefined as unknown as string,
        },
      ],
    });

    assert.ok(patches.length >= 1);
    assert.ok(
      patches.some((patch) => patch.path === "src/components/Button/Button.tsx"),
    );
  });

  it("skips preview file entries with undefined content", () => {
    const patches = buildPatchesFromJobPreview({
      ...preview,
      files: [
        {
          path: "src/components/Button/Button.tsx",
          action: "update",
          content: undefined,
        },
      ],
    });

    assert.ok(
      patches.some(
        (patch) =>
          patch.path === "src/components/Button/Button.tsx" &&
          Boolean(patch.content?.trim()),
      ),
    );
  });
});

describe("resolveAppendExportPatchesForCommit", () => {
  const kudaSyncConfig: SyncConfig = {
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
      componentPath: "packages/ui/src/components/ui",
      tokenPaths: ["tailwind.config.ts"],
      iconPath: "src/icons",
      exampleComponent: "packages/ui/src/components/ui/button.tsx",
    },
    conventions: {
      exportStyle: "named",
      propsPattern: "interface",
      fileNaming: "kebab-case",
      testFramework: "vitest",
      storyFormat: "csf3",
    },
  };

  const appendPatch = buildPackageIndexAppendPatch(
    planCodegenFiles(
      kudaSyncConfig,
      "InlineAlert",
      "packages/ui/src/components/ui/inline-alert.tsx",
    ),
  );

  it("merges append patches against the base branch file", async () => {
    const git = {
      readFile: async () => "export { Button } from './components/ui/button';\n",
    };

    const resolved = await resolveAppendExportPatchesForCommit(
      [{ path: "packages/ui/src/index.ts", action: "update", content: appendPatch }],
      {
        vcs: kudaSyncConfig.vcs,
        auth: { token: "token" },
        baseBranch: "main",
        componentName: "InlineAlert",
        git: git as never,
      },
    );

    assert.equal(resolved.length, 1);
    assert.match(resolved[0]?.content ?? "", /export \{ Button \}/);
    assert.match(resolved[0]?.content ?? "", /export \{ InlineAlert, type InlineAlertProps \}/);
    assert.doesNotMatch(resolved[0]?.content ?? "", /fig2code:append-export/);
  });

  it("omits index patch when export already exists on base branch", async () => {
    const git = {
      readFile: async () =>
        "export { Button } from './components/ui/button';\nexport { InlineAlert, type InlineAlertProps } from './components/ui/inline-alert';\n",
    };

    const resolved = await resolveAppendExportPatchesForCommit(
      [{ path: "packages/ui/src/index.ts", action: "update", content: appendPatch }],
      {
        vcs: kudaSyncConfig.vcs,
        auth: { token: "token" },
        baseBranch: "main",
        componentName: "InlineAlert",
        git: git as never,
      },
    );

    assert.equal(resolved.length, 0);
  });
});
