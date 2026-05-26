import type { FigmaTextTypography } from "@fig2code/spec";

/** Minimal Figma node shape the plugin extracts client-side. */
export interface FigmaComponentPropertyDefinition {
  type: string;
  defaultValue?: unknown;
  variantOptions?: string[];
  preferredValues?: Array<{ key?: string; name?: string }>;
}

export interface FigmaNodeSnapshot {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  componentPropertyDefinitions?: Record<string, FigmaComponentPropertyDefinition>;
  componentPropertyReferences?: Record<string, string>;
  componentProperties?: Record<string, boolean | string>;
  variantValues?: Record<string, string>;
  children?: FigmaNodeSnapshot[];
  fills?: Array<{
    type: string;
    color?: { r: number; g: number; b: number; a?: number };
    /** Bound Figma variable name, e.g. color-bg-state-info-default */
    colorToken?: string;
  }>;
  layoutMode?: string;
  itemSpacing?: number;
  /** Bound variable name for itemSpacing, e.g. "4" from var(--4) */
  itemSpacingToken?: string;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  /** Bound variable names for padding sides */
  paddingTokens?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
  cornerRadius?: number;
  /** Bound variable name for cornerRadius */
  cornerRadiusToken?: string;
  characters?: string;
  typography?: FigmaTextTypography;
  mainComponent?: { name: string; key?: string };
}
