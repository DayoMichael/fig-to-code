import { normalizeColorTokenName, parseFontWeightFromStyle, parseVariantName, pruneNodeTree } from "@fig2code/figma-ast";
import type { FigmaNodeSnapshot } from "@fig2code/figma-ast";
import type {
  FigmaTextTypography,
  JobRecord,
  PreviewThemeContext,
  PrunedSpec,
  ResolveComponentResponse,
  ThemeCatalog,
  ThemeSelection,
  TokenCatalog,
  TokenConfig,
  TypographyCatalog,
  TypographyConfig,
  VcsConfig,
} from "@fig2code/spec";
import { isTerminalJobStatus, type EnqueueJobRequest } from "@fig2code/spec";
import {
  applySetupOverrides,
  buildVcs,
  modelIdForProvider,
  parseCommaSeparatedPaths,
  providerFromModelId,
  readSetupOverrides,
  STORAGE_KEYS,
  summarizeDetection,
  validateLlmApiKey,
  type LlmProviderId,
  type PluginConnection,
  type SetupOverrides,
} from "./connection.js";

const DEFAULT_API_BASE = "http://localhost:3000";
const RESOLVE_DEBOUNCE_MS = 300;

interface ResolveState {
  selectionId: string;
  componentName: string;
  resolvedComponentName?: string;
  bundleId?: string;
  matched: boolean;
  reason?: string;
  bundle?: NonNullable<ResolveComponentResponse["bundle"]>;
}

let lastResolve: ResolveState | null = null;
let resolveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let resolveRequestSeq = 0;
let previewRequestSeq = 0;
let lastScheduledSelectionId: string | null = null;

figma.ui.onmessage = async (msg: PluginMessage) => {
  try {
    if (msg.type === "ui-ready") {
      await bootstrap();
      return;
    }

    switch (msg.type) {
      case "save-api-base":
        await figma.clientStorage.setAsync(STORAGE_KEYS.apiBase, msg.apiBase);
        figma.ui.postMessage({ type: "status", message: "API URL saved." });
        break;

      case "load-branches":
        await loadBranches(msg);
        break;

      case "connect":
        await connectRepo(msg);
        break;

      case "rescan":
        await rescanRepo(msg);
        break;

      case "disconnect":
        await disconnect();
        break;

      case "save-setup":
        await saveSetup(msg.overrides);
        break;

      case "save-llm":
        await saveLlmSettings(msg);
        break;

      case "push-selection":
        await pushSelection(msg);
        break;

      case "resize-ui":
        figma.ui.resize(msg.width, msg.height);
        break;

      case "check-job":
        await pollJob(msg.apiBase, msg.jobId);
        break;

      case "create-pull-request":
        await createPullRequest(msg);
        break;

      case "open-external-url":
        if (typeof msg.url === "string" && /^https?:\/\//.test(msg.url)) {
          figma.openExternal(msg.url);
        }
        break;

      case "ensure-existing-preview":
        await ensureExistingPreview(msg);
        break;
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

try {
  if (figma.editorType === "dev") {
    figma.showUI(__html__, { themeColors: true });
  } else {
    figma.showUI(__html__, { width: 380, height: 720, themeColors: true });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  figma.notify(`Fig2Code crashed: ${message}`, { error: true });
}

async function bootstrap(): Promise<void> {
  const [connection, token, apiBase, atlassianEmail, llmToken, llmProvider, llmModelId] =
    await Promise.all([
      figma.clientStorage.getAsync(STORAGE_KEYS.connection) as Promise<
        PluginConnection | undefined
      >,
      figma.clientStorage.getAsync(STORAGE_KEYS.token) as Promise<string | undefined>,
      figma.clientStorage.getAsync(STORAGE_KEYS.apiBase) as Promise<string | undefined>,
      figma.clientStorage.getAsync(STORAGE_KEYS.atlassianEmail) as Promise<
        string | undefined
      >,
      figma.clientStorage.getAsync(STORAGE_KEYS.llmToken) as Promise<string | undefined>,
      figma.clientStorage.getAsync(STORAGE_KEYS.llmProvider) as Promise<
        LlmProviderId | undefined
      >,
      figma.clientStorage.getAsync(STORAGE_KEYS.llmModelId) as Promise<string | undefined>,
    ]);

  let summary: string | null = null;
  if (connection?.detected) {
    try {
      summary = summarizeDetection(connection.detected);
    } catch {
      summary = null;
    }
  }

  const provider =
    llmProvider ??
    (llmModelId ? providerFromModelId(llmModelId) : providerFromModelId(connection?.syncConfig.llm?.modelId ?? ""));

  figma.ui.postMessage({
    type: "init",
    apiBase: apiBase ?? DEFAULT_API_BASE,
    connected: Boolean(connection && token),
    connection: connection ?? null,
    hasToken: Boolean(token),
    atlassianEmail: atlassianEmail ?? "",
    summary,
    hasValidSelection: hasValidPushSelection(),
    llm: {
      provider,
      modelId: modelIdForProvider(provider, llmModelId ?? connection?.syncConfig.llm?.modelId),
      hasToken: Boolean(llmToken?.trim()),
    },
  });

  postSelectionState();
}

async function loadBranches(msg: LoadBranchesMessage): Promise<void> {
  const apiBase = msg.apiBase ?? DEFAULT_API_BASE;

  let vcs: VcsConfig;
  let token: string;
  let atlassianEmail: string | undefined;

  if (msg.token?.trim() && msg.slugA?.trim() && msg.slugB?.trim()) {
    vcs = buildVcsFromMessage(msg);
    token = msg.token.trim();
    atlassianEmail = msg.atlassianEmail?.trim() || undefined;
  } else {
    const [connection, storedToken, storedEmail] = await Promise.all([
      figma.clientStorage.getAsync(STORAGE_KEYS.connection) as Promise<
        PluginConnection | undefined
      >,
      figma.clientStorage.getAsync(STORAGE_KEYS.token) as Promise<string | undefined>,
      figma.clientStorage.getAsync(STORAGE_KEYS.atlassianEmail) as Promise<
        string | undefined
      >,
    ]);

    if (!connection?.vcs || !storedToken?.trim()) {
      throw new Error("Connect a repository before loading branches.");
    }

    vcs = connection.vcs;
    token = storedToken.trim();
    atlassianEmail = storedEmail?.trim() || undefined;
  }

  const res = await fetch(`${apiBase}/repos/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vcs,
      token,
      atlassianEmail,
    }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Failed to load branches (${res.status})`);
  }

  const body = (await res.json()) as { refs: Array<{ name: string; sha?: string }> };
  figma.ui.postMessage({ type: "branches-loaded", refs: body.refs });
}

async function connectRepo(msg: ConnectMessage): Promise<void> {
  const apiBase = msg.apiBase ?? DEFAULT_API_BASE;
  const vcs = buildVcsFromMessage(msg);

  const res = await fetch(`${apiBase}/repos/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vcs,
      token: msg.token,
      atlassianEmail: msg.atlassianEmail,
    }),
  });

  const body = (await res.json()) as ConnectApiResponse & { error?: string };

  if (!res.ok) {
    throw new Error(body.error ?? `Connect failed (${res.status})`);
  }

  const connection: PluginConnection = {
    vcs: body.syncConfig.vcs,
    syncConfig: body.syncConfig,
    detected: body.detected,
    repoUrl: body.repoUrl,
    sessionId: body.sessionId,
    connectedAt: new Date().toISOString(),
    apiBase,
  };

  await figma.clientStorage.setAsync(STORAGE_KEYS.connection, connection);
  await figma.clientStorage.setAsync(STORAGE_KEYS.token, msg.token);
  if (msg.atlassianEmail?.trim()) {
    await figma.clientStorage.setAsync(STORAGE_KEYS.atlassianEmail, msg.atlassianEmail.trim());
  } else {
    await figma.clientStorage.deleteAsync(STORAGE_KEYS.atlassianEmail);
  }
  await figma.clientStorage.setAsync(STORAGE_KEYS.apiBase, apiBase);

  figma.ui.postMessage({
    type: "connected",
    connection,
    summary: summarizeDetection(body.detected),
  });
}

async function rescanRepo(msg: RescanMessage): Promise<void> {
  const [connection, token, atlassianEmail] = await Promise.all([
    figma.clientStorage.getAsync(STORAGE_KEYS.connection) as Promise<
      PluginConnection | undefined
    >,
    figma.clientStorage.getAsync(STORAGE_KEYS.token) as Promise<string | undefined>,
    figma.clientStorage.getAsync(STORAGE_KEYS.atlassianEmail) as Promise<
      string | undefined
    >,
  ]);

  if (!connection || !token) {
    throw new Error("Connect a repository before rescanning.");
  }

  const apiBase = msg.apiBase ?? connection.apiBase ?? DEFAULT_API_BASE;
  const savedNotes = connection.syncConfig.llm?.notes;
  const vcs: VcsConfig = {
    ...connection.vcs,
    baseBranch: msg.baseBranch,
    defaultPrTarget: msg.defaultPrTarget,
  };

  const res = await fetch(`${apiBase}/repos/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vcs,
      token,
      atlassianEmail,
    }),
  });

  const body = (await res.json()) as ConnectApiResponse & { error?: string };

  if (!res.ok) {
    throw new Error(body.error ?? `Rescan failed (${res.status})`);
  }

  let newConnection: PluginConnection = {
    vcs: body.syncConfig.vcs,
    syncConfig: body.syncConfig,
    detected: body.detected,
    repoUrl: body.repoUrl,
    sessionId: body.sessionId,
    connectedAt: new Date().toISOString(),
    apiBase,
  };

  if (savedNotes?.trim()) {
    newConnection = {
      ...newConnection,
      syncConfig: {
        ...newConnection.syncConfig,
        llm: {
          modelId: newConnection.syncConfig.llm?.modelId ?? "anthropic/claude-sonnet-4-6",
          promptProfile: newConnection.syncConfig.llm?.promptProfile,
          compaction: newConnection.syncConfig.llm?.compaction,
          notes: savedNotes,
        },
      },
    };
  }

  await figma.clientStorage.setAsync(STORAGE_KEYS.connection, newConnection);
  await figma.clientStorage.setAsync(STORAGE_KEYS.apiBase, apiBase);

  figma.ui.postMessage({
    type: "connected",
    connection: newConnection,
    summary: summarizeDetection(body.detected),
    refreshed: true,
  });
}

