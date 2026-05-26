import { buildCombinedTokenResolver, buildProjectTokensSummary, buildRegistryHints } from "@fig2code/repo";
import type { ClaimedJobPayload } from "@fig2code/spec";
import { createGitHostProvider } from "@fig2code/git-host";
import type { CodegenContext } from "@fig2code/codegen";
import type { LLMProvider } from "@fig2code/llm";

export interface HydrateCodegenContextOptions {
  payload: ClaimedJobPayload;
  llmProvider?: LLMProvider;
  apiKey?: string;
}

export async function hydrateCodegenContext(
  options: HydrateCodegenContextOptions,
): Promise<CodegenContext> {
  const { payload } = options;
  const git = createGitHostProvider(payload.syncConfig.vcs.provider);
  const auth = {
    token: payload.gitToken,
    atlassianEmail: payload.atlassianEmail,
  };

  const examplePath =
    payload.syncConfig.web?.exampleComponent ?? `${payload.syncConfig.web?.componentPath ?? "src/components"}/Button/Button.tsx`;

  let exampleStyles =
    "// Example component unavailable — codegen will rely on conventions only.";

  try {
    exampleStyles =
      (await git.readFile(payload.vcs, auth, examplePath, payload.vcs.baseBranch)) ??
      exampleStyles;
  } catch {
    // Remote read can fail in tests or when tokens expire; codegen can still proceed.
  }

  const componentPath = payload.syncConfig.web?.componentPath ?? "src/components";
  const registryHints = buildRegistryHints({ components: {} });
  registryHints[payload.prunedSpec.name] = `${componentPath}/${payload.prunedSpec.name}`;

  const styleSystem = payload.syncConfig.web?.styleSystem;
  const tokenResolver = buildCombinedTokenResolver({
    typographyCatalog: payload.syncConfig.typography?.catalog,
    tokenCatalog: payload.syncConfig.tokens?.catalog,
    styleSystem,
  });

  const projectTokens = payload.syncConfig.tokens
    ? buildProjectTokensSummary(payload.syncConfig.tokens)
    : {
        sourcePath: payload.syncConfig.web?.tokenPaths?.join(", ") ?? "",
        format: "js-object" as const,
        styleSystem,
        categories: {
          color: [],
          spacing: [],
          radius: [],
          typography: [],
          fontFamily: [],
        },
      };

  const apiKey =
    options.apiKey ??
    payload.llmToken ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.OPENAI_API_KEY ??
    "";

  if (!apiKey && !options.llmProvider) {
    throw new Error(
      "LLM API key is required — save it in the plugin or set ANTHROPIC_API_KEY / OPENAI_API_KEY on the worker",
    );
  }

  return {
    syncConfig: payload.syncConfig,
    prunedSpec: payload.prunedSpec,
    projectTokens,
    tokenResolver,
    registryHints,
    exampleStyles,
    apiKey,
    llmProvider: options.llmProvider,
  };
}
