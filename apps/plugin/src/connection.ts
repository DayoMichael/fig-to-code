import type {
  DetectedProjectConfig,
  FileNaming,
  StoryFormat,
  StyleSystem,
  SyncConfig,
  TestFramework,
  VcsConfig,
} from "@fig2code/spec";

export interface PluginConnection {
  vcs: VcsConfig;
  syncConfig: SyncConfig;
  detected: DetectedProjectConfig;
  repoUrl: string;
  sessionId: string;
  connectedAt: string;
  apiBase: string;
  setupCorrectedAt?: string;
}

export interface SetupOverrides {
  styleSystem: StyleSystem;
  componentPath: string;
  tokenPaths: string;
  iconPath: string;
  fontPaths: string;
  testFramework: TestFramework;
  storyFormat: StoryFormat;
  fileNaming: FileNaming;
  baseBranch: string;
  defaultPrTarget: string;
  notes: string;
}

export function parseCommaSeparatedPaths(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Legacy sync configs stored a single tokenPath on web. */
function webTokenPaths(web?: { tokenPaths?: string[]; tokenPath?: string }): string[] {
  if (web?.tokenPaths?.length) {
    return web.tokenPaths;
  }
  if (web?.tokenPath?.trim()) {
    return [web.tokenPath.trim()];
  }
  return [];
}

export function readSetupOverrides(connection: PluginConnection): SetupOverrides {
  const web = connection.syncConfig.web;
  const savedTokenPaths = webTokenPaths(web);
  return {
    styleSystem: web?.styleSystem ?? connection.detected.styleSystem,
    componentPath:
      web?.componentPath ?? connection.detected.componentPaths[0] ?? "src/components",
    tokenPaths:
      savedTokenPaths.length > 0
        ? savedTokenPaths.join(", ")
        : connection.detected.tokenPaths.join(", "),
    iconPath: web?.iconPath ?? connection.detected.iconPaths[0] ?? "",
    fontPaths: connection.detected.fontPaths.join(", "),
    testFramework: connection.syncConfig.conventions.testFramework,
    storyFormat: connection.syncConfig.conventions.storyFormat,
    fileNaming: connection.syncConfig.conventions.fileNaming,
    baseBranch: connection.vcs.baseBranch,
    defaultPrTarget: connection.vcs.defaultPrTarget,
    notes: connection.syncConfig.llm?.notes ?? "",
  };
}

export function applySetupOverrides(
  connection: PluginConnection,
  overrides: SetupOverrides,
): PluginConnection {
  const fontPaths = parseCommaSeparatedPaths(overrides.fontPaths);
  const tokenPaths = parseCommaSeparatedPaths(overrides.tokenPaths);
  const primaryTokenPath = tokenPaths[0];

  const detected: DetectedProjectConfig = {
    ...connection.detected,
    styleSystem: overrides.styleSystem,
    componentPaths: [overrides.componentPath],
    tokenPaths,
    iconPaths: overrides.iconPath ? [overrides.iconPath] : [],
    fontPaths,
    testFramework: overrides.testFramework,
    storyFormat: overrides.storyFormat,
    fileNaming: overrides.fileNaming,
    existingTokens:
      connection.detected.existingTokens && primaryTokenPath
        ? { ...connection.detected.existingTokens, path: primaryTokenPath }
        : connection.detected.existingTokens,
  };

  const vcs: VcsConfig = {
    ...connection.vcs,
    baseBranch: overrides.baseBranch,
    defaultPrTarget: overrides.defaultPrTarget,
  };

  const syncConfig: SyncConfig = {
    ...connection.syncConfig,
    vcs,
    conventions: {
      ...connection.syncConfig.conventions,
      testFramework: overrides.testFramework,
      storyFormat: overrides.storyFormat,
      fileNaming: overrides.fileNaming,
    },
    web: connection.syncConfig.web
      ? {
          ...connection.syncConfig.web,
          styleSystem: overrides.styleSystem,
          componentPath: overrides.componentPath,
          tokenPaths,
          iconPath: overrides.iconPath,
        }
      : undefined,
    llm: {
      modelId: connection.syncConfig.llm?.modelId ?? "anthropic/claude-sonnet-4-6",
      promptProfile: connection.syncConfig.llm?.promptProfile,
      compaction: connection.syncConfig.llm?.compaction,
      notes: overrides.notes.trim() || undefined,
    },
    typography: {
      fontPaths,
      catalog: connection.syncConfig.typography?.catalog ?? {
        fontPaths,
        families: {},
        scales: [],
      },
    },
    tokens: {
      tokenPaths:
        tokenPaths.length > 0
          ? tokenPaths
          : connection.syncConfig.tokens?.tokenPaths ?? webTokenPaths(connection.syncConfig.web),
      catalog: connection.syncConfig.tokens?.catalog ?? {
        sourcePath: primaryTokenPath ?? "",
        format: "js-object",
        styleSystem: overrides.styleSystem,
        entries: [],
      },
    },
  };

  return {
    ...connection,
    vcs,
    detected,
    syncConfig,
    setupCorrectedAt: new Date().toISOString(),
  };
}

export type LlmProviderId = "anthropic" | "openai";

export interface LlmSettings {
  provider: LlmProviderId;
  modelId: string;
}

export const STORAGE_KEYS = {
  connection: "fig2code:connection",
  token: "fig2code:gitToken",
  atlassianEmail: "fig2code:atlassianEmail",
  apiBase: "fig2code:apiBase",
  llmToken: "fig2code:llmToken",
  llmProvider: "fig2code:llmProvider",
  llmModelId: "fig2code:llmModelId",
} as const;

export function modelIdForProvider(provider: LlmProviderId, modelId?: string): string {
  if (modelId?.startsWith(`${provider}/`)) {
    return modelId;
  }
  return provider === "openai" ? "openai/gpt-4o" : "anthropic/claude-sonnet-4-6";
}

export function providerFromModelId(modelId: string): LlmProviderId {
  return modelId.startsWith("openai/") ? "openai" : "anthropic";
}

export function validateLlmApiKey(provider: LlmProviderId, token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return "Enter your LLM API key.";
  }

  if (provider === "anthropic") {
    if (!trimmed.startsWith("sk-ant-")) {
      return "Anthropic keys start with sk-ant-. Create one at console.anthropic.com → API keys.";
    }
    return null;
  }

  if (!trimmed.startsWith("sk-")) {
    return "OpenAI keys start with sk-. Create one at platform.openai.com → API keys.";
  }

  return null;
}