async function disconnect(): Promise<void> {
  await figma.clientStorage.deleteAsync(STORAGE_KEYS.connection);
  await figma.clientStorage.deleteAsync(STORAGE_KEYS.token);
  await figma.clientStorage.deleteAsync(STORAGE_KEYS.atlassianEmail);
  await figma.clientStorage.deleteAsync(STORAGE_KEYS.llmToken);
  await figma.clientStorage.deleteAsync(STORAGE_KEYS.llmProvider);
  await figma.clientStorage.deleteAsync(STORAGE_KEYS.llmModelId);
  figma.ui.postMessage({ type: "disconnected" });
}

async function saveSetup(overrides: SetupOverrides): Promise<void> {
  const connection = (await figma.clientStorage.getAsync(
    STORAGE_KEYS.connection,
  )) as PluginConnection | undefined;

  if (!connection) {
    figma.ui.postMessage({
      type: "error",
      message: "Connect a repository before saving setup.",
    });
    return;
  }

  const updated = applySetupOverrides(connection, overrides);
  const typography = await refreshTypographyCatalog(updated, overrides);
  if (typography) {
    updated.syncConfig.typography = typography;
  }
  const tokens = await refreshTokenCatalog(updated, overrides, typography?.catalog);
  if (tokens) {
    updated.syncConfig.tokens = tokens;
  }
  await figma.clientStorage.setAsync(STORAGE_KEYS.connection, updated);

  figma.ui.postMessage({
    type: "setup-saved",
    connection: updated,
    summary: summarizeDetection(updated.detected),
  });
}

async function saveLlmSettings(msg: SaveLlmMessage): Promise<void> {
  const connection = (await figma.clientStorage.getAsync(
    STORAGE_KEYS.connection,
  )) as PluginConnection | undefined;

  if (!connection) {
    figma.ui.postMessage({
      type: "error",
      message: "Connect a repository before saving LLM settings.",
    });
    return;
  }

  const provider = msg.provider as LlmProviderId;
  const modelId = modelIdForProvider(provider, msg.modelId);
  const existingToken = (await figma.clientStorage.getAsync(
    STORAGE_KEYS.llmToken,
  )) as string | undefined;
  const token = msg.token.trim() || existingToken?.trim();

  if (!token) {
    figma.ui.postMessage({
      type: "error",
      message: "Enter your LLM API key.",
    });
    return;
  }

  const keyError = validateLlmApiKey(provider, token);
  if (keyError) {
    figma.ui.postMessage({
      type: "error",
      message: keyError,
    });
    return;
  }

  await figma.clientStorage.setAsync(STORAGE_KEYS.llmToken, token);
  await figma.clientStorage.setAsync(STORAGE_KEYS.llmProvider, provider);
  await figma.clientStorage.setAsync(STORAGE_KEYS.llmModelId, modelId);

  const updated: PluginConnection = {
    ...connection,
    syncConfig: {
      ...connection.syncConfig,
      llm: {
        ...connection.syncConfig.llm,
        modelId,
        promptProfile: connection.syncConfig.llm?.promptProfile ?? "component-v1",
      },
    },
  };
  await figma.clientStorage.setAsync(STORAGE_KEYS.connection, updated);

  figma.ui.postMessage({
    type: "llm-saved",
    provider,
    modelId,
  });
}

