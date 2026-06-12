import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { appendExportPatchToFile, buildCodeConnectScaffold, buildPackageIndexAppendPatch, ensureCodegenScaffolds, finalizeBarrelExportPatches, planCodegenFiles, sanitizeUpdateBarrelPatches } from "./scaffold.js";
import type { SyncConfig } from "@fig2code/spec";

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

const kudaSyncConfig: SyncConfig = {
  ...baseSyncConfig,
  web: {
    ...baseSyncConfig.web!,
    componentPath: "packages/ui/src/components/ui",
    exampleComponent: "packages/ui/src/components/ui/button.tsx",
  },
  conventions: {
    ...baseSyncConfig.conventions,
    fileNaming: "kebab-case",
  },
};

describe("codegen scaffolds", () => {
  it("plans folder component paths for PascalCase repos", () => {
    const plan = planCodegenFiles(baseSyncConfig, "Button");
    assert.equal(plan.componentPath, "src/components/Button/Button.tsx");
    assert.equal(plan.storyPath, "src/components/Button/Button.stories.tsx");
    assert.equal(plan.testPath, "src/components/Button/Button.test.tsx");
    assert.equal(plan.barrelPath, "src/components/Button/index.ts");
    assert.equal(plan.layout, "folder");
  });

  it("plans monorepo flat component paths for Kuda-style repos", () => {
    const plan = planCodegenFiles(
      kudaSyncConfig,
      "InlineAlert",
      "packages/ui/src/components/ui/inline-alert.tsx",
    );
    assert.equal(plan.storyPath, "apps/storybook/src/stories/InlineAlert.stories.tsx");
    assert.equal(plan.testPath, "packages/ui/src/__tests__/inline-alert.test.tsx");
    assert.equal(plan.packageIndexPath, "packages/ui/src/index.ts");
    assert.match(plan.packageIndexExportPath ?? "", /components\/ui\/inline-alert$/);
    assert.equal(
      plan.storyImportFrom,
      "../../../../packages/ui/src/components/ui/inline-alert",
    );
  });

  it("adds missing story, test, barrel, and package index patches", () => {
    const patches = ensureCodegenScaffolds(
      [
        {
          path: "src/components/Button/Button.tsx",
          action: "create",
          content: "export function Button() { return <button />; }\n",
        },
      ],
      baseSyncConfig,
      { name: "Button", kind: "component" },
    );

    assert.equal(patches.length, 4);
    assert.ok(patches.some((patch) => patch.path.endsWith("Button.stories.tsx")));
    assert.ok(patches.some((patch) => patch.path.endsWith("Button.test.tsx")));
    assert.ok(patches.some((patch) => patch.path.endsWith("Button/index.ts")));
    assert.equal(
      patches.filter((patch) => patch.path.endsWith("Button/index.ts")).length,
      1,
    );
  });

  it("skips story scaffold when an existing story is already in the bundle", () => {
    const patches = ensureCodegenScaffolds(
      [
        {
          path: "src/components/Button/Button.tsx",
          action: "update",
          content: "export function Button() { return <button />; }\n",
        },
      ],
      baseSyncConfig,
      { name: "Button", kind: "component" },
      {
        files: [{ path: "src/components/Button/Button.stories.tsx", role: "story" }],
      },
    );

    assert.ok(!patches.some((patch) => patch.path.endsWith("Button.stories.tsx")));
  });

  it("appends package index exports without overwriting the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "fig2code-scaffold-"));
    const indexPath = join(root, "packages/ui/src/index.ts");
    const plan = planCodegenFiles(
      kudaSyncConfig,
      "InlineAlert",
      "packages/ui/src/components/ui/inline-alert.tsx",
    );
    const appendPatch = buildPackageIndexAppendPatch(plan);

    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, "export { Button } from './components/ui/button';\n", "utf8");
    await appendExportPatchToFile(indexPath, appendPatch);

    const indexContent = await readFile(indexPath, "utf8");
    assert.match(indexContent, /export \{ Button \}/);
    assert.match(indexContent, /export \{ InlineAlert, type InlineAlertProps \}/);
    await rm(root, { recursive: true, force: true });
  });

  it("drops full package index rewrites on component-update", () => {
    const patches = sanitizeUpdateBarrelPatches(
      [
        {
          path: "packages/ui/src/components/ui/inline-alert.tsx",
          action: "update",
          content: "export function InlineAlert() { return null; }",
        },
        {
          path: "packages/ui/src/index.ts",
          action: "update",
          content: "export { InlineAlert } from './components/ui/inline-alert';",
        },
      ],
      {
        intent: "component-update",
        componentName: "InlineAlert",
        syncConfig: kudaSyncConfig,
        existingFiles: {
          componentName: "InlineAlert",
          files: [
            {
              path: "packages/ui/src/components/ui/inline-alert.tsx",
              role: "component",
              content: "export function InlineAlert() { return null; }",
            },
            {
              path: "packages/ui/src/index.ts",
              role: "related",
              content:
                "export { Button } from './components/ui/button';\nexport { Avatar } from './components/ui/avatar';\n",
            },
          ],
        },
      },
    );

    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.path, "packages/ui/src/components/ui/inline-alert.tsx");
  });

  it("drops append index patch when export already exists", () => {
    const appendPatch = buildPackageIndexAppendPatch(
      planCodegenFiles(
        kudaSyncConfig,
        "InlineAlert",
        "packages/ui/src/components/ui/inline-alert.tsx",
      ),
    );
    const patches = sanitizeUpdateBarrelPatches(
      [{ path: "packages/ui/src/index.ts", action: "update", content: appendPatch }],
      {
        intent: "component-update",
        componentName: "InlineAlert",
        syncConfig: kudaSyncConfig,
        existingFiles: {
          componentName: "InlineAlert",
          files: [
            {
              path: "packages/ui/src/index.ts",
              role: "related",
              content:
                "export { Button } from './components/ui/button';\nexport { InlineAlert, type InlineAlertProps } from './components/ui/inline-alert';\n",
            },
          ],
        },
      },
    );

    assert.equal(patches.length, 0);
  });

  it("skips package index scaffold when export already exists in bundle", () => {
    const patches = ensureCodegenScaffolds(
      [
        {
          path: "packages/ui/src/components/ui/inline-alert.tsx",
          action: "update",
          content: "export function InlineAlert() { return null; }",
        },
      ],
      kudaSyncConfig,
      { name: "InlineAlert", kind: "component" },
      {
        files: [
          {
            path: "packages/ui/src/index.ts",
            role: "related",
            content:
              "export { Button } from './components/ui/button';\nexport { InlineAlert, type InlineAlertProps } from './components/ui/inline-alert';\n",
          },
        ],
      },
    );

    assert.ok(!patches.some((patch) => patch.path === "packages/ui/src/index.ts"));
  });

  it("expands append index patches into full file content", () => {
    const appendPatch = buildPackageIndexAppendPatch(
      planCodegenFiles(
        kudaSyncConfig,
        "InlineAlert",
        "packages/ui/src/components/ui/inline-alert.tsx",
      ),
    );
    const patches = finalizeBarrelExportPatches(
      [{ path: "packages/ui/src/index.ts", action: "update", content: appendPatch }],
      {
        componentName: "InlineAlert",
        existingFiles: {
          componentName: "InlineAlert",
          files: [
            {
              path: "packages/ui/src/index.ts",
              role: "related",
              content: "export { Button } from './components/ui/button';\n",
            },
          ],
        },
      },
    );

    assert.equal(patches.length, 1);
    assert.doesNotMatch(patches[0]?.content ?? "", /fig2code:append-export/);
    assert.match(patches[0]?.content ?? "", /export \{ Button \}/);
    assert.match(patches[0]?.content ?? "", /export \{ InlineAlert, type InlineAlertProps \}/);
  });

  it("drops append index patches when export already exists", () => {
    const appendPatch = buildPackageIndexAppendPatch(
      planCodegenFiles(
        kudaSyncConfig,
        "InlineAlert",
        "packages/ui/src/components/ui/inline-alert.tsx",
      ),
    );
    const patches = finalizeBarrelExportPatches(
      [{ path: "packages/ui/src/index.ts", action: "update", content: appendPatch }],
      {
        componentName: "InlineAlert",
        existingFiles: {
          componentName: "InlineAlert",
          files: [
            {
              path: "packages/ui/src/index.ts",
              role: "related",
              content:
                "export { InlineAlert, type InlineAlertProps } from './components/ui/inline-alert';\n",
            },
          ],
        },
      },
    );

    assert.equal(patches.length, 0);
  });

  it("keeps append-export patches intact when no existing barrel is provided (create)", () => {
    const appendPatch = buildPackageIndexAppendPatch(
      planCodegenFiles(
        kudaSyncConfig,
        "InlineAlert",
        "packages/ui/src/components/ui/inline-alert.tsx",
      ),
    );
    // No existingFiles → create job. The patch must stay an append-export so the
    // write/commit layer merges it into the real barrel instead of overwriting it.
    const patches = finalizeBarrelExportPatches(
      [{ path: "packages/ui/src/index.ts", action: "update", content: appendPatch }],
      { componentName: "InlineAlert" },
    );

    assert.equal(patches.length, 1);
    assert.match(patches[0]?.content ?? "", /fig2code:append-export/);
    assert.match(patches[0]?.content ?? "", /export \{ InlineAlert, type InlineAlertProps \}/);
  });

  it("drops full package index rewrites on create jobs", () => {
    const patches = sanitizeUpdateBarrelPatches(
      [
        {
          path: "packages/ui/src/components/ui/inline-alert.tsx",
          action: "create",
          content: "export function InlineAlert() { return null; }",
        },
        {
          path: "packages/ui/src/index.ts",
          action: "update",
          content: "export { InlineAlert } from './components/ui/inline-alert';",
        },
      ],
      {
        intent: "component",
        componentName: "InlineAlert",
        syncConfig: kudaSyncConfig,
        packageIndexPath: "packages/ui/src/index.ts",
      },
    );

    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.path, "packages/ui/src/components/ui/inline-alert.tsx");
  });
});

