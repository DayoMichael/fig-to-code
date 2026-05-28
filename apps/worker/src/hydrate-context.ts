import { buildCombinedTokenResolver, buildProjectTokensSummary, buildRegistryHints } from "@fig2code/repo";
import type { ClaimedJobPayload, ResolvedComponentBundle, ResolvedComponentFile } from "@fig2code/spec";
import { createGitHostProvider } from "@fig2code/git-host";
import type { CodegenContext } from "@fig2code/codegen";
import type { LLMProvider } from "@fig2code/llm";

export type BundleResolver = (
  bundleId: string,
  payload: ClaimedJobPayload,
) => Promise<ResolvedComponentBundle | null>;

export interface HydrateCodegenContextOptions {
  payload: ClaimedJobPayload;
  llmProvider?: LLMProvider;
  apiKey?: string;
  /** Override the apiBase used to fetch resolved bundles. */
  apiBase?: string;
  /** Inject a bundle resolver (used by tests + alternative storage). */
  resolveBundle?: BundleResolver;
  /** Override the global `fetch` used to load bundles via HTTP. */
  fetchImpl?: typeof fetch;
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

  let existingFiles: CodegenContext["existingFiles"];
  const isUpdate = payload.intent === "component-update";

  if (isUpdate && payload.bundleId) {
    const bundle = await loadBundle(payload, {
      apiBase: options.apiBase,
      resolveBundle: options.resolveBundle,
      fetchImpl: options.fetchImpl,
    });

    if (bundle) {
      existingFiles = {
        componentName: bundle.componentName,
        files: bundle.files.map((file) => ({ ...file })),
        relatedModules: bundle.relatedModules ?? [],
        truncated: bundle.truncated ?? false,
      };

      applyPreviewFileOverrides(existingFiles, payload.previewFileOverrides);

      for (const file of bundle.files) {
        if (file.role === "component" && bundle.componentName) {
          registryHints[bundle.componentName] = stripFileName(file.path);
        }
      }

      if (bundle.primaryComponentPath) {
        try {
          const updatedExample = await git.readFile(
            payload.vcs,
            auth,
            bundle.primaryComponentPath,
            payload.vcs.baseBranch,
          );
          if (updatedExample) {
            exampleStyles = updatedExample;
          }
        } catch {
          // ignored; we already have a fallback above.
        }
      }
    }
  }

  if (!existingFiles && payload.previewFileOverrides?.length) {
    const componentFile =
      payload.previewFileOverrides.find((file) => file.role === "component") ??
      payload.previewFileOverrides[0];
    existingFiles = {
      componentName: payload.prunedSpec.name,
      files: payload.previewFileOverrides.map((file) => ({
        path: file.path,
        role: file.role as ResolvedComponentFile["role"],
        content: file.content,
      })),
      relatedModules: [],
      truncated: false,
    };
    if (componentFile) {
      registryHints[payload.prunedSpec.name] = stripFileName(componentFile.path);
    }
  }

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
    intent: payload.intent,
    existingFiles,
  };
}

interface LoadBundleOptions {
  apiBase?: string;
  resolveBundle?: BundleResolver;
  fetchImpl?: typeof fetch;
}

async function loadBundle(
  payload: ClaimedJobPayload,
  options: LoadBundleOptions,
): Promise<ResolvedComponentBundle | null> {
  if (!payload.bundleId) return null;

  if (options.resolveBundle) {
    return options.resolveBundle(payload.bundleId, payload);
  }

  const apiBase = options.apiBase ?? process.env.FIG2CODE_API_BASE ?? "http://localhost:3000";
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${apiBase.replace(/\/+$/, "")}/repos/bundles/${payload.bundleId}`);
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as { bundle?: ResolvedComponentBundle };
  return body.bundle ?? null;
}

function stripFileName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : path;
}

function applyPreviewFileOverrides(
  existingFiles: NonNullable<CodegenContext["existingFiles"]>,
  overrides: NonNullable<ClaimedJobPayload["previewFileOverrides"]>,
): void {
  for (const override of overrides) {
    const match = existingFiles.files.find((file) => file.path === override.path);
    if (match) {
      match.content = override.content;
      continue;
    }
    existingFiles.files.push({
      path: override.path,
      role: override.role as ResolvedComponentFile["role"],
      content: override.content,
    });
  }
}

// Re-exported so the worker can return rich types externally if it wants to.
export type { ResolvedComponentFile };