async function pushSelection(msg: PushSelectionMessage): Promise<void> {
  const [connection, token, atlassianEmail, llmToken] = await Promise.all([
    figma.clientStorage.getAsync(STORAGE_KEYS.connection) as Promise<
      PluginConnection | undefined
    >,
    figma.clientStorage.getAsync(STORAGE_KEYS.token) as Promise<string | undefined>,
    figma.clientStorage.getAsync(STORAGE_KEYS.atlassianEmail) as Promise<
      string | undefined
    >,
    figma.clientStorage.getAsync(STORAGE_KEYS.llmToken) as Promise<string | undefined>,
  ]);

  const apiBase = msg.apiBase ?? DEFAULT_API_BASE;

  if (!connection || !token) {
    figma.ui.postMessage({
      type: "error",
      message: "Connect a repository before pushing components.",
    });
    return;
  }

  if (!connection.setupCorrectedAt) {
    figma.ui.postMessage({
      type: "error",
      message: "Save project setup before pushing components.",
    });
    return;
  }

  if (!llmToken?.trim()) {
    figma.ui.postMessage({
      type: "error",
      message: "Save LLM settings before pushing components.",
    });
    return;
  }

  const selectionError = getPushSelectionError();
  if (selectionError) {
    figma.ui.postMessage({
      type: "error",
      message: selectionError,
    });
    return;
  }

  const node = figma.currentPage.selection[0]!;
  const setupOverrides = readSetupOverrides(connection);
  const tokenConfig = await ensureTokenCatalog(connection, setupOverrides);
  const tokenCatalog =
    tokenConfig?.catalog ?? connection.syncConfig.tokens?.catalog;

  // Debug: dump raw boundVariables from the first variant child
  if ("children" in node) {
    const firstVariant = (node as FrameNode).children?.[0];
    if (firstVariant && "fills" in firstVariant) {
      const rawFills = (firstVariant as FrameNode).fills;
      const bvNode = "boundVariables" in firstVariant ? firstVariant.boundVariables : null;
      const paintBvs = Array.isArray(rawFills)
        ? rawFills.map((f: Paint, i: number) => ({
            index: i,
            type: f.type,
            paintBoundVars: (f as { boundVariables?: unknown }).boundVariables ?? null,
          }))
        : [];
      console.log("[fig2code] boundVariables debug", {
        variantName: firstVariant.name,
        nodeBoundVariables: bvNode ? Object.keys(bvNode) : null,
        nodeBvFills: bvNode?.fills ?? null,
        paintLevelBoundVars: paintBvs,
      });
    }
  }

  const snapshot = await nodeToSnapshot(node);
  const previewTheme = await resolveFigmaPreviewTheme(node, connection.syncConfig.themes);
  const prunedSpec = pruneNodeTree(snapshot, {
    typography: connection.syncConfig.typography?.catalog,
    tokenCatalog,
  });
  if (previewTheme) {
    prunedSpec.metadata = { ...prunedSpec.metadata, previewTheme };
  }

  console.log("[fig2code] build component snapshot", {
    nodeType: node.type,
    nodeName: node.name,
    childCount: snapshot.children?.length ?? 0,
    variantKeys: Object.keys(snapshot.componentPropertyDefinitions ?? {}),
  });
  console.log("[fig2code] prunedSpec", JSON.stringify(prunedSpec, null, 2));
  figma.ui.postMessage({ type: "debug-log", label: "prunedSpec", data: prunedSpec });
  figma.ui.postMessage({
    type: "debug-log",
    label: "colorPipeline",
    data: buildColorPipelineDebug(snapshot, prunedSpec, tokenCatalog),
  });
  figma.ui.postMessage({
    type: "debug-log",
    label: "snapshotSummary",
    data: {
      name: snapshot.name,
      type: snapshot.type,
      childCount: snapshot.children?.length ?? 0,
      textNodes: countSnapshotNodes(snapshot, "TEXT"),
      instanceNodes: countSnapshotNodes(snapshot, "INSTANCE"),
      variantDefinitions: snapshot.componentPropertyDefinitions,
      propCount: Object.keys(prunedSpec.props ?? {}).length,
      slotCount: Object.keys(prunedSpec.slots ?? {}).length,
      styleKeys: Object.keys(prunedSpec.styles ?? {}),
      typographyRoles: Object.keys(prunedSpec.typography ?? {}),
      hasLayout: Boolean(prunedSpec.layout),
    },
  });

  const provider = msg.provider as LlmProviderId;
  const modelId = modelIdForProvider(provider, msg.modelId);
  const correctionNotes = msg.corrections?.trim();
  const existingNotes = connection.syncConfig.llm?.notes ?? "";
  const notes = correctionNotes
    ? [existingNotes, `Corrections:\n${correctionNotes}`].filter(Boolean).join("\n\n")
    : existingNotes;
  const syncConfig = {
    ...connection.syncConfig,
    tokens: tokenConfig ?? connection.syncConfig.tokens,
    llm: {
      ...connection.syncConfig.llm,
      modelId,
      notes: notes || undefined,
      promptProfile: connection.syncConfig.llm?.promptProfile ?? "component-v1",
    },
  };

  // Generate token CSS from snapshot fills so preview can render custom colors
  const tokenCssFromFills = buildTokenCssFromSnapshot(snapshot);
  if (tokenCssFromFills && syncConfig.tokens) {
    syncConfig.tokens = {
      ...syncConfig.tokens,
      sourceExcerpt: [syncConfig.tokens.sourceExcerpt, tokenCssFromFills]
        .filter(Boolean)
        .join("\n"),
    };
  } else if (tokenCssFromFills && !syncConfig.tokens) {
    syncConfig.tokens = {
      tokenPaths: [],
      catalog: { sourcePath: "figma-fills", format: "css-variables", entries: [] },
      sourceExcerpt: tokenCssFromFills,
    };
  }

  const resolvedName = resolveComponentNameFromNode(node) ?? prunedSpec.name;
  const bundleMatch =
    lastResolve &&
    lastResolve.matched &&
    lastResolve.selectionId === node.id &&
    lastResolve.componentName === resolvedName &&
    lastResolve.bundleId
      ? lastResolve
      : null;

  const previewFileOverrides = msg.previewFileOverrides?.filter(
    (file) => file.path?.trim() && file.content?.trim(),
  );
  const hasPreviewOverrides = Boolean(previewFileOverrides?.length);

  const body: EnqueueJobRequest = bundleMatch || hasPreviewOverrides
    ? {
        intent: "component-update",
        prunedSpec,
        targets: syncConfig.platforms,
        sessionId: connection.sessionId,
        vcs: connection.vcs,
        syncConfig,
        ...(bundleMatch?.bundleId ? { bundleId: bundleMatch.bundleId } : {}),
        ...(hasPreviewOverrides ? { previewFileOverrides } : {}),
      }
    : {
        intent: "component",
        prunedSpec,
        targets: syncConfig.platforms,
        sessionId: connection.sessionId,
        vcs: connection.vcs,
        syncConfig,
      };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-git-token": token,
    "x-llm-token": llmToken.trim(),
  };
  if (atlassianEmail?.trim()) {
    headers["x-atlassian-email"] = atlassianEmail.trim();
  }

  const res = await fetch(`${apiBase}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `API error ${res.status}`);
  }

  const job = (await res.json()) as JobRecord;
  figma.ui.postMessage({ type: "job-created", job, apiBase });
  void pollJobUntilTerminal(apiBase, job.id);
}

const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 120_000;

async function pollJobUntilTerminal(apiBase: string, jobId: string): Promise<void> {
  const started = Date.now();

  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      figma.ui.postMessage({
        type: "job-update",
        job: { id: jobId, status: "failed", error: "Timed out waiting for job status" },
      });
      return;
    }

    const res = await fetch(`${apiBase}/jobs/${jobId}`);
    if (!res.ok) continue;

    const job = (await res.json()) as JobRecord;
    figma.ui.postMessage({ type: "job-update", job });

    if (isTerminalJobStatus(job.status)) {
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollJob(apiBase: string, jobId: string): Promise<void> {
  const res = await fetch(`${apiBase}/jobs/${jobId}`);
  const job = (await res.json()) as JobRecord;
  figma.ui.postMessage({ type: "job-update", job });
}

async function createPullRequest(msg: CreatePullRequestMessage): Promise<void> {
  const apiBase = msg.apiBase ?? DEFAULT_API_BASE;
  const [token, atlassianEmail, connection] = await Promise.all([
    figma.clientStorage.getAsync(STORAGE_KEYS.token) as Promise<string | undefined>,
    figma.clientStorage.getAsync(STORAGE_KEYS.atlassianEmail) as Promise<string | undefined>,
    figma.clientStorage.getAsync(STORAGE_KEYS.connection) as Promise<
      PluginConnection | undefined
    >,
  ]);

  if (!token?.trim()) {
    throw new Error("Git token is required");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-git-token": token.trim(),
  };
  if (atlassianEmail?.trim()) {
    headers["x-atlassian-email"] = atlassianEmail.trim();
  }

  if (msg.jobId) {
    const body: {
      targetBranch?: string;
      patches?: CreatePullRequestMessage["patches"];
      previewFileOverrides?: CreatePullRequestMessage["previewFileOverrides"];
    } = {};

    if (msg.targetBranch?.trim()) {
      body.targetBranch = msg.targetBranch.trim();
    }
    if (msg.patches?.length) {
      body.patches = msg.patches;
    }
    if (msg.previewFileOverrides?.length) {
      body.previewFileOverrides = msg.previewFileOverrides;
    }

    const res = await fetch(`${apiBase}/jobs/${msg.jobId}/pull-request`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Failed to open pull request (${res.status})`);
    }

    const job = (await res.json()) as JobRecord;
    figma.ui.postMessage({ type: "job-update", job });
    return;
  }

  if (!connection?.vcs) {
    throw new Error("Connect a repository before opening a pull request");
  }

  // No validated codegen job — this is update mode, where the designer manually
  // edited an existing component. Open a PR straight from those edits.
  if (!msg.patches?.length) {
    throw new Error("No edits to include in the pull request");
  }

  const res = await fetch(`${apiBase}/pull-request`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      vcs: connection.vcs,
      componentName: msg.componentName,
      targetBranch: msg.targetBranch?.trim() || undefined,
      patches: msg.patches,
    }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Failed to open pull request (${res.status})`);
  }

  const result = (await res.json()) as { prUrl?: string };
  figma.ui.postMessage({ type: "pull-request-opened", prUrl: result.prUrl });
}

function buildVcsFromMessage(msg: VcsFormMessage): VcsConfig {
  return buildVcs(
    msg.provider,
    msg.slugA,
    msg.slugB,
    msg.baseBranch,
    msg.defaultPrTarget,
  );
}

function collectTokenPaths(
  connection: PluginConnection,
  overrides: SetupOverrides,
): string[] {
  const fromOverrides = parseCommaSeparatedPaths(overrides.tokenPaths);
  if (fromOverrides.length > 0) {
    return fromOverrides;
  }

  const fromSync =
    connection.syncConfig.tokens?.tokenPaths ?? connection.syncConfig.web?.tokenPaths ?? [];
  if (fromSync.length > 0) {
    return fromSync;
  }

  const fromDetected = [...connection.detected.tokenPaths];
  if (
    connection.detected.tailwindConfigPath &&
    !fromDetected.includes(connection.detected.tailwindConfigPath)
  ) {
    fromDetected.push(connection.detected.tailwindConfigPath);
  }

  return fromDetected;
}

async function ensureTokenCatalog(
  connection: PluginConnection,
  overrides: SetupOverrides,
): Promise<TokenConfig | undefined> {
  const existingColors =
    connection.syncConfig.tokens?.catalog.entries.filter((entry) => entry.category === "color")
      .length ?? 0;
  if (existingColors > 0) {
    return connection.syncConfig.tokens;
  }

  return refreshTokenCatalog(connection, overrides, connection.syncConfig.typography?.catalog);
}

async function refreshTypographyCatalog(
  connection: PluginConnection,
  overrides: SetupOverrides,
): Promise<TypographyConfig | undefined> {
  const [token, atlassianEmail] = await Promise.all([
    figma.clientStorage.getAsync(STORAGE_KEYS.token) as Promise<string | undefined>,
    figma.clientStorage.getAsync(STORAGE_KEYS.atlassianEmail) as Promise<string | undefined>,
  ]);

  if (!token) {
    return connection.syncConfig.typography;
  }

  const fontPaths = parseCommaSeparatedPaths(overrides.fontPaths);
  const tokenPaths = collectTokenPaths(connection, overrides);

  if (fontPaths.length === 0) {
    return connection.syncConfig.typography;
  }

  const apiBase = connection.apiBase ?? DEFAULT_API_BASE;
  const web = connection.syncConfig.web;

  const res = await fetch(`${apiBase}/repos/typography`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vcs: connection.vcs,
      token,
      atlassianEmail,
      fontPaths,
      tokenPaths: tokenPaths.length > 0 ? tokenPaths : connection.syncConfig.tokens?.tokenPaths,
      tailwindConfigPath: connection.detected.tailwindConfigPath,
      styleSystem: overrides.styleSystem ?? web?.styleSystem,
    }),
  });

  if (!res.ok) {
    return connection.syncConfig.typography;
  }

  try {
    const body = (await res.json()) as { typography?: TypographyConfig };
    return body.typography ?? connection.syncConfig.typography;
  } catch {
    return connection.syncConfig.typography;
  }
}

async function refreshTokenCatalog(
  connection: PluginConnection,
  overrides: SetupOverrides,
  typographyCatalog?: TypographyCatalog,
): Promise<TokenConfig | undefined> {
  const [token, atlassianEmail] = await Promise.all([
    figma.clientStorage.getAsync(STORAGE_KEYS.token) as Promise<string | undefined>,
    figma.clientStorage.getAsync(STORAGE_KEYS.atlassianEmail) as Promise<string | undefined>,
  ]);

  if (!token) {
    return connection.syncConfig.tokens;
  }

  const parsedTokenPaths = collectTokenPaths(connection, overrides);
  if (parsedTokenPaths.length === 0) {
    return connection.syncConfig.tokens;
  }

  const tokenPaths = parsedTokenPaths;

  const apiBase = connection.apiBase ?? DEFAULT_API_BASE;
  const web = connection.syncConfig.web;

  const res = await fetch(`${apiBase}/repos/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vcs: connection.vcs,
      token,
      atlassianEmail,
      tokenPaths,
      fontPaths: connection.detected.fontPaths,
      tailwindConfigPath: connection.detected.tailwindConfigPath,
      styleSystem: overrides.styleSystem ?? web?.styleSystem,
      typographyCatalog,
    }),
  });

  if (!res.ok) {
    return connection.syncConfig.tokens;
  }

  try {
    const body = (await res.json()) as { tokens?: TokenConfig };
    return body.tokens ?? connection.syncConfig.tokens;
  } catch {
    return connection.syncConfig.tokens;
  }
}

