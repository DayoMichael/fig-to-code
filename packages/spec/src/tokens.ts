import type { StyleSystem, TokenFormat } from "./detected-config.js";

export type TokenCategory = "color" | "spacing" | "radius" | "typography" | "fontFamily";

/** A single design token parsed from the team repo. */
export interface TokenEntry {
  category: TokenCategory;
  /** Token path segment, e.g. "text-primary" or "primary/500". */
  name: string;
  /** How the team applies this token (Tailwind class, CSS var, etc.). */
  usage: string;
  /** Normalized value for Figma matching — hex for colors, px number for spacing/radius. */
  value?: string;
}

export interface TokenCatalog {
  sourcePath: string;
  format: TokenFormat;
  styleSystem?: StyleSystem;
  entries: TokenEntry[];
}

export interface TokenConfig {
  tokenPaths: string[];
  catalog: TokenCatalog;
  /** Truncated source used to build the catalog (for LLM context). */
  sourceExcerpt?: string;
}

/** Structured token map passed to the LLM before codegen. */
export interface ProjectTokensSummary {
  sourcePath: string;
  format: TokenFormat;
  styleSystem?: StyleSystem;
  categories: Record<TokenCategory, Array<{ name: string; usage: string; value?: string }>>;
  sourceExcerpt?: string;
}