describe("buildCodeConnectScaffold", () => {
  const plan = planCodegenFiles(baseSyncConfig, "Button", "src/components/Button/Button.tsx");

  it("links the Figma node and maps variants and props", () => {
    const scaffold = buildCodeConnectScaffold(plan, {
      name: "Button",
      kind: "component",
      variants: { Variant: ["Primary", "Secondary"], Size: ["Small", "Large"] },
      props: { Disabled: { type: "boolean" }, Label: { type: "text" } },
      metadata: { figmaFileKey: "abc123", figmaNodeId: "12:34" },
    });

    assert.match(scaffold, /import figma from "@figma\/code-connect";/);
    assert.match(scaffold, /https:\/\/www\.figma\.com\/design\/abc123\/\?node-id=12-34/);
    assert.match(scaffold, /variant: figma\.enum\("Variant",/);
    assert.match(scaffold, /"Primary": "primary",/);
    assert.match(scaffold, /size: figma\.enum\("Size",/);
    assert.match(scaffold, /disabled: figma\.boolean\("Disabled"\),/);
    assert.match(scaffold, /label: figma\.string\("Label"\),/);
    assert.match(scaffold, /example: \(props\) => <Button \{\.\.\.props\} \/>/);
  });

  it("falls back to a TODO url without file metadata", () => {
    const scaffold = buildCodeConnectScaffold(plan, { name: "Button", kind: "component" });
    assert.match(scaffold, /FILE_KEY\/\?node-id=NODE_ID \/\/ TODO/);
  });

  it("is added by ensureCodegenScaffolds only when the convention is on", () => {
    const componentPatch = {
      path: "src/components/Button/Button.tsx",
      action: "create" as const,
      content: "export const Button = () => null;",
    };
    const spec = {
      name: "Button",
      kind: "component" as const,
      metadata: { figmaFileKey: "abc123", figmaNodeId: "12:34" },
    };

    const withCodeConnect = ensureCodegenScaffolds(
      [componentPatch],
      {
        ...baseSyncConfig,
        conventions: { ...baseSyncConfig.conventions, codeConnect: true },
      },
      spec,
    );
    assert.ok(
      withCodeConnect.some((patch) => patch.path === "src/components/Button/Button.figma.tsx"),
      "code connect patch generated when convention is on",
    );

    const without = ensureCodegenScaffolds([componentPatch], baseSyncConfig, spec);
    assert.ok(
      !without.some((patch) => patch.path.endsWith(".figma.tsx")),
      "no code connect patch when convention is off",
    );
  });
});