function readTextTypography(node: TextNode): FigmaTextTypography | undefined {
  const typography: FigmaTextTypography = {};

  if (typeof node.fontSize === "number") {
    typography.fontSize = node.fontSize;
  }

  if (typeof node.fontWeight === "number") {
    typography.fontWeight = node.fontWeight;
  } else if (node.fontName !== figma.mixed) {
    typography.fontWeight = parseFontWeightFromStyle(node.fontName.style);
  }

  if (node.fontName !== figma.mixed) {
    typography.fontFamily = node.fontName.family;
    typography.fontStyle = node.fontName.style;
  }

  if (node.lineHeight !== figma.mixed && typeof node.lineHeight === "object") {
    if (node.lineHeight.unit === "PIXELS") {
      typography.lineHeight = node.lineHeight.value;
    } else if (node.lineHeight.unit === "PERCENT" && typeof node.fontSize === "number") {
      typography.lineHeight = (node.fontSize * node.lineHeight.value) / 100;
    }
  }

  if (node.letterSpacing !== figma.mixed && typeof node.letterSpacing === "object") {
    if (node.letterSpacing.unit === "PIXELS") {
      typography.letterSpacing = node.letterSpacing.value;
    } else if (node.letterSpacing.unit === "PERCENT" && typeof node.fontSize === "number") {
      typography.letterSpacing = (node.fontSize * node.letterSpacing.value) / 100;
    }
  }

  return Object.keys(typography).length > 0 ? typography : undefined;
}

