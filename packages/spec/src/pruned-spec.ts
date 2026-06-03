import type { PreviewThemeContext } from "./themes.js";

export type PrunedSlotType = "text" | "icon" | "instance" | "image";

export interface PrunedSlot {
  type: PrunedSlotType;
  required?: boolean;
  optional?: boolean;
  componentName?: string;
  componentKey?: string;
}

export type PrunedPropType = "boolean" | "text";

export interface PrunedProp {
  type: PrunedPropType;
  default?: unknown;
}

/** Simplified node tree for compound components (depth-capped at extraction time). */
export interface LayoutNode {
  name: string;
  type: string;
  role?: string;
  hidden?: boolean;
  typography?: Record<string, string>;
  children?: LayoutNode[];
}

export interface PrunedSpec {
  name: string;
  kind: "component" | "screen";
  variants?: Record<string, string[]>;
  props?: Record<string, PrunedProp>;
  slots?: Record<string, PrunedSlot>;
  styles?: Record<string, Record<string, string>>;
  typography?: Record<string, Record<string, string>>;
  layout?: LayoutNode;
  metadata?: {
    figmaNodeId?: string;
    figmaComponentKey?: string;
    hash?: string;
    /** Brand/mode inferred from Figma variable modes on the selection. */
    previewTheme?: PreviewThemeContext;
  };
}
