import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { appendExportPatchToFile, buildPackageIndexAppendPatch, ensureCodegenScaffolds, planCodegenFiles } from "./scaffold.js";
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
});