async function resolveFillColorToken(
  boundAlias?: VariableAlias,
): Promise<string | undefined> {
  if (!boundAlias || !figma.variables) {
    return undefined;
  }

  try {
    const variable = await figma.variables.getVariableByIdAsync(boundAlias.id);
    if (!variable) {
      return undefined;
    }
    return normalizeColorTokenName(variable.name);
  } catch {
    return undefined;
  }
}

async function resolveVariableToken(
  boundAlias?: VariableAlias,
): Promise<string | undefined> {
  if (!boundAlias || !figma.variables) {
    return undefined;
  }

  try {
    const variable = await figma.variables.getVariableByIdAsync(boundAlias.id);
    if (!variable) {
      return undefined;
    }
    return variable.name.replace(/\//g, "-").trim();
  } catch {
    return undefined;
  }
}

function buildColorPipelineDebug(
  snapshot: FigmaNodeSnapshot,
  prunedSpec: PrunedSpec,
  _tokenCatalog?: TokenCatalog,
) {
  const variantComponents = (snapshot.children ?? []).filter((child) => child.type === "COMPONENT");

  const allFillsMissingTokens = variantComponents.every((variant) =>
    (variant.fills ?? []).every((fill) => !fill.colorToken),
  );

  const hasRawTokens = Object.values(prunedSpec.styles ?? {}).some((style) => style.bg?.includes("raw/"));

  let diagnosis: string;
  if (allFillsMissingTokens && variantComponents.length > 0) {
    diagnosis =
      "No bound variables found on fills — ensure fills in Figma are linked to color variables (right-click fill → Apply variable).";
  } else if (hasRawTokens) {
    diagnosis =
      "Some fills have no bound variables — raw RGB fallback used. Bind variables to fills in Figma.";
  } else {
    diagnosis = "Color variable names captured successfully from Figma.";
  }

  return {
    figmaFills: variantComponents.map((variant) => ({
      variantName: variant.name,
      fills: (variant.fills ?? []).map((fill) => ({
        rgb: fill.color
          ? [
              Math.round(fill.color.r * 255),
              Math.round(fill.color.g * 255),
              Math.round(fill.color.b * 255),
            ]
          : null,
        colorToken: fill.colorToken ?? null,
      })),
    })),
    prunedSpecBg: Object.fromEntries(
      Object.entries(prunedSpec.styles ?? {}).map(([key, style]) => [key, style.bg ?? null]),
    ),
    diagnosis,
  };
}

/**
 * Build CSS variable definitions from snapshot fills that have both
 * a colorToken name and an RGB value — used to render the preview.
 */
function buildTokenCssFromSnapshot(snapshot: FigmaNodeSnapshot): string | undefined {
  const vars = new Map<string, string>();

  function collectFromNode(node: FigmaNodeSnapshot): void {
    for (const fill of node.fills ?? []) {
      if (fill.colorToken && fill.color) {
        const r = Math.round(fill.color.r * 255);
        const g = Math.round(fill.color.g * 255);
        const b = Math.round(fill.color.b * 255);
        vars.set(`--${fill.colorToken}`, `rgb(${r}, ${g}, ${b})`);
      }
    }
    for (const child of node.children ?? []) {
      collectFromNode(child);
    }
  }

  collectFromNode(snapshot);

  if (vars.size === 0) {
    return undefined;
  }

  const lines = [":root {"];
  for (const [name, value] of vars) {
    lines.push(`  ${name}: ${value};`);
  }
  lines.push("}");
  return lines.join("\n");
}

async function nodeToSnapshot(node: SceneNode): Promise<FigmaNodeSnapshot> {
  const base: FigmaNodeSnapshot = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };

  if (node.type === "TEXT") {
    base.characters = node.characters;
    base.typography = readTextTypography(node);
  }

  if ("fills" in node && Array.isArray(node.fills)) {
    const boundFills =
      "boundVariables" in node && node.boundVariables?.fills
        ? node.boundVariables.fills
        : undefined;

    const solidFills: FigmaNodeSnapshot["fills"] = [];

    for (let index = 0; index < node.fills.length; index += 1) {
      const fill = node.fills[index]!;
      if (fill.type !== "SOLID") continue;

      let colorToken: string | undefined;

      // Path 1: node-level boundVariables.fills[index]
      if (boundFills) {
        colorToken = await resolveFillColorToken(boundFills[index]);
      }

      // Path 2: paint-level boundVariables.color (SolidPaint)
      if (!colorToken) {
        const paintBv = (fill as { boundVariables?: { color?: VariableAlias } }).boundVariables;
        if (paintBv?.color) {
          colorToken = await resolveFillColorToken(paintBv.color);
        }
      }

      solidFills.push({
        type: fill.type,
        color: fill.color,
        colorToken,
      });
    }

    if (solidFills.length > 0) {
      base.fills = solidFills;
    }
  }

  if ("cornerRadius" in node && typeof node.cornerRadius === "number") {
    base.cornerRadius = node.cornerRadius;
    const bv = "boundVariables" in node ? node.boundVariables : undefined;
    const radiusAlias = bv?.topLeftRadius ?? (bv as Record<string, unknown>)?.cornerRadius;
    base.cornerRadiusToken = await resolveVariableToken(radiusAlias as VariableAlias | undefined);
  }

  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    base.layoutMode = node.layoutMode;
  }

  if ("itemSpacing" in node && typeof node.itemSpacing === "number") {
    base.itemSpacing = node.itemSpacing;
    const bv = "boundVariables" in node ? node.boundVariables : undefined;
    base.itemSpacingToken = await resolveVariableToken(bv?.itemSpacing);
  }

  if ("paddingTop" in node) {
    base.paddingTop = node.paddingTop;
    base.paddingRight = node.paddingRight;
    base.paddingBottom = node.paddingBottom;
    base.paddingLeft = node.paddingLeft;

    const bv = "boundVariables" in node ? node.boundVariables : undefined;
    const [pt, pr, pb, pl] = await Promise.all([
      resolveVariableToken(bv?.paddingTop),
      resolveVariableToken(bv?.paddingRight),
      resolveVariableToken(bv?.paddingBottom),
      resolveVariableToken(bv?.paddingLeft),
    ]);
    if (pt || pr || pb || pl) {
      base.paddingTokens = { top: pt, right: pr, bottom: pb, left: pl };
    }
  }

  if ("componentPropertyReferences" in node && node.componentPropertyReferences) {
    base.componentPropertyReferences = { ...node.componentPropertyReferences };
  }

  if ("componentProperties" in node && node.componentProperties) {
    base.componentProperties = snapshotComponentProperties(node.componentProperties);
  }

  if (node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET") {
    base.variantValues = parseVariantName(node.name);
  }

  let mainComponent: ComponentNode | null = null;
  if (node.type === "INSTANCE") {
    mainComponent = await node.getMainComponentAsync();
    if (mainComponent) {
      base.mainComponent = {
        name: mainComponent.name,
        key: mainComponent.key,
      };
    }
  }

  const propertyDefinitions = await readComponentPropertyDefinitions(node, mainComponent);
  if (propertyDefinitions) {
    base.componentPropertyDefinitions = snapshotPropertyDefinitions(propertyDefinitions);
  }

  if ("children" in node) {
    base.children = await Promise.all(node.children.map((child) => nodeToSnapshot(child)));
  }

  return base;
}

