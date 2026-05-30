import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { FilePatch, PrunedSpec, SyncConfig } from "@fig2code/spec";

const STORY_FILE_RE = /\.stories\.(tsx?|jsx?|mdx)$/i;
const TEST_FILE_RE = /\.(test|spec)\.(tsx?|ts)$/i;
const COMPONENT_FILE_RE = /\.(tsx|jsx)$/i;
const APPEND_EXPORT_MARKER = "/* fig2code:append-export */";

export interface CodegenFilePlan {
  componentName: string;
  componentPath: string;
  componentDir: string;
  componentBaseName: string;
  storyPath?: string;
  testPath?: string;
  barrelPath?: string;
  packageIndexPath?: string;
  packageIndexExportPath?: string;
  storyImportFrom: string;
  testImportFrom: string;
  layout: "folder" | "flat-monorepo" | "flat";
}

export function planCodegenFiles(
  syncConfig: SyncConfig,
  componentName: string,
  componentPatchPath?: string,
): CodegenFilePlan {
  const componentPath =
    componentPatchPath ??
    defaultComponentPath(syncConfig, componentName);
  const componentDir = dirname(componentPath);
  const componentBaseName = basename(componentPath).replace(/\.(tsx|jsx)$/i, "");
  const layout = detectLayout(componentPath, syncConfig);

  const storyPath = resolveStoryPath(layout, componentName, componentPath);
  const testPath = resolveTestPath(layout, componentName, componentPath);
  const barrelPath =
    layout === "folder" ? join(componentDir, "index.ts") : undefined;
  const packageIndexPath =
    layout === "flat-monorepo" ? findPackageIndexPath(componentPath) : undefined;
  const packageIndexExportPath = packageIndexPath
    ? `./${relativeFromDir(
        dirname(packageIndexPath),
        componentPath.replace(/\.(tsx|jsx)$/i, ""),
      )}`
    : undefined;

  const storyImportFrom = resolveStoryImportFrom(
    syncConfig,
    componentPath,
    componentName,
    layout,
  );
  const testImportFrom = resolveTestImportFrom(componentPath, layout);

  return {
    componentName,
    componentPath,
    componentDir,
    componentBaseName,
    storyPath,
    testPath,
    barrelPath,
    packageIndexPath,
    packageIndexExportPath,
    storyImportFrom,
    testImportFrom,
    layout,
  };
}

/** Add missing story, test, barrel, and package-index export patches after LLM output. */
export function ensureCodegenScaffolds(
  patches: FilePatch[],
  syncConfig: SyncConfig,
  prunedSpec: PrunedSpec,
  existingFiles?: {
    files: Array<{ path: string; role: string }>;
  },
): FilePatch[] {
  const componentName = prunedSpec.name;
  const componentPatch = findComponentPatch(patches);
  if (!componentPatch?.path) {
    return patches;
  }

  const plan = planCodegenFiles(syncConfig, componentName, componentPatch.path);
  const next = [...patches];
  const paths = new Set(next.map((patch) => patch.path));

  const existingStory = existingFiles?.files.some((file) => file.role === "story");
  const existingTest = existingFiles?.files.some((file) => file.role === "test");
  const existingBarrel = existingFiles?.files.some((file) => file.role === "barrel");

  const storyFormat = syncConfig.conventions.storyFormat;
  if (
    storyFormat !== "none" &&
    plan.storyPath &&
    !existingStory &&
    !paths.has(plan.storyPath) &&
    !hasStoryPatch(next)
  ) {
    next.push({
      path: plan.storyPath,
      action: "create",
      content: buildStoryScaffold(plan, prunedSpec, storyFormat),
    });
    paths.add(plan.storyPath);
  }

  const testFramework = syncConfig.conventions.testFramework;
  if (
    testFramework !== "none" &&
    plan.testPath &&
    !existingTest &&
    !paths.has(plan.testPath) &&
    !hasTestPatch(next)
  ) {
    next.push({
      path: plan.testPath,
      action: "create",
      content: buildTestScaffold(plan, testFramework),
    });
    paths.add(plan.testPath);
  }

  if (
    plan.barrelPath &&
    !existingBarrel &&
    !paths.has(plan.barrelPath) &&
    !hasBarrelPatch(next)
  ) {
    next.push({
      path: plan.barrelPath,
      action: "create",
      content: buildBarrelScaffold(plan),
    });
    paths.add(plan.barrelPath);
  }

  if (
    plan.packageIndexPath &&
    plan.packageIndexExportPath &&
    !paths.has(plan.packageIndexPath) &&
    !hasPackageIndexPatch(next, plan.packageIndexPath)
  ) {
    next.push({
      path: plan.packageIndexPath,
      action: "update",
      content: buildPackageIndexAppendPatch(plan),
    });
    paths.add(plan.packageIndexPath);
  }

  return next;
}

