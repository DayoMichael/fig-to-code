declare module "@fig2code/codegen/preview-utils" {
  export type PreviewPropControlType = "select" | "text" | "boolean" | "number";

  export interface PreviewPropControl {
    name: string;
    control: PreviewPropControlType;
    options?: string[];
  }

  export function extractExistingPreviewMetadata(
    componentContent: string,
    storyContent?: string,
  ): {
    variants: Record<string, string[]>;
    variantLabel: string;
    propControls: PreviewPropControl[];
  };

  export function resolveInitialPreviewArgs(
    variants: Record<string, string[]>,
    propControls: PreviewPropControl[],
    componentContent?: string,
    storyContent?: string,
  ): Record<string, unknown>;
}

declare module "@fig2code/codegen/change-summary" {
  export function inferBreakingFromText(text: string): boolean;
  export function inferFixFromText(text: string): string;
}