function snapshotComponentProperties(
  properties: ComponentProperties,
): Record<string, boolean | string> {
  const result: Record<string, boolean | string> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "boolean" || typeof value === "string") {
      result[key] = value;
    }
  }

  return result;
}

function snapshotPropertyDefinitions(
  defs: Record<
    string,
    {
      type: string;
      defaultValue?: unknown;
      variantOptions?: string[];
      preferredValues?: Array<{ key?: string; name?: string }>;
    }
  >,
): FigmaNodeSnapshot["componentPropertyDefinitions"] {
  const result: NonNullable<FigmaNodeSnapshot["componentPropertyDefinitions"]> = {};

  for (const [key, def] of Object.entries(defs)) {
    result[key] = {
      type: def.type,
      defaultValue: def.defaultValue,
      variantOptions: def.variantOptions?.map(String),
    };

    if ("preferredValues" in def && Array.isArray(def.preferredValues)) {
      result[key]!.preferredValues = def.preferredValues.map((entry) => ({
        key: entry.key,
        name: "name" in entry && typeof entry.name === "string" ? entry.name : undefined,
      }));
    }
  }

  return result;
}

function countSnapshotNodes(node: FigmaNodeSnapshot, type: string): number {
  let count = node.type === type ? 1 : 0;
  for (const child of node.children ?? []) {
    count += countSnapshotNodes(child, type);
  }
  return count;
}

async function readComponentPropertyDefinitions(
  node: SceneNode,
  resolvedMainComponent: ComponentNode | null = null,
): Promise<FigmaNodeSnapshot["componentPropertyDefinitions"] | undefined> {
  if (node.type === "COMPONENT_SET") {
    return node.componentPropertyDefinitions as FigmaNodeSnapshot["componentPropertyDefinitions"];
  }

  if (node.type === "COMPONENT" && node.parent?.type !== "COMPONENT_SET") {
    return node.componentPropertyDefinitions as FigmaNodeSnapshot["componentPropertyDefinitions"];
  }

  if (node.type === "INSTANCE") {
    const main = resolvedMainComponent ?? (await node.getMainComponentAsync());
    if (!main) return undefined;

    if (main.parent?.type === "COMPONENT_SET") {
      return main.parent
        .componentPropertyDefinitions as FigmaNodeSnapshot["componentPropertyDefinitions"];
    }
    if (main.type === "COMPONENT") {
      return main.componentPropertyDefinitions as FigmaNodeSnapshot["componentPropertyDefinitions"];
    }
  }

  return undefined;
}

const PUSH_SELECTION_TYPES = new Set(["COMPONENT", "COMPONENT_SET", "INSTANCE"]);

function slugThemeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function classifyThemeCollection(collectionName: string): "brand" | "mode" | "unknown" {
  const slug = slugThemeToken(collectionName);
  if (/brand/.test(slug)) {
    return "brand";
  }
  if (/theme|mode|appearance|color-scheme/.test(slug)) {
    return "mode";
  }
  return "unknown";
}

async function collectFigmaVariableModes(node: SceneNode): Promise<Map<string, string>> {
  const byCollection = new Map<string, string>();
  let current: BaseNode | null = node;

  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if ("explicitVariableModes" in current) {
      const modes = current.explicitVariableModes;
      if (modes) {
        for (const [collectionId, modeId] of Object.entries(modes)) {
          if (!byCollection.has(collectionId)) {
            byCollection.set(collectionId, modeId);
          }
        }
      }
    }
    current = current.parent;
  }

  return byCollection;
}

