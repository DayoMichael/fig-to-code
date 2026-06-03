import type {
  ExportStyle,
  FileNaming,
  Platform,
  PropsPattern,
  FormatterPreference,
  StoryFormat,
  StyleSystem,
  TestFramework,
} from "./detected-config.js";
import type { TypographyConfig } from "./typography.js";
import type { TokenConfig } from "./tokens.js";
import type { ThemeCatalog } from "./themes.js";

export type GitHostProvider = "github" | "bitbucket" | "gitlab";

export interface GitHubVcsConfig {
  provider: "github";
  owner: string;
  repo: string;
  baseBranch: string;
  defaultPrTarget: string;
}

export interface BitbucketVcsConfig {
  provider: "bitbucket";
  workspace: string;
  repo: string;
  baseBranch: string;
  defaultPrTarget: string;
}

export interface GitLabVcsConfig {
  provider: "gitlab";
  projectIdOrPath: string;
  baseBranch: string;
  defaultPrTarget: string;
}

export type VcsConfig = GitHubVcsConfig | BitbucketVcsConfig | GitLabVcsConfig;

export interface PlatformConfig {
  styleSystem?: StyleSystem;
  componentPath: string;
  tokenPaths: string[];
  iconPath: string;
  exampleComponent: string;
}

export interface ConventionsConfig {
  exportStyle: ExportStyle;
  propsPattern: PropsPattern;
  fileNaming: FileNaming;
  testFramework: TestFramework;
  storyFormat: StoryFormat;
  /** Defaults to "auto" when omitted (detect Prettier from repo). */
  formatter?: FormatterPreference;
}

export type CompactionMode = "off" | "auto";

export interface LlmCompactionConfig {
  mode?: CompactionMode;
  allowedSlots?: string[];
  compactorModelId?: string;
}

export interface LlmConfig {
  modelId: string;
  promptProfile?: string;
  repairStrategy?: "minimal" | "full_context";
  envelopeBudget?: {
    estimatedTokensSoft?: number;
  };
  compaction?: LlmCompactionConfig;
  notes?: string;
}

export interface SyncConfig {
  vcs: VcsConfig;
  platforms: Platform[];
  web?: PlatformConfig;
  native?: PlatformConfig;
  conventions: ConventionsConfig;
  typography?: TypographyConfig;
  tokens?: TokenConfig;
  themes?: ThemeCatalog;
  llm?: LlmConfig;
}