export function isAppendExportPatch(content: string | undefined): boolean {
  return Boolean(content?.includes(APPEND_EXPORT_MARKER));
}

export function extractAppendExportLine(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("/*") && !line.startsWith("*"))
    .join("\n");
}

export async function appendExportPatchToFile(
  absPath: string,
  patchContent: string,
): Promise<void> {
  const exportLine = extractAppendExportLine(patchContent);
  if (!exportLine) {
    return;
  }

  await mkdir(dirname(absPath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(absPath, "utf8");
  } catch {
    existing = "";
  }

  if (existing.includes(exportLine)) {
    return;
  }

  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const next =
    existing.trim().length > 0 ? `${existing}${separator}${exportLine}\n` : `${exportLine}\n`;
  await writeFile(absPath, next, "utf8");
}

function findComponentPatch(patches: FilePatch[]): FilePatch | undefined {
  return patches.find(
    (patch) =>
      patch.action !== "delete" &&
      patch.content &&
      COMPONENT_FILE_RE.test(patch.path) &&
      !STORY_FILE_RE.test(patch.path) &&
      !TEST_FILE_RE.test(patch.path) &&
      !patch.path.endsWith("/index.ts") &&
      !patch.path.endsWith("/index.tsx"),
  );
}

function hasStoryPatch(patches: FilePatch[]): boolean {
  return patches.some(
    (patch) => patch.action !== "delete" && STORY_FILE_RE.test(patch.path),
  );
}

function hasTestPatch(patches: FilePatch[]): boolean {
  return patches.some(
    (patch) => patch.action !== "delete" && TEST_FILE_RE.test(patch.path),
  );
}

function hasBarrelPatch(patches: FilePatch[]): boolean {
  return patches.some(
    (patch) =>
      patch.action !== "delete" &&
      (patch.path.endsWith("/index.ts") || patch.path.endsWith("/index.tsx")) &&
      dirname(patch.path) !== findPackageRootDir(patch.path),
  );
}

function hasPackageIndexPatch(patches: FilePatch[], packageIndexPath: string): boolean {
  return patches.some((patch) => patch.path === packageIndexPath);
}

function defaultComponentPath(syncConfig: SyncConfig, componentName: string): string {
  const root = syncConfig.web?.componentPath ?? "src/components";
  const naming = syncConfig.conventions.fileNaming;

  if (naming === "PascalCase") {
    return join(root, componentName, `${componentName}.tsx`);
  }

  const kebab = pascalToKebab(componentName);
  return join(root, `${kebab}.tsx`);
}

function detectLayout(
  componentPath: string,
  syncConfig: SyncConfig,
): CodegenFilePlan["layout"] {
  const parts = componentPath.split("/");
  const fileName = parts[parts.length - 1] ?? "";
  const parent = parts[parts.length - 2] ?? "";
  const baseName = fileName.replace(/\.(tsx|jsx)$/i, "");

  if (
    syncConfig.conventions.fileNaming === "PascalCase" &&
    parent === baseName
  ) {
    return "folder";
  }

  if (componentPath.includes("packages/ui/src/components/")) {
    return "flat-monorepo";
  }

  return "flat";
}

function resolveStoryPath(
  layout: CodegenFilePlan["layout"],
  componentName: string,
  componentPath: string,
): string | undefined {
  if (layout === "flat-monorepo") {
    return `apps/storybook/src/stories/${componentName}.stories.tsx`;
  }

  const dir = dirname(componentPath);
  const baseName = basename(componentPath).replace(/\.(tsx|jsx)$/i, "");
  return join(dir, `${baseName}.stories.tsx`);
}

function resolveTestPath(
  layout: CodegenFilePlan["layout"],
  componentName: string,
  componentPath: string,
): string | undefined {
  const kebab = pascalToKebab(componentName);

  if (layout === "flat-monorepo") {
    return `packages/ui/src/__tests__/${kebab}.test.tsx`;
  }

  const dir = dirname(componentPath);
  const baseName = basename(componentPath).replace(/\.(tsx|jsx)$/i, "");
  return join(dir, `${baseName}.test.tsx`);
}

function findPackageIndexPath(componentPath: string): string | undefined {
  const marker = "packages/ui/src/";
  const idx = componentPath.indexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  return join(componentPath.slice(0, idx + marker.length), "index.ts");
}

function findPackageRootDir(indexPath: string): string {
  return dirname(indexPath);
}

function resolveStoryImportFrom(
  _syncConfig: SyncConfig,
  componentPath: string,
  componentName: string,
  layout: CodegenFilePlan["layout"],
): string {
  const storyPath = resolveStoryPath(layout, componentName, componentPath);
  const fromDir = storyPath ? dirname(storyPath) : dirname(componentPath);
  const relative = relativeImport(
    fromDir,
    componentPath.replace(/\.(tsx|jsx)$/i, ""),
  );
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function resolveTestImportFrom(
  componentPath: string,
  layout: CodegenFilePlan["layout"],
): string {
  if (layout === "flat-monorepo") {
    return `../components/ui/${basename(componentPath).replace(/\.(tsx|jsx)$/i, "")}`;
  }

  const testPath = resolveTestPath(layout, "", componentPath)!;
  const relative = relativeImport(
    dirname(testPath),
    componentPath.replace(/\.(tsx|jsx)$/i, ""),
  );
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export function buildStoryScaffold(
  plan: CodegenFilePlan,
  prunedSpec: PrunedSpec,
  storyFormat: "csf3" | "csf2",
): string {
  const args = buildStoryArgsFromSpec(prunedSpec);
  const argsBlock =
    Object.keys(args).length > 0
      ? `\n  args: ${JSON.stringify(args, null, 2).replace(/\n/g, "\n  ")},`
      : "";

  if (storyFormat === "csf2") {
    return `import React from 'react';
import { ${plan.componentName} } from '${plan.storyImportFrom}';

export default {
  title: 'Components/${plan.componentName}',
  component: ${plan.componentName},${argsBlock}
};

export const Default = {};
`;
  }

  return `import React from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { ${plan.componentName} } from '${plan.storyImportFrom}';

const meta: Meta<typeof ${plan.componentName}> = {
  title: 'Components/${plan.componentName}',
  component: ${plan.componentName},${argsBlock}
};

export default meta;
type Story = StoryObj<typeof ${plan.componentName}>;

export const Default: Story = {};
`;
}

function buildStoryArgsFromSpec(prunedSpec: PrunedSpec): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const variants = prunedSpec.variants ?? {};

  for (const [key, values] of Object.entries(variants)) {
    if (values?.[0] != null) {
      args[key] = values[0];
    }
  }

  if (!("children" in args)) {
    args.children = planComponentLabel(prunedSpec.name);
  }

  return args;
}

function planComponentLabel(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function buildTestScaffold(
  plan: CodegenFilePlan,
  testFramework: "vitest" | "jest",
): string {
  void testFramework;
  return `import { render } from '@testing-library/react';

import { ${plan.componentName} } from '${plan.testImportFrom}';

describe('${plan.componentName}', () => {
  it('renders', () => {
    const { container } = render(<${plan.componentName} />);
    expect(container.firstChild).toBeTruthy();
  });
});
`;
}

export function buildBarrelScaffold(plan: CodegenFilePlan): string {
  return `export { ${plan.componentName} } from './${plan.componentName}';
export type { ${plan.componentName}Props } from './${plan.componentName}';
`;
}

export function buildPackageIndexAppendPatch(plan: CodegenFilePlan): string {
  const exportPath = plan.packageIndexExportPath ?? "./";
  return `${APPEND_EXPORT_MARKER}
export { ${plan.componentName}, type ${plan.componentName}Props } from '${exportPath}';
`;
}

function pascalToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

function relativeImport(fromDir: string, toPath: string): string {
  return relativeFromDir(fromDir, toPath);
}

function relativeFromDir(fromDir: string, toPath: string): string {
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = toPath.split("/").filter(Boolean);

  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) {
    shared++;
  }

  const ups = fromParts.length - shared;
  const suffix = toParts.slice(shared);
  const prefix = ups === 0 ? "./" : `${Array.from({ length: ups }, () => "..").join("/")}/`;
  return `${prefix}${suffix.join("/")}`;
}