function alignPreviewThemeWithCatalog(
  catalog: ThemeCatalog | null | undefined,
  partial: Partial<ThemeSelection>,
): PreviewThemeContext | undefined {
  if (!catalog?.entries.length) {
    if (partial.brand || partial.mode) {
      return { brand: partial.brand, mode: partial.mode };
    }
    return undefined;
  }

  const brand = partial.brand ? slugThemeToken(partial.brand) : undefined;
  const mode = partial.mode ? slugThemeToken(partial.mode) : undefined;

  if (brand && mode) {
    const exact = catalog.entries.find(
      (entry) => entry.brand === brand && entry.mode === mode,
    );
    if (exact) {
      return { brand: exact.brand, mode: exact.mode };
    }
  }

  if (brand) {
    const byBrand = catalog.entries.find((entry) => entry.brand === brand);
    if (byBrand) {
      return { brand: byBrand.brand, mode: byBrand.mode };
    }
  }

  if (mode) {
    const byMode = catalog.entries.find((entry) => entry.mode === mode);
    if (byMode) {
      return { brand: byMode.brand, mode: byMode.mode };
    }
  }

  if (catalog.default) {
    return { ...catalog.default };
  }

  const first = catalog.entries[0];
  return first ? { brand: first.brand, mode: first.mode } : undefined;
}

async function resolveFigmaPreviewTheme(
  node: SceneNode,
  themeCatalog?: ThemeCatalog | null,
): Promise<PreviewThemeContext | undefined> {
  const modeMap = await collectFigmaVariableModes(node);
  const partial: Partial<ThemeSelection> = {};

  for (const [collectionId, modeId] of modeMap) {
    try {
      const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
      if (!collection) {
        continue;
      }
      const mode = collection.modes.find((entry) => entry.modeId === modeId);
      if (!mode) {
        continue;
      }

      const kind = classifyThemeCollection(collection.name);
      const modeSlug = slugThemeToken(mode.name);
      if (kind === "brand") {
        partial.brand = modeSlug;
      } else if (kind === "mode") {
        partial.mode = modeSlug;
      } else if (themeCatalog?.entries.some((entry) => entry.brand === modeSlug)) {
        partial.brand = modeSlug;
      } else if (themeCatalog?.entries.some((entry) => entry.mode === modeSlug)) {
        partial.mode = modeSlug;
      }
    } catch {
      // Variable API unavailable in this context.
    }
  }

  return alignPreviewThemeWithCatalog(themeCatalog, partial);
}

function getPushSelectionError(): string | null {
  const selection = figma.currentPage.selection;

  if (selection.length !== 1) {
    return "Select exactly one component, component set, or instance.";
  }

  if (!PUSH_SELECTION_TYPES.has(selection[0]!.type)) {
    return "Select a main component, component set, or instance — not a frame or group.";
  }

  return null;
}

function hasValidPushSelection(): boolean {
  return getPushSelectionError() === null;
}

function postSelectionState(): void {
  void postSelectionStateAsync();
}

async function postSelectionStateAsync(): Promise<void> {
  const selection = figma.currentPage.selection;
  const node = selection.length === 1 ? selection[0]! : null;
  const connection = (await figma.clientStorage.getAsync(STORAGE_KEYS.connection)) as
    | PluginConnection
    | undefined;
  const previewTheme =
    node && hasValidPushSelection()
      ? await resolveFigmaPreviewTheme(node, connection?.syncConfig?.themes)
      : undefined;

  figma.ui.postMessage({
    type: "selection-changed",
    hasValidSelection: hasValidPushSelection(),
    selectionId: node?.id ?? null,
    selectionName: node?.name ?? null,
    previewTheme,
  });

  scheduleResolveComponent(node);
}

function scheduleResolveComponent(node: SceneNode | null): void {
  if (resolveDebounceTimer) {
    clearTimeout(resolveDebounceTimer);
    resolveDebounceTimer = null;
  }

  if (!node || !hasValidPushSelection()) {
    lastResolve = null;
    lastScheduledSelectionId = null;
    ++resolveRequestSeq;
    figma.ui.postMessage({
      type: "component-resolved",
      mode: "create",
      matched: false,
      selectionId: node?.id ?? null,
      componentName: node?.name ?? null,
    });
    return;
  }

  const selectionId = node.id;
  const componentName = resolveComponentNameFromNode(node);

  if (selectionId !== lastScheduledSelectionId) {
    ++resolveRequestSeq;
    ++previewRequestSeq;
    lastScheduledSelectionId = selectionId;
  }

  if (!componentName) {
    lastResolve = null;
    figma.ui.postMessage({
      type: "component-resolved",
      mode: "create",
      matched: false,
      selectionId,
      componentName: null,
    });
    return;
  }

  if (
    lastResolve &&
    lastResolve.selectionId === selectionId &&
    lastResolve.componentName === componentName
  ) {
    figma.ui.postMessage({
      type: "component-resolved",
      mode: lastResolve.matched ? "update" : "create",
      matched: lastResolve.matched,
      selectionId,
      componentName: lastResolve.resolvedComponentName ?? componentName,
      bundleId: lastResolve.bundleId,
      bundle: lastResolve.bundle,
      reason: lastResolve.reason,
    });
    return;
  }

  figma.ui.postMessage({
    type: "component-resolving",
    selectionId,
    componentName,
  });

  resolveDebounceTimer = setTimeout(() => {
    void runResolveComponent(componentName, selectionId);
  }, RESOLVE_DEBOUNCE_MS);
}

function resolveComponentNameFromNode(node: SceneNode): string | null {
  const raw = node.name?.trim();
  if (!raw) return null;
  const head = raw.split(/[/=]/)[0]?.trim();
  return head || raw;
}

