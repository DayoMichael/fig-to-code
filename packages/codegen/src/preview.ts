import type { FilePatch } from "@fig2code/spec";
import type { JobBuildPreview, PrunedSpec, StoryFormat } from "@fig2code/spec";

const STORY_FILE_RE = /\.stories\.(tsx?|jsx?|mdx)$/i;
const COMPONENT_FILE_RE = /\.(tsx|jsx)$/i;

export interface BuildJobPreviewInput {
  patches: FilePatch[];
  prunedSpec: PrunedSpec;
  storyFormat?: StoryFormat;
  tokenCss?: string;
}

export function buildJobPreview(input: BuildJobPreviewInput): JobBuildPreview {
  const { patches, prunedSpec, storyFormat = "none", tokenCss } = input;
  const storyPatch = patches.find(
    (patch) => patch.action !== "delete" && patch.content && STORY_FILE_RE.test(patch.path),
  );
  const componentPatch =
    patches.find(
      (patch) =>
        patch.action !== "delete" &&
        patch.content &&
        COMPONENT_FILE_RE.test(patch.path) &&
        !STORY_FILE_RE.test(patch.path) &&
        !patch.path.endsWith(".test.tsx") &&
        !patch.path.endsWith(".test.ts"),
    ) ?? patches.find((patch) => patch.action !== "delete" && patch.content && COMPONENT_FILE_RE.test(patch.path));

  const storyExport = storyPatch?.content ? extractStoryExportName(storyPatch.content) : undefined;

  return {
    componentName: prunedSpec.name,
    storyFormat,
    storyPath: storyPatch?.path,
    storyContent: storyPatch?.content,
    componentPath: componentPatch?.path,
    componentContent: componentPatch?.content,
    variantLabel: formatVariantLabel(prunedSpec, storyExport),
    variants: prunedSpec.variants,
    files: patches.map((patch) => ({
      path: patch.path,
      action: patch.action,
      content: patch.content,
    })),
    tokenCss,
  };
}

export function storyFormatLabel(format: StoryFormat): string {
  switch (format) {
    case "csf3":
      return "Storybook CSF3";
    case "csf2":
      return "Storybook CSF2";
    default:
      return "Component only";
  }
}

export function previewSnippet(preview: JobBuildPreview, maxLines = 10): string {
  const source = preview.storyContent ?? preview.componentContent ?? "";
  if (!source.trim()) {
    return "No generated files to preview.";
  }
  return truncateLines(source, maxLines);
}

export function previewFullText(preview: JobBuildPreview): string {
  const files = preview.files ?? buildFallbackPreviewFiles(preview);
  const sections = files
    .filter((file) => file.action !== "delete" && file.content)
    .map((file) => `// ${file.path}\n${file.content}`);

  return sections.join("\n\n") || "No generated files to preview.";
}

function buildFallbackPreviewFiles(preview: JobBuildPreview): NonNullable<JobBuildPreview["files"]> {
  const files: NonNullable<JobBuildPreview["files"]> = [];

  if (preview.componentPath && preview.componentContent) {
    files.push({
      path: preview.componentPath,
      action: "create",
      content: preview.componentContent,
    });
  }

  if (preview.storyPath && preview.storyContent) {
    files.push({
      path: preview.storyPath,
      action: "create",
      content: preview.storyContent,
    });
  }

  return files;
}

function extractStoryExportName(content: string): string | undefined {
  const match = content.match(/export const (\w+):\s*Story(?:Obj<[^>]+>)?\b/m);
  return match?.[1];
}

function formatVariantLabel(prunedSpec: PrunedSpec, storyExport?: string): string {
  if (storyExport) {
    return storyExport;
  }

  const variants = prunedSpec.variants;
  if (!variants || Object.keys(variants).length === 0) {
    return "Default";
  }

  return Object.entries(variants)
    .map(([key, values]) => `${key}=${values[0] ?? "?"}`)
    .join(", ");
}

function truncateLines(source: string, maxLines: number): string {
  const lines = source.split("\n");
  if (lines.length <= maxLines) {
    return source;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}