export function buildVcs(
  provider: "github" | "bitbucket",
  slugA: string,
  slugB: string,
  baseBranch: string,
  defaultPrTarget: string,
): VcsConfig {
  if (provider === "github") {
    return {
      provider: "github",
      owner: slugA.trim(),
      repo: slugB.trim(),
      baseBranch,
      defaultPrTarget,
    };
  }

  return {
    provider: "bitbucket",
    workspace: slugA.trim(),
    repo: slugB.trim(),
    baseBranch,
    defaultPrTarget,
  };
}

export function summarizeDetection(detected: DetectedProjectConfig): string {
  const examples = detected.existingComponents.map((c) => c.name);
  const exampleLine =
    examples.length === 0
      ? "(no components found yet)"
      : examples.length <= 8
        ? examples.join(", ")
        : `${examples.slice(0, 8).join(", ")} +${examples.length - 8} more`;

  const tokensLine = detected.existingTokens
    ? `${detected.existingTokens.path} (${detected.existingTokens.format})`
    : detected.tokenPaths.length > 0
      ? detected.tokenPaths.join(", ")
      : "(none detected)";

  const iconsLine =
    detected.iconPaths.length > 0 ? detected.iconPaths.join(", ") : "(none detected)";

  const fontsLine =
    detected.fontPaths.length > 0 ? detected.fontPaths.join(", ") : "(none detected)";

  return [
    `Style: ${detected.styleSystem}`,
    `Platforms: ${detected.platforms.join(", ")}`,
    `Components: ${detected.componentPaths.join(", ") || "src/components"}`,
    `Tests: ${detected.testFramework}`,
    `Storybook: ${detected.storyFormat}`,
    `File & folder casing: ${detected.fileNaming}`,
    `Tokens: ${tokensLine}`,
    `Icons: ${iconsLine}`,
    `Fonts: ${fontsLine}`,
    `Examples: ${exampleLine}`,
  ].join("\n");
}
