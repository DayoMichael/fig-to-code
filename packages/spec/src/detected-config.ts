import type { ThemeCatalog } from "./themes.js";

export type StyleSystem =
  | "tailwind"
  | "css-modules"
  | "styled-components"
  | "vanilla-css"
  | "unknown";

export type ExportStyle = "named" | "default";
export type PropsPattern = "interface" | "type";
export type FileNaming = "PascalCase" | "kebab-case" | "camelCase";
export type TestFramework = "vitest" | "jest" | "none";
export type StoryFormat = "csf3" | "csf2" | "none";
export type Platform = "web" | "native";
/** How generated patches are formatted before preview/PR. */
export type FormatterPreference = "auto" | "prettier" | "none";
export type TokenFormat =
  | "tailwind-config"
  | "css-variables"
  | "js-object"
  | "json"
  | "w3c-dtcg";

export interface ExistingComponentSummary {
  name: string;
  path: string;
  hasTests: boolean;
  hasStories: boolean;
  hasCodeConnect: boolean;
}

export interface ExistingTokensSummary {
  format: TokenFormat;
  path: string;
  colors: string[];
  spacing: string[];
  radii: string[];
}

export interface DetectedProjectConfig {
  styleSystem: StyleSystem;
  tailwindConfigPath?: string;
  componentPaths: string[];
  tokenPaths: string[];
  iconPaths: string[];
  fontPaths: string[];
  exportStyle: ExportStyle;
  propsPattern: PropsPattern;
  fileNaming: FileNaming;
  testFramework: TestFramework;
  storyFormat: StoryFormat;
  formatter: FormatterPreference;
  themeCatalog?: ThemeCatalog | null;
  hasCodeConnect: boolean;
  platforms: Platform[];
  existingComponents: ExistingComponentSummary[];
  existingTokens: ExistingTokensSummary | null;
}