async function ensureExistingPreview(msg: {
  selectionId: string;
  componentName: string;
  componentPath: string;
  storyPath?: string;
}): Promise<void> {
  const previewSeq = ++previewRequestSeq;
  const [connection, token, atlassianEmail] = await Promise.all([
    figma.clientStorage.getAsync(STORAGE_KEYS.connection) as Promise<
      PluginConnection | undefined
    >,
    figma.clientStorage.getAsync(STORAGE_KEYS.token) as Promise<string | undefined>,
    figma.clientStorage.getAsync(STORAGE_KEYS.atlassianEmail) as Promise<
      string | undefined
    >,
  ]);

  if (!connection || !token) {
    figma.ui.postMessage({ type: "existing-preview-failed" });
    return;
  }

  const apiBase = connection.apiBase ?? DEFAULT_API_BASE;

  const selectionNode = figma.currentPage.selection[0];
  const themeSelection =
    selectionNode && selectionNode.id === msg.selectionId
      ? await resolveFigmaPreviewTheme(selectionNode, connection.syncConfig.themes)
      : undefined;

  try {
    const previewRes = await fetch(`${apiBase}/preview/existing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-git-token": token,
      },
      body: JSON.stringify({
        vcs: connection.vcs,
        componentPath: msg.componentPath,
        componentName: msg.componentName,
        storyPath: msg.storyPath,
        atlassianEmail,
        tokenPaths:
          connection.syncConfig.web?.tokenPaths ??
          connection.syncConfig.tokens?.tokenPaths ??
          connection.detected.tokenPaths,
        themeCatalog: connection.syncConfig.themes,
        themeSelection,
      }),
    });

    if (previewSeq !== previewRequestSeq) return;

    if (!previewRes.ok) {
      const errBody = (await previewRes.json().catch(() => ({}))) as { error?: string };
      console.warn("[fig2code] existing preview failed", previewRes.status, errBody.error);
      figma.ui.postMessage({
        type: "existing-preview-failed",
        reason: errBody.error ?? `Preview failed (${previewRes.status})`,
      });
      return;
    }

    const data = (await previewRes.json()) as {
      sessionId: string;
      previewUrl: string;
      viteUrl: string;
    };
    if (previewSeq !== previewRequestSeq) return;

    figma.ui.postMessage({
      type: "existing-preview-ready",
      sessionId: data.sessionId,
      previewUrl: `${apiBase}${data.previewUrl}`,
      selectionId: msg.selectionId,
      componentName: msg.componentName,
    });
  } catch (err) {
    console.warn("[fig2code] existing preview error", err);
    if (previewSeq === previewRequestSeq) {
      figma.ui.postMessage({
        type: "existing-preview-failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function runResolveComponent(componentName: string, selectionId: string): Promise<void> {
  const seq = ++resolveRequestSeq;
  const [connection, token, atlassianEmail] = await Promise.all([
    figma.clientStorage.getAsync(STORAGE_KEYS.connection) as Promise<
      PluginConnection | undefined
    >,
    figma.clientStorage.getAsync(STORAGE_KEYS.token) as Promise<string | undefined>,
    figma.clientStorage.getAsync(STORAGE_KEYS.atlassianEmail) as Promise<
      string | undefined
    >,
  ]);

  if (!connection || !token) {
    lastResolve = null;
    figma.ui.postMessage({
      type: "component-resolved",
      mode: "create",
      matched: false,
      selectionId,
      componentName,
      reason: "Connect a repository to detect existing components.",
    });
    return;
  }

  const apiBase = connection.apiBase ?? DEFAULT_API_BASE;

  console.log("[fig2code] resolve-component start", {
    componentName,
    selectionId,
    apiBase,
    componentPath: connection.syncConfig.web?.componentPath,
  });

  try {
    const res = await fetch(`${apiBase}/repos/resolve-component`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vcs: connection.vcs,
        token,
        atlassianEmail,
        componentName,
        syncConfig: connection.syncConfig,
        detected: connection.detected,
      }),
    });

    if (seq !== resolveRequestSeq) {
      return;
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}) as Record<string, unknown>);
      const reason =
        typeof errBody?.error === "string"
          ? errBody.error
          : `Resolve failed (${res.status})`;
      console.warn("[fig2code] resolve-component error", { status: res.status, reason });
      lastResolve = {
        selectionId,
        componentName,
        matched: false,
        reason,
      };
      figma.ui.postMessage({
        type: "component-resolved",
        mode: "create",
        matched: false,
        selectionId,
        componentName,
        reason,
      });
      return;
    }

    const body = (await res.json()) as ResolveComponentResponse;
    console.log("[fig2code] resolve-component done", {
      componentName,
      matched: body.matched,
      bundleId: body.bundleId,
      files: body.bundle?.files?.map((f) => f.path),
    });
    if (body.matched && body.bundleId && body.bundle) {
      const resolvedComponentName = body.bundle.componentName;

      lastResolve = {
        selectionId,
        componentName,
        resolvedComponentName,
        bundleId: body.bundleId,
        matched: true,
        reason: body.bundle.match.reason,
        bundle: body.bundle,
      };

      figma.ui.postMessage({
        type: "component-resolved",
        mode: "update",
        matched: true,
        selectionId,
        componentName: resolvedComponentName,
        bundleId: body.bundleId,
        bundle: body.bundle,
        reason: body.bundle.match.reason,
      });
    } else {
      lastResolve = {
        selectionId,
        componentName,
        matched: false,
        reason: body.reason,
      };
      figma.ui.postMessage({
        type: "component-resolved",
        mode: "create",
        matched: false,
        selectionId,
        componentName,
        reason: body.reason ?? `No matching files for "${componentName}" in repo.`,
      });
    }
  } catch (error) {
    if (seq !== resolveRequestSeq) return;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("[fig2code] resolve-component fetch failed", reason);
    lastResolve = {
      selectionId,
      componentName,
      matched: false,
      reason,
    };
    figma.ui.postMessage({
      type: "component-resolved",
      mode: "create",
      matched: false,
      selectionId,
      componentName,
      reason,
    });
  }
}

figma.on("selectionchange", postSelectionState);

interface ConnectApiResponse {
  sessionId: string;
  repoUrl: string;
  detected: PluginConnection["detected"];
  syncConfig: PluginConnection["syncConfig"];
  refs: Array<{ name: string; sha?: string }>;
}

interface VcsFormMessage {
  provider: "github" | "bitbucket";
  slugA: string;
  slugB: string;
  baseBranch: string;
  defaultPrTarget: string;
  token: string;
  atlassianEmail?: string;
  apiBase?: string;
}

type LoadBranchesMessage = VcsFormMessage;
type ConnectMessage = VcsFormMessage;

interface RescanMessage {
  type: "rescan";
  apiBase?: string;
  baseBranch: string;
  defaultPrTarget: string;
}

interface SaveLlmMessage {
  type: "save-llm";
  provider: string;
  modelId: string;
  token: string;
}

interface PushSelectionMessage {
  type: "push-selection";
  apiBase: string;
  provider: string;
  modelId: string;
  corrections?: string;
  previewFileOverrides?: Array<{
    path: string;
    role: string;
    content: string;
  }>;
}

interface CreatePullRequestMessage {
  type: "create-pull-request";
  apiBase: string;
  jobId?: string;
  componentName: string;
  targetBranch?: string;
  patches: Array<{ path: string; action: "create" | "update"; content: string }>;
  previewFileOverrides?: Array<{
    path: string;
    role: string;
    content: string;
  }>;
}

type PluginMessage =
  | { type: "ui-ready" }
  | { type: "resize-ui"; width: number; height: number }
  | { type: "save-api-base"; apiBase: string }
  | LoadBranchesMessage & { type: "load-branches" }
  | ConnectMessage & { type: "connect" }
  | RescanMessage
  | { type: "disconnect" }
  | { type: "save-setup"; overrides: SetupOverrides }
  | SaveLlmMessage
  | PushSelectionMessage
  | CreatePullRequestMessage
  | { type: "open-external-url"; url: string }
  | { type: "check-job"; jobId: string; apiBase: string }
  | {
      type: "ensure-existing-preview";
      selectionId: string;
      componentName: string;
      componentPath: string;
      storyPath?: string;
    };
