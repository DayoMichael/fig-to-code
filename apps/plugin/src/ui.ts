import { highlightTs, renderLineNumbers } from "./syntax-highlight.js";
import {
  extractExistingPreviewMetadata,
  resolveInitialPreviewArgs,
  type PreviewPropControl,
} from "@fig2code/codegen/preview-utils";
import { inferBreakingFromText, inferFixFromText } from "@fig2code/codegen/change-summary";
import {
  PREVIEW_ICON_CLOSE,
  PREVIEW_ICON_CODE,
  PREVIEW_ICON_COPY,
  PREVIEW_ICON_EDIT,
  PREVIEW_ICON_EXPAND,
  PREVIEW_ICON_PREVIEW,
  PREVIEW_ICON_CHEVRON_LEFT,
  PREVIEW_ICON_CHEVRON_RIGHT,
} from "./preview-icons.js";

const connectScreen = document.getElementById("connect-screen")!;
const mainScreen = document.getElementById("main-screen")!;
const statusEl = document.getElementById("status")!;
const providerEl = document.getElementById("provider") as HTMLSelectElement;
const labelSlugA = document.getElementById("label-slug-a")!;
const slugAEl = document.getElementById("slug-a") as HTMLInputElement;
const slugBEl = document.getElementById("slug-b") as HTMLInputElement;
const tokenEl = document.getElementById("token") as HTMLInputElement;
const apiBaseEl = document.getElementById("api-base") as HTMLInputElement;
const baseBranchEl = document.getElementById("base-branch") as HTMLSelectElement;
const prTargetEl = document.getElementById("pr-target") as HTMLSelectElement;
const connectedBadgeText = document.getElementById("connected-badge-text")!;
const setupFormSection = document.getElementById("setup-form-section")!;
const readySection = document.getElementById("ready-section")!;
const setupPreviewEl = document.getElementById("setup-preview")!;
const projectDetailsBodyEl = document.getElementById("project-details-body")!;
const pushBtn = document.getElementById("push") as HTMLButtonElement;
const loadBranchesBtn = document.getElementById("load-branches") as HTMLButtonElement;
const connectBtn = document.getElementById("connect") as HTMLButtonElement;
const rescanBtn = document.getElementById("rescan") as HTMLButtonElement;
const saveSetupBtn = document.getElementById("save-setup") as HTMLButtonElement;
const editSetupBtn = document.getElementById("edit-setup") as HTMLButtonElement;
const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
const bitbucketFields = document.getElementById("bitbucket-fields")!;
const atlassianEmailEl = document.getElementById("atlassian-email") as HTMLInputElement;

const setupStyleEl = document.getElementById("setup-style") as HTMLSelectElement;
const setupComponentPathEl = document.getElementById("setup-component-path") as HTMLInputElement;
const setupTokenPathEl = document.getElementById("setup-token-path") as HTMLInputElement;
const setupIconPathEl = document.getElementById("setup-icon-path") as HTMLInputElement;
const setupFontPathsEl = document.getElementById("setup-font-paths") as HTMLInputElement;
const setupTestFrameworkEl = document.getElementById("setup-test-framework") as HTMLSelectElement;
const setupStoryFormatEl = document.getElementById("setup-story-format") as HTMLSelectElement;
const setupFileNamingEl = document.getElementById("setup-file-naming") as HTMLSelectElement;
const setupBaseBranchEl = document.getElementById("setup-base-branch") as HTMLInputElement;
const setupPrTargetEl = document.getElementById("setup-pr-target") as HTMLInputElement;
const setupNotesEl = document.getElementById("setup-notes") as HTMLTextAreaElement;
const llmSummaryText = document.getElementById("llm-summary-text")!;
const llmFormSection = document.getElementById("llm-form-section")!;
const pushModelEl = document.getElementById("push-model") as HTMLSelectElement;
const llmTokenEl = document.getElementById("llm-token") as HTMLInputElement;
const editLlmBtn = document.getElementById("edit-llm") as HTMLButtonElement;
const saveLlmBtn = document.getElementById("save-llm") as HTMLButtonElement;
const buildPreviewSection = document.getElementById("build-preview-section")!;
const buildPreviewModePreviewBtn = document.getElementById("build-preview-mode-preview") as HTMLButtonElement;
const buildPreviewModeCodeBtn = document.getElementById("build-preview-mode-code") as HTMLButtonElement;
const buildPreviewPreviewPane = document.getElementById("build-preview-preview-pane")!;
const buildPreviewCodePane = document.getElementById("build-preview-code-pane")!;
const buildPreviewFormatEl = document.getElementById("build-preview-format")!;
const buildPreviewVariantEl = document.getElementById("build-preview-variant")!;
const buildPreviewSelectControlsEl = document.getElementById("build-preview-select-controls")!;
const buildPreviewInputControlsEl = document.getElementById("build-preview-input-controls")!;
const buildPreviewBooleanControlsEl = document.getElementById("build-preview-boolean-controls")!;
const buildPreviewControlsEl = document.getElementById("build-preview-controls")!;
const previewSelectGroupEl = document.getElementById("preview-select-group")!;
const previewInputGroupEl = document.getElementById("preview-input-group")!;
const previewBooleanGroupEl = document.getElementById("preview-boolean-group")!;
const buildPreviewCardEl = buildPreviewSection.querySelector(".build-preview-card") as HTMLElement;
const previewWorkflowEl = document.getElementById("preview-workflow")!;
const previewActionBarEl = document.getElementById("preview-action-bar")!;
const toggleAskBtn = document.getElementById("toggle-ask") as HTMLButtonElement;
const correctionStreamEl = document.getElementById("correction-stream")!;
const correctionStreamShellEl = document.getElementById("correction-stream-shell")!;
const previewActionsCountEl = document.getElementById("preview-actions-count")!;
const previewActionsDetailsEl = document.getElementById("preview-actions-details") as HTMLDetailsElement;
const buildPreviewFrameEl = document.getElementById("build-preview-frame") as HTMLIFrameElement;
const buildPreviewVisualEl = document.getElementById("build-preview-visual")!;
const buildPreviewEmptyEl = document.getElementById("build-preview-empty")!;
const buildPreviewActionLogEl = document.getElementById("build-preview-action-log")!;
const buildPreviewFileTreeEl = document.getElementById("build-preview-file-tree")!;
const buildPreviewCodeWorkbenchEl = document.getElementById("build-preview-code-workbench")!;
const toggleCodeSidebarBtn = document.getElementById("toggle-code-sidebar") as HTMLButtonElement;
const buildPreviewCodePathEl = document.getElementById("build-preview-code-path")!;
const buildPreviewCodeStatusEl = document.getElementById("build-preview-code-status")!;
const buildPreviewCodeGutterEl = document.getElementById("build-preview-code-gutter")!;
const buildPreviewCodeContentEl = document.getElementById("build-preview-code-content")!;
const buildPreviewCodeEditorEl = document.getElementById("build-preview-code-editor") as HTMLTextAreaElement;
const buildPreviewSaveStatusEl = document.getElementById("build-preview-save-status")!;
const clearPreviewActionsBtn = document.getElementById("clear-preview-actions") as HTMLButtonElement;
const copyPreviewFileBtn = document.getElementById("copy-preview-file") as HTMLButtonElement;
const buildCorrectionsEl = document.getElementById("build-corrections") as HTMLTextAreaElement;
const expandPreviewBtn = document.getElementById("expand-preview") as HTMLButtonElement;
const rebuildWithCorrectionsBtn = document.getElementById("rebuild-with-corrections") as HTMLButtonElement;
const matchSectionEl = document.getElementById("match-section")!;
const matchNameEl = document.getElementById("match-name")!;
const matchReasonEl = document.getElementById("match-reason")!;
const matchFileListEl = document.getElementById("match-file-list")!;
const matchSkeletonEl = document.getElementById("match-skeleton")!;
const previewModalEl = document.getElementById("preview-modal")!;
const previewModalBackdropEl = document.getElementById("preview-modal-backdrop")!;
const previewModalMetaEl = document.getElementById("preview-modal-meta")!;
const previewModalModePreviewBtn = document.getElementById("preview-modal-mode-preview") as HTMLButtonElement;
const previewModalModeCodeBtn = document.getElementById("preview-modal-mode-code") as HTMLButtonElement;
const previewModalPreviewPane = document.getElementById("preview-modal-preview-pane")!;
const previewModalCodePane = document.getElementById("preview-modal-code-pane")!;
const previewModalFrameEl = document.getElementById("preview-modal-frame") as HTMLIFrameElement;
const previewModalEmptyEl = document.getElementById("preview-modal-empty")!;
const previewModalActionLogEl = document.getElementById("preview-modal-action-log")!;
const previewModalFileTreeEl = document.getElementById("preview-modal-file-tree")!;
const previewModalCodeWorkbenchEl = document.getElementById("preview-modal-code-workbench")!;
const togglePreviewModalCodeSidebarBtn = document.getElementById(
  "toggle-preview-modal-code-sidebar",
) as HTMLButtonElement;
const previewModalCodePathEl = document.getElementById("preview-modal-code-path")!;
const previewModalCodeStatusEl = document.getElementById("preview-modal-code-status")!;
const previewModalCodeGutterEl = document.getElementById("preview-modal-code-gutter")!;
const previewModalCodeContentEl = document.getElementById("preview-modal-code-content")!;
const previewModalCodeEditorEl = document.getElementById("preview-modal-code-editor") as HTMLTextAreaElement;
const previewModalSaveStatusEl = document.getElementById("preview-modal-save-status")!;
const clearPreviewModalActionsBtn = document.getElementById("clear-preview-modal-actions") as HTMLButtonElement;
const copyPreviewModalFileBtn = document.getElementById("copy-preview-modal-file") as HTMLButtonElement;
const closePreviewModalBtn = document.getElementById("close-preview-modal") as HTMLButtonElement;

let currentPreviewUrl: string | null = null;
let currentPreviewJobId: string | null = null;
let selectedPreviewArgs: Record<string, unknown> = {};
let existingPreviewSessionId: string | null = null;
let correctionStreamTimer: ReturnType<typeof setInterval> | null = null;
let activeStreamJobId: string | null | "pending" = null;
let preservePreviewDuringJob = false;
let askComposerOpen = false;

const PREVIEW_ARGS_MESSAGE = "fig2code-preview-args";
const PREVIEW_READY_MESSAGE = "fig2code-preview-ready";
const PREVIEW_ACTION_MESSAGE = "fig2code-preview-action";

type PreviewFile = {
  path: string;
  action: "create" | "update" | "delete";
  content?: string;
  role?: string;
};

type BuildPreview = {
  componentName: string;
  storyFormat: "csf3" | "csf2" | "none";
  storyPath?: string;
  storyContent?: string;
  componentPath?: string;
  componentContent?: string;
  variantLabel: string;
  variants?: Record<string, string[]>;
  propControls?: PreviewPropControl[];
  files?: PreviewFile[];
};

type PreviewActionEntry = {
  name: string;
  detail: string;
  at: number;
};

type PreviewViewMode = "preview" | "code";

type CodeExplorerElements = {
  fileTree: HTMLElement;
  codePath: HTMLElement;
  codeStatus: HTMLElement;
  codeGutter: HTMLElement;
  codeBlock: HTMLElement;
  codeEditor: HTMLTextAreaElement;
  saveStatus: HTMLElement;
};

type PreviewModeElements = {
  previewBtn: HTMLButtonElement;
  codeBtn: HTMLButtonElement;
  previewPane: HTMLElement;
  codePane: HTMLElement;
};

let apiBase = "http://localhost:3000";
let capabilityModels: Array<{ modelId: string; label: string; provider: string }> = [];
let llmConfigured = false;
let editingLlm = false;
let hasValidSelection = false;
let currentSelectionId: string | null = null;
let lastValidatedSelectionId: string | null = null;
let currentBuildPreview: BuildPreview | null = null;
type ResolvedFileRole = "component" | "story" | "test" | "barrel" | "code-connect" | "related";
type ResolvedBundleSummary = {
  componentName: string;
  match: { source: string; confidence: string; reason: string };
  files: Array<{ path: string; role: ResolvedFileRole; content: string }>;
};
type ComponentWorkflowMode = "create" | "update";
let componentWorkflowMode: ComponentWorkflowMode = "create";
let currentResolvedBundle: ResolvedBundleSummary | null = null;
let resolvingMatch = false;
let previewViewMode: PreviewViewMode = "preview";
let codeSidebarExpanded = true;
let selectedPreviewFilePath: string | null = null;
let selectedPreviewFileContent = "";
const editedFiles = new Set<string>();
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let savedFadeTimer: ReturnType<typeof setTimeout> | null = null;
let previewActionLog: PreviewActionEntry[] = [];
let previewHarnessReady = false;
let previewReadyTimer: ReturnType<typeof setTimeout> | null = null;

const actionButtons = [
  loadBranchesBtn,
  connectBtn,
  rescanBtn,
  saveSetupBtn,
  saveLlmBtn,
  rebuildWithCorrectionsBtn,
  disconnectBtn,
  pushBtn,
];

for (const btn of actionButtons) {
  if (!btn.dataset.label) {
    btn.dataset.label = btn.textContent?.trim() ?? "";
  }
}

let loading = false;
let setupSaved = false;
let editingSetup = false;
let projectDetailsExpanded = false;

function isOnMainScreen() {
  return !mainScreen.classList.contains("hidden");
}

function isSetupReady() {
  return setupSaved && !editingSetup;
}

function syncBuildUiState() {
  if (!isOnMainScreen()) return;

  const builtForCurrentSelection =
    lastValidatedSelectionId !== null &&
    currentSelectionId !== null &&
    currentSelectionId === lastValidatedSelectionId;

  const hasPreview = Boolean(currentBuildPreview);
  const canBuild =
    isSetupReady() &&
    hasValidSelection &&
    !resolvingMatch &&
    (!builtForCurrentSelection || componentWorkflowMode === "update");

  buildPreviewSection.classList.toggle(
    "hidden",
    !hasPreview && !canBuild && !currentPreviewUrl,
  );
  buildPreviewCardEl.classList.toggle("hidden", !hasPreview && !currentPreviewUrl);
  previewWorkflowEl.classList.toggle("hidden", !hasPreview);
  syncAskToggleVisibility();
  if (!hasPreview && askComposerOpen) {
    setAskComposerOpen(false);
  }

  buildPreviewSection
    .querySelector(".build-preview-header")
    ?.classList.toggle("hidden", !hasPreview && !currentPreviewUrl);

  pushBtn.classList.toggle("hidden", !canBuild);
  syncPushButtonLabel();
}

function syncAskToggleVisibility() {
  const hasPreview = Boolean(currentBuildPreview);
  toggleAskBtn.hidden = !hasPreview || loading || askComposerOpen;
}

function setAskComposerOpen(open: boolean) {
  if (askComposerOpen === open) return;
  askComposerOpen = open;
  previewActionBarEl.classList.toggle("is-ask-open", open);
  syncAskToggleVisibility();
  if (open) {
    requestAnimationFrame(() => buildCorrectionsEl.focus());
  }
}

function maybeCloseAskComposer() {
  if (!askComposerOpen || buildCorrectionsEl.value.trim()) return;
  setAskComposerOpen(false);
}

function restorePushButtonMarkup() {
  pushBtn.innerHTML = `<span id="push-label">${escapeHtml(pushBtn.dataset.label ?? "Build component")}</span>`;
}

function syncPushButtonLabel() {
  const label = componentWorkflowMode === "update" ? "Update with Figma" : "Build component";
  pushBtn.dataset.label = label;
  pushBtn.classList.toggle("is-update", componentWorkflowMode === "update");
  if (!loading || !pushBtn.classList.contains("is-loading")) {
    const labelEl = pushBtn.querySelector("#push-label");
    if (labelEl) labelEl.textContent = label;
  }
  rebuildWithCorrectionsBtn.dataset.label = loading ? "…" : "Apply";
  if (!loading || !rebuildWithCorrectionsBtn.classList.contains("is-loading")) {
    rebuildWithCorrectionsBtn.textContent = rebuildWithCorrectionsBtn.dataset.label ?? "Apply";
  }
}

function setResolvingMatch(active: boolean) {
  resolvingMatch = active;
  matchSkeletonEl.classList.toggle("hidden", !active);
  if (active) {
    matchSectionEl.classList.add("hidden");
  }
  syncBuildUiState();
  syncDefaultDisabled();
}

function clearMatchState() {
  componentWorkflowMode = "create";
  currentResolvedBundle = null;
  matchSectionEl.classList.add("hidden");
  matchFileListEl.innerHTML = "";
  matchNameEl.textContent = "";
  matchReasonEl.textContent = "";
  hideBuildProgress();
  syncPushButtonLabel();
}

function showBuildProgress(componentName: string) {
  let el = document.getElementById("build-progress-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "build-progress-indicator";
    el.className = "build-progress-indicator";
    matchSectionEl.parentElement?.insertBefore(el, matchSectionEl.nextSibling);
  }
  el.innerHTML = `
    <div class="build-progress-bar"><div class="build-progress-fill"></div></div>
    <span class="build-progress-text">Building ${escapeHtml(componentName)} preview…</span>
  `;
  el.classList.remove("hidden");
}

function hideBuildProgress() {
  const el = document.getElementById("build-progress-indicator");
  if (el) el.classList.add("hidden");
}

function renderResolvedBundle(bundle: ResolvedBundleSummary) {
  matchNameEl.textContent = bundle.componentName;
  matchReasonEl.textContent = bundle.match.reason ?? "";
  matchFileListEl.innerHTML = bundle.files
    .map(
      (file) =>
        `<li><span class="file-role">${escapeHtml(file.role)}</span><span>${escapeHtml(file.path)}</span></li>`,
    )
    .join("");
  matchSectionEl.classList.remove("hidden");
}

function syncMainScreenLayout(options: { summary?: string; correctedAt?: string; connection?: ConnectionPayload } = {}) {
  if (!isOnMainScreen()) return;

  const showReady = isSetupReady();

  setupFormSection.classList.toggle("hidden", showReady);
  readySection.classList.toggle("hidden", !showReady);

  if (showReady && options.summary) {
    showSetupPreview(options.summary, options.correctedAt);
  }

  if (showReady) {
    syncLlmFormVisibility();
    syncLlmSummary();
  }

  syncBuildUiState();
}

function syncDefaultDisabled() {
  const onMain = isOnMainScreen();
  const onConnect = !connectScreen.classList.contains("hidden");
  const busy = loading;

  loadBranchesBtn.disabled = busy || !onConnect;
  connectBtn.disabled = busy || !onConnect;
  rescanBtn.disabled = busy || !onMain;
  saveSetupBtn.disabled = busy || !onMain;
  saveLlmBtn.disabled = busy || !onMain;
  disconnectBtn.disabled = busy || !onMain;
  pushBtn.disabled =
    busy ||
    !onMain ||
    !isSetupReady() ||
    !llmConfigured ||
    !hasValidSelection ||
    resolvingMatch;
  rebuildWithCorrectionsBtn.disabled =
    busy || !onMain || !isSetupReady() || !llmConfigured || !currentBuildPreview;
  toggleAskBtn.disabled = busy || !onMain || !currentBuildPreview;
  syncAskToggleVisibility();
  expandPreviewBtn.disabled = busy || !currentPreviewUrl;
}

function buildPreviewUrl(jobId: string): string {
  return `${apiBase}/jobs/${jobId}/preview`;
}

function withPreviewReloadToken(previewUrl: string, componentName?: string): string {
  try {
    const parsed = new URL(previewUrl, apiBase);
    if (componentName) {
      parsed.searchParams.set("fig2codeComponent", componentName);
    }
    parsed.searchParams.set("fig2codeReload", String(Date.now()));
    return parsed.toString();
  } catch {
    return previewUrl;
  }
}

function clearPreviewReadyTimer(): void {
  if (previewReadyTimer) {
    clearTimeout(previewReadyTimer);
    previewReadyTimer = null;
  }
}

function requestExistingPreviewForBundle(
  bundle: ResolvedBundleSummary,
  selectionId: string | null,
): void {
  if (!selectionId) return;
  const componentFile = bundle.files.find((f) => f.role === "component");
  const storyFile = bundle.files.find((f) => f.role === "story");
  if (!componentFile) return;

  parent.postMessage(
    {
      pluginMessage: {
        type: "ensure-existing-preview",
        selectionId,
        componentName: bundle.componentName,
        componentPath: componentFile.path,
        storyPath: storyFile?.path,
      },
    },
    "*",
  );
}

function syncPreviewVisualState(): void {
  const waiting = Boolean(currentBuildPreview) && !currentPreviewUrl;
  if (waiting) {
    buildPreviewFrameEl.classList.add("hidden");
    buildPreviewEmptyEl.classList.remove("hidden");
    buildPreviewEmptyEl.textContent = `Loading ${currentBuildPreview?.componentName ?? "component"} preview…`;
    return;
  }

  if (currentPreviewUrl) {
    buildPreviewEmptyEl.classList.add("hidden");
  }
}

function prepareExistingPreview(
  bundle: ResolvedBundleSummary,
  selectionId: string | null,
): void {
  const componentFile = bundle.files.find((f) => f.role === "component");
  const storyFile = bundle.files.find((f) => f.role === "story");
  const previewMetadata = componentFile?.content
    ? extractExistingPreviewMetadata(
        componentFile.content,
        storyFile?.content,
      )
    : { variants: {}, variantLabel: "Current", propControls: [] };

  const preview: BuildPreview = {
    componentName: bundle.componentName,
    storyFormat: storyFile ? "csf3" : "none",
    storyPath: storyFile?.path,
    storyContent: storyFile?.content,
    componentPath: componentFile?.path,
    componentContent: componentFile?.content,
    variantLabel: previewMetadata.variantLabel,
    variants: previewMetadata.variants,
    propControls: previewMetadata.propControls,
    files: bundle.files.map((f) => ({
      path: f.path,
      action: "update" as const,
      content: f.content,
      role: f.role,
    })),
  };

  editedFiles.clear();
  currentBuildPreview = preview;
  currentPreviewJobId = null;
  currentPreviewUrl = null;
  selectedPreviewFilePath = null;
  selectedPreviewFileContent = "";
  clearPreviewActionLogs();
  refreshCodeExplorers();
  renderPreviewControls(preview);

  buildPreviewSection.classList.remove("hidden");
  buildPreviewCardEl.classList.remove("hidden");
  previewWorkflowEl.classList.remove("hidden");
  syncPreviewVisualState();
  requestExistingPreviewForBundle(bundle, selectionId);
}

function reloadPreviewFrame(frame: HTMLIFrameElement, url: string): void {
  frame.onload = () => {
    postPreviewArgsToFrame(frame);
  };
  frame.src = url;
}

function revealExistingPreview(sessionId: string, proxyUrl: string): void {
  clearPreviewReadyTimer();
  previewHarnessReady = false;
  existingPreviewSessionId = sessionId;
  currentPreviewJobId = sessionId;
  const reloadUrl = withPreviewReloadToken(
    proxyUrl,
    currentBuildPreview?.componentName,
  );
  currentPreviewUrl = reloadUrl;

  if (currentBuildPreview) {
    renderPreviewControls(currentBuildPreview);
  }
  buildPreviewFormatEl.textContent = "Existing component";

  reloadPreviewFrame(buildPreviewFrameEl, reloadUrl);
  buildPreviewFrameEl.classList.remove("hidden");
  buildPreviewEmptyEl.classList.add("hidden");

  previewReadyTimer = setTimeout(() => {
    if (previewHarnessReady) return;
    buildPreviewFrameEl.classList.add("hidden");
    buildPreviewEmptyEl.classList.remove("hidden");
    buildPreviewEmptyEl.textContent =
      `Preview did not load for ${currentBuildPreview?.componentName ?? "component"}. ` +
      "Check that the API is running, then select the component again.";
  }, 15000);

  setPreviewViewMode("preview");
  buildPreviewSection.classList.remove("hidden");
  buildPreviewCardEl.classList.remove("hidden");
  previewWorkflowEl.classList.remove("hidden");
  syncBuildUiState();
  syncDefaultDisabled();
}

function previewMessageOrigin(): string {
  try {
    return new URL(apiBase).origin;
  } catch {
    return "*";
  }
}

function getPreviewFiles(preview: BuildPreview): PreviewFile[] {
  if (preview.files?.length) {
    return [...preview.files].sort((left, right) => left.path.localeCompare(right.path));
  }

  const files: PreviewFile[] = [];
  if (preview.componentPath && preview.componentContent) {
    files.push({
      path: preview.componentPath,
      action: "create",
      content: preview.componentContent,
    });
  }
  if (preview.storyPath && preview.storyContent) {
    files.push({
      path: preview.storyPath,
      action: "create",
      content: preview.storyContent,
    });
  }
  return files;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function fileActionBadge(file: PreviewFile): string {
  if (file.role) {
    switch (file.role) {
      case "component": return "TSX";
      case "story": return "Story";
      case "test": return "Test";
      case "barrel": return "Idx";
      case "code-connect": return "CC";
      case "related": return "Rel";
      default: return file.role.slice(0, 3).toUpperCase();
    }
  }
  switch (file.action) {
    case "create": return "C";
    case "update": return "U";
    case "delete": return "D";
  }
}

function defaultPreviewFilePath(preview: BuildPreview, files: PreviewFile[]): string | null {
  const componentByRole = files.find((f) => f.role === "component");
  if (componentByRole) return componentByRole.path;
  if (preview.componentPath && files.some((file) => file.path === preview.componentPath)) {
    return preview.componentPath;
  }
  if (preview.storyPath && files.some((file) => file.path === preview.storyPath)) {
    return preview.storyPath;
  }
  return files[0]?.path ?? null;
}

function describeSelectedFileStatus(file: PreviewFile, preview: BuildPreview): string {
  if (file.role) {
    switch (file.role) {
      case "component": return "Component";
      case "story": return "Story";
      case "test": return "Test";
      case "barrel": return "Index / barrel";
      case "code-connect": return "Code Connect";
      case "related": return "Related module";
      default: return file.role;
    }
  }

  const isComponentFile =
    file.path === preview.componentPath ||
    basename(file.path).replace(/\.(tsx|jsx)$/, "") === preview.componentName;

  if (isComponentFile) {
    if (file.action === "update") return "Existing component";
    if (file.action === "create") return "New component";
    if (file.action === "delete") return "Removing component";
  }

  if (file.action === "create") return "New file";
  if (file.action === "update") return "Existing file";
  return "Deleted file";
}

function statusClassForFile(file: PreviewFile, preview: BuildPreview): string {
  if (file.role) return "existing";
  const label = describeSelectedFileStatus(file, preview);
  if (label.startsWith("Existing")) return "existing";
  if (label.startsWith("New")) return "new";
  return "";
}

function renderPreviewActionLogs() {
  const markup =
    previewActionLog.length === 0
      ? '<li class="build-preview-action-empty">Interact with the component to log events.</li>'
      : previewActionLog
          .map(
            (entry) =>
              `<li><code>${escapeHtml(entry.name)}</code>${
                entry.detail ? ` (${escapeHtml(entry.detail)})` : ""
              }</li>`,
          )
          .join("");

  buildPreviewActionLogEl.innerHTML = markup;
  previewModalActionLogEl.innerHTML = markup;

  if (previewActionsCountEl) {
    previewActionsCountEl.textContent =
      previewActionLog.length > 0 ? String(previewActionLog.length) : "";
  }
}

function clearPreviewActionLogs() {
  previewActionLog = [];
  renderPreviewActionLogs();
}

function appendPreviewAction(entry: PreviewActionEntry) {
  previewActionLog.unshift(entry);
  if (previewActionLog.length > 20) {
    previewActionLog = previewActionLog.slice(0, 20);
  }
  renderPreviewActionLogs();
  if (previewActionsDetailsEl && previewActionLog.length > 0) {
    previewActionsDetailsEl.open = true;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setPreviewViewMode(mode: PreviewViewMode) {
  previewViewMode = mode;

  for (const controls of [inlinePreviewModeControls, modalPreviewModeControls]) {
    const isPreview = mode === "preview";
    controls.previewBtn.classList.toggle("active", isPreview);
    controls.codeBtn.classList.toggle("active", !isPreview);
    controls.previewBtn.setAttribute("aria-selected", String(isPreview));
    controls.codeBtn.setAttribute("aria-selected", String(!isPreview));
    controls.previewPane.classList.toggle("hidden", !isPreview);
    controls.codePane.classList.toggle("hidden", isPreview);
  }
}

function syncCodeSidebarExpanded() {
  const label = codeSidebarExpanded ? "Hide files" : "Show files";
  const icon = codeSidebarExpanded ? PREVIEW_ICON_CHEVRON_LEFT : PREVIEW_ICON_CHEVRON_RIGHT;

  for (const workbench of [buildPreviewCodeWorkbenchEl, previewModalCodeWorkbenchEl]) {
    workbench.classList.toggle("is-sidebar-collapsed", !codeSidebarExpanded);
  }

  for (const button of [toggleCodeSidebarBtn, togglePreviewModalCodeSidebarBtn]) {
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", String(codeSidebarExpanded));
    mountPreviewIcon(button, icon);
  }
}

function toggleCodeSidebar() {
  codeSidebarExpanded = !codeSidebarExpanded;
  syncCodeSidebarExpanded();
}

function renderCodeExplorer(explorer: CodeExplorerElements, preview: BuildPreview) {
  const files = getPreviewFiles(preview);
  explorer.fileTree.innerHTML = "";

  if (files.length === 0) {
    explorer.codePath.textContent = "No files generated";
    explorer.codeStatus.textContent = "";
    explorer.codeStatus.className = "code-status";
    explorer.codeGutter.textContent = "";
    explorer.codeBlock.textContent = "No generated files to display.";
    explorer.codeEditor.value = "";
    explorer.codeEditor.disabled = true;
    selectedPreviewFilePath = null;
    selectedPreviewFileContent = "";
    return;
  }

  if (!selectedPreviewFilePath || !files.some((file) => file.path === selectedPreviewFilePath)) {
    selectedPreviewFilePath = defaultPreviewFilePath(preview, files);
  }

  for (const file of files) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = file.path === selectedPreviewFilePath ? "active" : "";
    button.title = `${file.path} (${file.action})`;
    button.dataset.filePath = file.path;
    const dotHtml = editedFiles.has(file.path) ? '<span class="file-edited-dot"></span>' : '';
    const badgeClass = file.role ?? file.action;
    button.innerHTML = `<span class="file-badge-wrapper"><span class="file-badge ${badgeClass}">${fileActionBadge(file)}</span>${dotHtml}</span><span class="file-name">${escapeHtml(basename(file.path))}</span>`;
    button.onclick = () => {
      flushCurrentEdit();
      selectedPreviewFilePath = file.path;
      refreshCodeExplorers();
    };
    item.appendChild(button);
    explorer.fileTree.appendChild(item);
  }

  const selected = files.find((file) => file.path === selectedPreviewFilePath) ?? files[0]!;
  selectedPreviewFilePath = selected.path;
  explorer.codePath.textContent = selected.path;
  explorer.codeStatus.textContent = describeSelectedFileStatus(selected, preview);
  explorer.codeStatus.className = `code-status ${statusClassForFile(selected, preview)}`.trim();

  if (selected.action === "delete") {
    selectedPreviewFileContent = "";
    explorer.codeGutter.textContent = "1";
    explorer.codeBlock.textContent = "This file would be deleted from the repository.";
    explorer.codeEditor.value = "";
    explorer.codeEditor.disabled = true;
    return;
  }

  selectedPreviewFileContent = selected.content ?? "";
  const lines = selectedPreviewFileContent.split("\n");
  explorer.codeGutter.textContent = renderLineNumbers(Math.max(lines.length, 1));
  explorer.codeBlock.innerHTML = highlightTs(selectedPreviewFileContent) || '<span class="tok-plain">&nbsp;</span>';
  explorer.codeEditor.value = selectedPreviewFileContent;
  explorer.codeEditor.disabled = false;
}

function refreshCodeExplorers() {
  if (!currentBuildPreview) return;
  renderCodeExplorer(inlineCodeExplorer, currentBuildPreview);
  renderCodeExplorer(modalCodeExplorer, currentBuildPreview);
}

const inlinePreviewModeControls: PreviewModeElements = {
  previewBtn: buildPreviewModePreviewBtn,
  codeBtn: buildPreviewModeCodeBtn,
  previewPane: buildPreviewPreviewPane,
  codePane: buildPreviewCodePane,
};

const modalPreviewModeControls: PreviewModeElements = {
  previewBtn: previewModalModePreviewBtn,
  codeBtn: previewModalModeCodeBtn,
  previewPane: previewModalPreviewPane,
  codePane: previewModalCodePane,
};

const inlineCodeExplorer: CodeExplorerElements = {
  fileTree: buildPreviewFileTreeEl,
  codePath: buildPreviewCodePathEl,
  codeStatus: buildPreviewCodeStatusEl,
  codeGutter: buildPreviewCodeGutterEl,
  codeBlock: buildPreviewCodeContentEl,
  codeEditor: buildPreviewCodeEditorEl,
  saveStatus: buildPreviewSaveStatusEl,
};

const modalCodeExplorer: CodeExplorerElements = {
  fileTree: previewModalFileTreeEl,
  codePath: previewModalCodePathEl,
  codeStatus: previewModalCodeStatusEl,
  codeGutter: previewModalCodeGutterEl,
  codeBlock: previewModalCodeContentEl,
  codeEditor: previewModalCodeEditorEl,
  saveStatus: previewModalSaveStatusEl,
};

function copySelectedPreviewFile() {
  if (!selectedPreviewFileContent.trim()) return;
  void navigator.clipboard.writeText(selectedPreviewFileContent);
  statusEl.textContent = "Copied file contents.";
}

function setSaveStatus(state: "saving" | "saved" | "") {
  if (savedFadeTimer) {
    clearTimeout(savedFadeTimer);
    savedFadeTimer = null;
  }

  for (const explorer of [inlineCodeExplorer, modalCodeExplorer]) {
    const el = explorer.saveStatus;
    el.className = "save-status";

    if (state === "saving") {
      el.textContent = "Saving…";
      el.classList.add("is-saving");
    } else if (state === "saved") {
      el.textContent = "Saved";
      el.classList.add("is-saved");
    } else {
      el.textContent = "";
      return;
    }
  }

  if (state === "saved") {
    savedFadeTimer = setTimeout(() => {
      for (const explorer of [inlineCodeExplorer, modalCodeExplorer]) {
        explorer.saveStatus.classList.add("is-fading");
      }
      savedFadeTimer = setTimeout(() => {
        setSaveStatus("");
      }, 350);
    }, 1500);
  }
}

function flushCurrentEdit() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (!currentBuildPreview || !selectedPreviewFilePath) return;
  const content = inlineCodeExplorer.codeEditor.value;
  if (content !== selectedPreviewFileContent) {
    applyEditToPreview(selectedPreviewFilePath, content);
    selectedPreviewFileContent = content;
    editedFiles.delete(selectedPreviewFilePath);
    refreshEditedBadges();
    setSaveStatus("saved");
    hotReloadPreview();
  }
}

function applyEditToPreview(filePath: string, content: string) {
  if (!currentBuildPreview) return;
  if (currentBuildPreview.files) {
    const file = currentBuildPreview.files.find((f) => f.path === filePath);
    if (file) {
      file.content = content;
    }
  }
  if (currentBuildPreview.componentPath === filePath) {
    currentBuildPreview.componentContent = content;
  }
  if (currentBuildPreview.storyPath === filePath) {
    currentBuildPreview.storyContent = content;
  }
}

function getComponentSourceForPreview(): string {
  if (!currentBuildPreview) return "";
  const componentPath = currentBuildPreview.componentPath;
  if (currentBuildPreview.files?.length) {
    if (componentPath) {
      const byPath = currentBuildPreview.files.find((entry) => entry.path === componentPath);
      if (byPath?.content) return byPath.content;
    }
    const componentName = currentBuildPreview.componentName;
    const byName = currentBuildPreview.files.find(
      (entry) => basename(entry.path).replace(/\.(tsx|jsx)$/, "") === componentName,
    );
    if (byName?.content) return byName.content;
  }
  return currentBuildPreview.componentContent ?? "";
}

function shouldHotReloadPreview(filePath: string | null): boolean {
  if (!currentBuildPreview || !filePath) return false;
  if (filePath === currentBuildPreview.componentPath) return true;
  const componentName = currentBuildPreview.componentName;
  return basename(filePath).replace(/\.(tsx|jsx)$/, "") === componentName;
}

function hotReloadPreview() {
  if (!currentBuildPreview) return;
  if (!shouldHotReloadPreview(selectedPreviewFilePath)) return;
  if (!currentPreviewJobId) return;
  const raw = getComponentSourceForPreview();
  if (!raw.trim()) return;

  const filePath = selectedPreviewFilePath ?? currentBuildPreview.componentPath ?? "";
  if (!filePath) return;

  fetch(`${apiBase}/jobs/${currentPreviewJobId}/preview/files`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, content: raw }),
  }).catch(() => {});
}

function handleCodeEditorInput(source: CodeExplorerElements) {
  const content = source.codeEditor.value;
  const lines = content.split("\n");

  for (const explorer of [inlineCodeExplorer, modalCodeExplorer]) {
    explorer.codeGutter.textContent = renderLineNumbers(Math.max(lines.length, 1));
    explorer.codeBlock.innerHTML =
      highlightTs(content) || '<span class="tok-plain">&nbsp;</span>';
    if (explorer !== source) {
      explorer.codeEditor.value = content;
    }
  }

  if (content !== selectedPreviewFileContent) {
    editedFiles.add(selectedPreviewFilePath ?? "");
    refreshEditedBadges();
    setSaveStatus("saving");
  }

  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    if (!currentBuildPreview || !selectedPreviewFilePath) return;
    applyEditToPreview(selectedPreviewFilePath, content);
    selectedPreviewFileContent = content;
    editedFiles.delete(selectedPreviewFilePath);
    refreshEditedBadges();
    setSaveStatus("saved");
    hotReloadPreview();
  }, 800);
}

function refreshEditedBadges() {
  for (const explorer of [inlineCodeExplorer, modalCodeExplorer]) {
    const buttons = explorer.fileTree.querySelectorAll<HTMLButtonElement>(
      "button[data-file-path]",
    );
    buttons.forEach((btn) => {
      const filePath = btn.dataset.filePath ?? "";
      const wrapper = btn.querySelector(".file-badge-wrapper");
      if (!wrapper) return;
      const existing = wrapper.querySelector(".file-edited-dot");
      if (editedFiles.has(filePath)) {
        if (!existing) {
          const dot = document.createElement("span");
          dot.className = "file-edited-dot";
          wrapper.appendChild(dot);
        }
      } else if (existing) {
        existing.remove();
      }
    });
  }
}

function setupCodeEditorEvents(explorer: CodeExplorerElements) {
  explorer.codeEditor.addEventListener("input", () => {
    handleCodeEditorInput(explorer);
  });

  explorer.codeEditor.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      flushCurrentEdit();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const ta = explorer.codeEditor;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (e.shiftKey) {
        const before = ta.value.slice(0, start);
        const lineStart = before.lastIndexOf("\n") + 1;
        if (ta.value.slice(lineStart, lineStart + 2) === "  ") {
          ta.value =
            ta.value.slice(0, lineStart) + ta.value.slice(lineStart + 2);
          ta.selectionStart = Math.max(start - 2, lineStart);
          ta.selectionEnd = Math.max(end - 2, lineStart);
        }
      } else {
        ta.value =
          ta.value.slice(0, start) + "  " + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + 2;
      }
      ta.dispatchEvent(new Event("input"));
    }
  });
}

function previewFrameTargetOrigin(frame: HTMLIFrameElement): string {
  try {
    const src = frame.src || frame.getAttribute("src") || "";
    if (src && src !== "about:blank") {
      return new URL(src, window.location.href).origin;
    }
  } catch {
    /* fall through */
  }
  return previewMessageOrigin();
}

function postPreviewArgsToFrame(frame: HTMLIFrameElement) {
  const target = frame.contentWindow;
  if (!target) return;

  const src = frame.src;
  if (!src || src === "about:blank") return;

  target.postMessage(
    {
      type: PREVIEW_ARGS_MESSAGE,
      args: selectedPreviewArgs,
    },
    previewFrameTargetOrigin(frame),
  );
}

function formatVariantAxisLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function formatSelectedVariantLabel(preview: BuildPreview): string {
  const axes = preview.variants ?? {};
  if (Object.keys(axes).length === 0) {
    return preview.variantLabel;
  }
  return Object.keys(axes)
    .map((key) => {
      const value = selectedPreviewArgs[key];
      const fallback = axes[key]?.[0] ?? "?";
      return `${key}=${typeof value === "string" ? value : fallback}`;
    })
    .join(", ");
}

function appendPreviewSelectControl(
  container: HTMLElement,
  name: string,
  options: string[],
  value: string,
  onChange: (next: string) => void,
) {
  const field = document.createElement("label");
  field.className = "build-preview-variant-field";

  const label = document.createElement("span");
  label.textContent = formatVariantAxisLabel(name);

  const select = document.createElement("select");
  select.dataset.previewArgKey = name;
  for (const optionValue of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionValue;
    select.appendChild(option);
  }
  select.value = value;
  select.onchange = () => onChange(select.value);

  field.append(label, select);
  container.appendChild(field);
}

function appendPreviewBooleanControl(
  container: HTMLElement,
  name: string,
) {
  const field = document.createElement("label");
  field.className = "build-preview-variant-field build-preview-boolean-field";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(selectedPreviewArgs[name]);
  input.onchange = () => {
    selectedPreviewArgs[name] = input.checked;
    refreshPreviewFrames();
  };

  const label = document.createElement("span");
  label.textContent = formatVariantAxisLabel(name);

  field.append(input, label);
  container.appendChild(field);
}

function appendPreviewInputControl(
  container: HTMLElement,
  name: string,
  controlType: "text" | "number",
) {
  const field = document.createElement("label");
  field.className = "build-preview-variant-field";

  const label = document.createElement("span");
  label.textContent = formatVariantAxisLabel(name);

  const input = document.createElement("input");
  input.type = controlType;
  input.dataset.previewArgKey = name;
  input.value = String(selectedPreviewArgs[name] ?? "");
  const syncInputArg = () => {
    if (controlType === "number") {
      const parsed = Number(input.value);
      selectedPreviewArgs[name] = Number.isFinite(parsed) ? parsed : input.value;
    } else {
      selectedPreviewArgs[name] = input.value;
    }
    refreshPreviewFrames();
  };
  input.oninput = syncInputArg;
  input.onchange = syncInputArg;

  field.append(label, input);
  container.appendChild(field);
}

function renderPreviewControls(preview: BuildPreview) {
  buildPreviewSelectControlsEl.innerHTML = "";
  buildPreviewInputControlsEl.innerHTML = "";
  buildPreviewBooleanControlsEl.innerHTML = "";
  selectedPreviewArgs = {};

  const axes = preview.variants ?? {};
  const propControls = preview.propControls ?? [];
  const hasAnyControls = Object.keys(axes).length > 0 || propControls.length > 0;

  buildPreviewControlsEl.classList.toggle("hidden", !hasAnyControls);
  buildPreviewVariantEl.classList.toggle("hidden", hasAnyControls);
  if (!hasAnyControls) {
    buildPreviewVariantEl.textContent = preview.variantLabel;
    previewSelectGroupEl.classList.add("hidden");
    previewInputGroupEl.classList.add("hidden");
    previewBooleanGroupEl.classList.add("hidden");
    return;
  }

  selectedPreviewArgs = resolveInitialPreviewArgs(
    axes,
    propControls,
    preview.componentContent,
    preview.storyContent,
  );

  let selectCount = 0;
  let inputCount = 0;
  let booleanCount = 0;

  for (const [key, values] of Object.entries(axes)) {
    const initialValue = String(selectedPreviewArgs[key] ?? values[0] ?? "");
    selectedPreviewArgs[key] = initialValue;
    appendPreviewSelectControl(
      buildPreviewSelectControlsEl,
      key,
      values,
      initialValue,
      (next) => {
        selectedPreviewArgs[key] = next;
        refreshPreviewFrames();
      },
    );
    selectCount++;
  }

  for (const control of propControls) {
    if (control.control === "boolean") {
      appendPreviewBooleanControl(buildPreviewBooleanControlsEl, control.name);
      booleanCount++;
    } else if (control.control === "select" && control.options?.length) {
      appendPreviewSelectControl(
        buildPreviewSelectControlsEl,
        control.name,
        control.options,
        String(selectedPreviewArgs[control.name] ?? control.options[0] ?? ""),
        (next) => {
          selectedPreviewArgs[control.name] = next;
          refreshPreviewFrames();
        },
      );
      selectCount++;
    } else {
      appendPreviewInputControl(
        buildPreviewInputControlsEl,
        control.name,
        control.control === "number" ? "number" : "text",
      );
      inputCount++;
    }
  }

  previewSelectGroupEl.classList.toggle("hidden", selectCount === 0);
  previewInputGroupEl.classList.toggle("hidden", inputCount === 0);
  previewBooleanGroupEl.classList.toggle("hidden", booleanCount === 0);

  if (currentPreviewUrl) {
    postPreviewArgsToFrame(buildPreviewFrameEl);
    postPreviewArgsToFrame(previewModalFrameEl);
  }
}

function refreshPreviewFrames() {
  if (!currentPreviewUrl) return;

  postPreviewArgsToFrame(buildPreviewFrameEl);
  postPreviewArgsToFrame(previewModalFrameEl);

  if (!previewModalEl.classList.contains("hidden") && currentBuildPreview) {
    renderBuildPreviewMeta(previewModalMetaEl, currentBuildPreview);
  }

  syncDefaultDisabled();
}

function setPreviewFrame(frame: HTMLIFrameElement, emptyEl: HTMLElement, previewUrl: string | null) {
  if (previewUrl) {
    const needsReload = frame.getAttribute("src") !== previewUrl;
    frame.onload = () => {
      postPreviewArgsToFrame(frame);
    };

    frame.classList.remove("hidden");
    emptyEl.classList.add("hidden");

    if (needsReload) {
      frame.src = previewUrl;
      return;
    }

    postPreviewArgsToFrame(frame);
    return;
  }

  frame.removeAttribute("src");
  frame.onload = null;
  frame.classList.add("hidden");
  emptyEl.classList.remove("hidden");
  emptyEl.textContent = "Preview will appear after a successful build.";
}
function storyFormatLabel(format: BuildPreview["storyFormat"]): string {
  switch (format) {
    case "csf3":
      return "Storybook CSF3";
    case "csf2":
      return "Storybook CSF2";
    default:
      return "Component only";
  }
}

function renderBuildPreviewMeta(container: HTMLElement, preview: BuildPreview) {
  const variantLabel = formatSelectedVariantLabel(preview);

  container.innerHTML = `
    <div class="build-preview-meta">
      <span class="build-preview-tag">${storyFormatLabel(preview.storyFormat)}</span>
      <span class="build-preview-tag">${variantLabel}</span>
    </div>
  `;
}

function clearValidatedBuildState() {
  lastValidatedSelectionId = null;
  hideBuildPreview();
  buildCorrectionsEl.value = "";
  syncBuildUiState();
}

function resetPreviewForSelectionChange() {
  hideBuildProgress();
  clearPreviewReadyTimer();
  previewHarnessReady = false;
  currentPreviewUrl = null;
  currentPreviewJobId = null;
  currentBuildPreview = null;
  selectedPreviewArgs = {};
  selectedPreviewFilePath = null;
  selectedPreviewFileContent = "";
  previewActionLog = [];
  buildPreviewSelectControlsEl.innerHTML = "";
  buildPreviewInputControlsEl.innerHTML = "";
  buildPreviewBooleanControlsEl.innerHTML = "";
  buildPreviewControlsEl.classList.add("hidden");
  previewSelectGroupEl.classList.add("hidden");
  previewInputGroupEl.classList.add("hidden");
  previewBooleanGroupEl.classList.add("hidden");
  buildPreviewVariantEl.classList.remove("hidden");
  setPreviewFrame(buildPreviewFrameEl, buildPreviewEmptyEl, null);
  buildPreviewSection.classList.add("hidden");
  previewWorkflowEl.classList.add("hidden");
  closePreviewModal();
  syncPreviewVisualState();
  syncBuildUiState();
  syncDefaultDisabled();
}

function showBuildPreview(preview: BuildPreview, jobId: string) {
  // Clean up existing component preview if we're now showing a codegen result
  if (existingPreviewSessionId) {
    fetch(`${apiBase}/preview/existing/${existingPreviewSessionId}`, {
      method: "DELETE",
    }).catch(() => {});
    existingPreviewSessionId = null;
  }
  editedFiles.clear();
  currentBuildPreview = preview;
  currentPreviewJobId = jobId;
  selectedPreviewFilePath = null;
  selectedPreviewFileContent = "";
  clearPreviewActionLogs();
  renderPreviewControls(preview);
  currentPreviewUrl = buildPreviewUrl(jobId);
  buildPreviewFormatEl.textContent = storyFormatLabel(preview.storyFormat);
  setPreviewFrame(buildPreviewFrameEl, buildPreviewEmptyEl, currentPreviewUrl);
  setPreviewViewMode("preview");
  refreshCodeExplorers();
  buildPreviewSection.classList.remove("hidden");
  syncBuildUiState();
  syncDefaultDisabled();
}

function hideBuildPreview(resetWorkflow = true) {
  if (resetWorkflow && existingPreviewSessionId) {
    fetch(`${apiBase}/preview/existing/${existingPreviewSessionId}`, {
      method: "DELETE",
    }).catch(() => {});
    existingPreviewSessionId = null;
  }
  hideBuildProgress();

  editedFiles.clear();
  currentBuildPreview = null;
  currentPreviewJobId = null;
  selectedPreviewArgs = {};
  selectedPreviewFilePath = null;
  selectedPreviewFileContent = "";
  currentPreviewUrl = null;
  previewActionLog = [];
  buildPreviewSelectControlsEl.innerHTML = "";
  buildPreviewInputControlsEl.innerHTML = "";
  buildPreviewBooleanControlsEl.innerHTML = "";
  buildPreviewControlsEl.classList.add("hidden");
  previewSelectGroupEl.classList.add("hidden");
  previewInputGroupEl.classList.add("hidden");
  previewBooleanGroupEl.classList.add("hidden");
  buildPreviewVariantEl.classList.remove("hidden");
  setPreviewFrame(buildPreviewFrameEl, buildPreviewEmptyEl, null);
  if (resetWorkflow) {
    buildPreviewSection.classList.add("hidden");
    previewWorkflowEl.classList.add("hidden");
    setAskComposerOpen(false);
    clearCorrectionStream();
  }
  setPreviewViewMode("preview");
  closePreviewModal();
  syncBuildUiState();
  syncDefaultDisabled();
}

function openPreviewModal() {
  if (!currentBuildPreview || !currentPreviewUrl) return;

  renderBuildPreviewMeta(previewModalMetaEl, currentBuildPreview);
  setPreviewFrame(previewModalFrameEl, previewModalEmptyEl, currentPreviewUrl);
  setPreviewViewMode(previewViewMode);
  refreshCodeExplorers();
  renderPreviewActionLogs();
  previewModalEl.classList.remove("hidden");
  previewModalEl.setAttribute("aria-hidden", "false");
  parent.postMessage({ pluginMessage: { type: "resize-ui", width: 420, height: 760 } }, "*");
}

function closePreviewModal() {
  if (previewModalEl.classList.contains("hidden")) {
    return;
  }
  previewModalEl.classList.add("hidden");
  previewModalEl.setAttribute("aria-hidden", "true");
  parent.postMessage({ pluginMessage: { type: "resize-ui", width: 380, height: 720 } }, "*");
}

function shouldPreservePreviewForBuild(options?: { preservePreview?: boolean }): boolean {
  if (options?.preservePreview) return true;
  return Boolean(
    currentBuildPreview &&
      (currentPreviewUrl || existingPreviewSessionId),
  );
}

function startBuild(
  corrections?: string,
  triggerBtn: HTMLButtonElement = pushBtn,
  options?: { preservePreview?: boolean; isCorrection?: boolean },
) {
  if (!llmConfigured) {
    statusEl.textContent = "Save LLM settings before pushing.";
    editingLlm = true;
    syncLlmFormVisibility();
    return;
  }
  if (!hasValidSelection) {
    statusEl.textContent = "Select a component, component set, or instance in Figma.";
    return;
  }

  const preservePreview = shouldPreservePreviewForBuild(options);
  preservePreviewDuringJob = preservePreview;

  if (!options?.isCorrection) {
    setAskComposerOpen(false);
  }

  if (!preservePreview) {
    hideBuildPreview();
  } else {
    flushCurrentEdit();
    setPreviewBusy(true);
    const streamPrompt = corrections?.trim()
      ? corrections.trim()
      : componentWorkflowMode === "update"
        ? "Update with Figma"
        : "Rebuild";
    startJobActivityStream(streamPrompt);
    activeStreamJobId = "pending";
  }

  beginLoading(triggerBtn);
  parent.postMessage(
    {
      pluginMessage: {
        type: "push-selection",
        apiBase,
        modelId: pushModelEl.value,
        provider: providerFromModelId(pushModelEl.value),
        corrections: corrections?.trim() ?? "",
        ...(preservePreview ? { previewFileOverrides: collectPreviewFileOverrides() } : {}),
      },
    },
    "*",
  );
}

function collectPreviewFileOverrides(): Array<{ path: string; role: string; content: string }> {
  if (!currentBuildPreview) return [];
  flushCurrentEdit();
  const files = getPreviewFiles(currentBuildPreview).filter((file) => file.content?.trim());
  return files.map((file) => ({
    path: file.path,
    role: file.role ?? inferPreviewFileRole(file, currentBuildPreview!),
    content: file.content ?? "",
  }));
}

function inferPreviewFileRole(file: PreviewFile, preview: BuildPreview): string {
  if (file.role) return file.role;
  if (file.path === preview.storyPath || /\.stories\.(tsx|jsx|ts|js)$/i.test(file.path)) {
    return "story";
  }
  if (file.path === preview.componentPath) return "component";
  return "related";
}

function clearCorrectionStream() {
  if (correctionStreamTimer) {
    clearInterval(correctionStreamTimer);
    correctionStreamTimer = null;
  }
  activeStreamJobId = null;
  preservePreviewDuringJob = false;
  correctionStreamEl.innerHTML = "";
  setPreviewBusy(false);
}

function setPreviewBusy(busy: boolean) {
  buildPreviewVisualEl?.classList.toggle("is-busy", busy);
}

function startJobActivityStream(prompt: string) {
  if (correctionStreamTimer) {
    clearInterval(correctionStreamTimer);
    correctionStreamTimer = null;
  }
  correctionStreamEl.innerHTML = "";
  preservePreviewDuringJob = true;
  previewWorkflowEl.classList.remove("hidden");

  const line = document.createElement("p");
  line.className = "correction-stream-line is-active";
  line.textContent = prompt.startsWith("Update") ? prompt : `You: ${prompt}`;
  correctionStreamEl.appendChild(line);

  const status = document.createElement("p");
  status.className = "correction-stream-line is-active";
  status.dataset.streamStatus = "true";
  status.innerHTML = 'Reading code<span class="correction-stream-cursor"></span>';
  correctionStreamEl.appendChild(status);
  correctionStreamEl.scrollTop = correctionStreamEl.scrollHeight;
  setPreviewBusy(true);
  syncCorrectionStreamFade();

  const phases = [
    "Reading code",
    "Planning edit",
    "Updating component",
    "Validating output",
  ];
  let phaseIndex = 0;
  correctionStreamTimer = setInterval(() => {
    phaseIndex = (phaseIndex + 1) % phases.length;
    status.innerHTML = `${phases[phaseIndex]}<span class="correction-stream-cursor"></span>`;
  }, 2200);
}

function formatSummaryAsListItems(summary: string): string[] {
  const text = summary.trim();
  if (!text) return [];

  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const bulletLines = lines.map((line) =>
      line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim(),
    );
    if (bulletLines.every(Boolean)) {
      return bulletLines;
    }
  }

  const verbSplit = text
    .split(
      /\s+(?=(?:Added|Updated|Removed|Fixed|Changed|Renamed|Introduced|Replaced|Set|Moved|Adjusted|Counter|All|Deprecated|Aligned|Kept|Extended|Refactored|Normalized|Simplified)\b)/i,
    )
    .map((part) => part.trim())
    .filter(Boolean);
  if (verbSplit.length > 1) {
    return verbSplit;
  }

  if (text.includes(";")) {
    const parts = text
      .split(/;\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      return parts.map((part) =>
        /[.!?]$/.test(part) ? part : `${part.replace(/[.,]$/, "")}.`,
      );
    }
  }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length > 1) {
    return sentences;
  }

  return [text];
}

type ChangeListItem = {
  text: string;
  breaking: boolean;
  fix?: string;
};

type CodegenChangeSummary = {
  hasBreakingChanges: boolean;
  changes: ChangeListItem[];
};

function parseChangeListItems(
  summary: string,
  changeSummary?: CodegenChangeSummary | null,
): ChangeListItem[] {
  if (changeSummary?.changes?.length) {
    return changeSummary.changes
      .filter((item) => item.text.trim())
      .map((item) => {
        const breaking = item.breaking || inferBreakingFromText(item.text);
        return {
          text: item.text,
          breaking,
          fix: breaking ? item.fix?.trim() || inferFixFromText(item.text) : undefined,
        };
      });
  }

  return formatSummaryAsListItems(summary).map((line) => {
    const breaking = /^\[breaking\]\s*/i.test(line);
    const nonBreaking = /^\[(non-breaking|nonbreaking)\]\s*/i.test(line);
    const text = line
      .replace(/^\[breaking\]\s*/i, "")
      .replace(/^\[(non-breaking|nonbreaking)\]\s*/i, "")
      .trim();
    const explicitBreaking = breaking && !nonBreaking;
    const isBreaking = explicitBreaking || inferBreakingFromText(text);
    return {
      text,
      breaking: isBreaking,
      fix: isBreaking ? inferFixFromText(text) : undefined,
    };
  });
}

function syncCorrectionStreamFade() {
  const shell = correctionStreamShellEl;
  const stream = correctionStreamEl;
  if (!shell || !stream) return;

  const hasOverflow = stream.scrollHeight > stream.clientHeight + 2;
  const notAtBottom = stream.scrollTop + stream.clientHeight < stream.scrollHeight - 2;
  shell.classList.toggle("is-scrollable", hasOverflow && notAtBottom);
}

function appendBreakingChangeItem(list: HTMLElement, entry: ChangeListItem) {
  const item = document.createElement("li");
  item.className = "correction-summary-item is-breaking";

  const issue = document.createElement("span");
  issue.className = "correction-summary-issue";
  issue.textContent = entry.text;
  item.appendChild(issue);

  if (entry.fix) {
    const fix = document.createElement("span");
    fix.className = "correction-summary-fix";
    const label = document.createElement("span");
    label.className = "correction-summary-fix-label";
    label.textContent = "Fix: ";
    fix.append(label, document.createTextNode(entry.fix));
    item.appendChild(fix);
  }

  list.appendChild(item);
  return item;
}

function finishJobActivityStream(
  summary: string,
  failed = false,
  changeSummary?: CodegenChangeSummary | null,
) {
  if (correctionStreamTimer) {
    clearInterval(correctionStreamTimer);
    correctionStreamTimer = null;
  }
  setPreviewBusy(false);

  const status = correctionStreamEl.querySelector("[data-stream-status='true']");
  status?.remove();

  for (const line of Array.from(
    correctionStreamEl.querySelectorAll(".correction-stream-line.is-active"),
  )) {
    line.classList.remove("is-active");
    line.classList.add("is-faded");
  }

  const items: ChangeListItem[] = failed
    ? [{ text: summary.trim() || "Update failed.", breaking: false }]
    : parseChangeListItems(summary || "Done.", changeSummary);

  const block = document.createElement("div");
  block.className = `correction-summary${failed ? " is-error" : ""}`;

  if (!failed && (changeSummary || items.some((item) => item.breaking))) {
    const hasBreaking = items.some((item) => item.breaking);
    const banner = document.createElement("p");
    banner.className = hasBreaking
      ? "correction-change-banner is-breaking"
      : "correction-change-banner is-safe";
    banner.textContent = hasBreaking
      ? "Includes breaking changes — review before shipping"
      : "No API-breaking changes detected";
    block.appendChild(banner);
  }

  const heading = document.createElement("p");
  heading.className = "correction-summary-heading";
  heading.textContent = failed ? "Error" : "Changes";
  block.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "correction-summary-list";
  block.appendChild(list);
  correctionStreamEl.appendChild(block);

  let itemIndex = 0;
  const revealNext = () => {
    if (itemIndex >= items.length) {
      preservePreviewDuringJob = false;
      activeStreamJobId = null;
      return;
    }

    const entry = items[itemIndex]!;
    const item = entry.breaking
      ? appendBreakingChangeItem(list, entry)
      : (() => {
          const el = document.createElement("li");
          el.className = "correction-summary-item";
          el.textContent = entry.text;
          list.appendChild(el);
          return el;
        })();
    correctionStreamEl.scrollTop = correctionStreamEl.scrollHeight;
    requestAnimationFrame(() => {
      item.classList.add("is-visible");
      syncCorrectionStreamFade();
    });

    itemIndex += 1;
    window.setTimeout(revealNext, 90);
  };
  revealNext();
  syncCorrectionStreamFade();
}

function handleJobStatusForActivityStream(job: {
  id: string;
  status: string;
  error?: string;
  codegenSummary?: string;
  changeSummary?: CodegenChangeSummary;
}) {
  const hasStream =
    activeStreamJobId === job.id ||
    activeStreamJobId === "pending" ||
    Boolean(correctionStreamEl.querySelector("[data-stream-status='true']"));

  if (!hasStream) return;

  if (job.status === "validated") {
    finishJobActivityStream(
      job.codegenSummary ?? "Update complete.",
      false,
      job.changeSummary ?? null,
    );
  } else if (job.status === "failed" || job.status === "needs_manual_fix") {
    finishJobActivityStream(job.error ?? "Update failed.", true);
  }
}

function isPreservedPreviewJob(jobId: string): boolean {
  return (
    preservePreviewDuringJob ||
    activeStreamJobId === jobId ||
    activeStreamJobId === "pending"
  );
}

function syncLlmFormVisibility() {
  llmFormSection.classList.toggle("hidden", !editingLlm);
  editLlmBtn.title = editingLlm ? "Cancel" : (editLlmBtn.dataset.label ?? "Edit model");
  editLlmBtn.setAttribute("aria-label", editLlmBtn.title);
  mountPreviewIcon(editLlmBtn, editingLlm ? PREVIEW_ICON_CLOSE : PREVIEW_ICON_EDIT);
}

function providerFromModelId(modelId: string): "anthropic" | "openai" {
  return modelId.startsWith("openai/") ? "openai" : "anthropic";
}

function modelLabelFor(modelId: string): string {
  return pushModelEl.selectedOptions[0]?.textContent ?? modelId.split("/")[1] ?? modelId;
}

function syncLlmSummary() {
  if (!llmConfigured) {
    llmSummaryText.textContent = "LLM not configured";
    return;
  }

  llmSummaryText.textContent = modelLabelFor(pushModelEl.value);
}

function beginLoading(btn: HTMLButtonElement) {
  if (loading) return;
  loading = true;
  for (const b of actionButtons) {
    b.disabled = true;
    if (b === btn) {
      b.classList.add("is-loading");
      b.setAttribute("aria-busy", "true");
      b.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
    }
  }
  syncAskToggleVisibility();
}

function endLoading() {
  if (!loading) return;
  loading = false;
  for (const b of actionButtons) {
    b.classList.remove("is-loading");
    b.removeAttribute("aria-busy");
    if (b === pushBtn) {
      restorePushButtonMarkup();
    } else {
      b.textContent = b.dataset.label ?? "";
    }
  }
  syncPushButtonLabel();
  syncDefaultDisabled();
}

type ConnectionPayload = {
  repoUrl: string;
  vcs: { baseBranch: string; defaultPrTarget: string };
  detected?: Record<string, unknown>;
  syncConfig?: Record<string, unknown>;
  setupCorrectedAt?: string;
};

function syncProviderFields() {
  const isBitbucket = providerEl.value === "bitbucket";
  labelSlugA.textContent = isBitbucket ? "Workspace" : "Owner";
  bitbucketFields.classList.toggle("hidden", !isBitbucket);
}

providerEl.onchange = () => {
  syncProviderFields();
};

syncProviderFields();

function formPayload(type: string) {
  const payload: Record<string, string> = {
    type,
    apiBase,
    provider: providerEl.value,
    slugA: slugAEl.value.trim(),
    slugB: slugBEl.value.trim(),
    token: tokenEl.value.trim(),
    baseBranch: baseBranchEl.value,
    defaultPrTarget: prTargetEl.value,
  };

  if (providerEl.value === "bitbucket") {
    payload.atlassianEmail = atlassianEmailEl.value.trim();
  }

  return payload;
}

function missingBitbucketFields(): string | null {
  if (providerEl.value !== "bitbucket") return null;
  if (!atlassianEmailEl.value.trim()) {
    return "Enter your Atlassian account email (required for API tokens).";
  }
  return null;
}

function fillBranchSelects(refs: Array<{ name: string }>) {
  const names = refs.map((r) => r.name).sort();
  const html = names.map((n) => `<option value="${n}">${n}</option>`).join("");
  baseBranchEl.innerHTML = html;
  prTargetEl.innerHTML = html;

  const preferred = names.includes("main")
    ? "main"
    : names.includes("master")
      ? "master"
      : names[0];

  if (preferred) {
    baseBranchEl.value = preferred;
    prTargetEl.value = preferred;
  }
}

function readSetupForm() {
  return {
    styleSystem: setupStyleEl.value,
    componentPath: setupComponentPathEl.value.trim(),
    tokenPaths: setupTokenPathEl.value.trim(),
    iconPath: setupIconPathEl.value.trim(),
    fontPaths: setupFontPathsEl.value.trim(),
    testFramework: setupTestFrameworkEl.value,
    storyFormat: setupStoryFormatEl.value,
    fileNaming: setupFileNamingEl.value,
    baseBranch: setupBaseBranchEl.value.trim(),
    defaultPrTarget: setupPrTargetEl.value.trim(),
    notes: setupNotesEl.value.trim(),
  };
}

function readLlmForm() {
  const modelId = pushModelEl.value;
  return {
    provider: providerFromModelId(modelId),
    modelId,
    token: llmTokenEl.value.trim(),
  };
}

function fillLlmForm(settings: {
  modelId?: string;
  hasToken?: boolean;
}) {
  syncPushModelOptions(settings.modelId);
  if (settings.hasToken) {
    llmTokenEl.placeholder = "Saved — enter a new key to replace";
  } else {
    llmTokenEl.placeholder = "sk-ant-... or sk-...";
  }
  llmConfigured = Boolean(settings.hasToken);
  syncLlmSummary();
  syncDefaultDisabled();
}

function webTokenPaths(web?: { tokenPaths?: string[]; tokenPath?: string }): string[] {
  if (web?.tokenPaths?.length) {
    return web.tokenPaths;
  }
  if (web?.tokenPath?.trim()) {
    return [web.tokenPath.trim()];
  }
  return [];
}

function fillSetupForm(connection: ConnectionPayload) {
  const web = connection.syncConfig?.web as
    | {
        styleSystem?: string;
        componentPath?: string;
        tokenPaths?: string[];
        tokenPath?: string;
        iconPath?: string;
      }
    | undefined;
  const tokens = connection.syncConfig?.tokens as { tokenPaths?: string[] } | undefined;
  const detected = connection.detected as
    | {
        styleSystem?: string;
        componentPaths?: string[];
        tokenPaths?: string[];
        iconPaths?: string[];
        fontPaths?: string[];
      }
    | undefined;
  const conventions = connection.syncConfig?.conventions as
    | { testFramework?: string; storyFormat?: string; fileNaming?: string }
    | undefined;
  const llm = connection.syncConfig?.llm as { notes?: string } | undefined;

  setupStyleEl.value = web?.styleSystem ?? detected?.styleSystem ?? "unknown";
  setupComponentPathEl.value =
    web?.componentPath ?? detected?.componentPaths?.[0] ?? "src/components";
  const savedTokenPaths =
    tokens?.tokenPaths?.length ? tokens.tokenPaths : webTokenPaths(web);
  setupTokenPathEl.value =
    savedTokenPaths.length > 0
      ? savedTokenPaths.join(", ")
      : (detected?.tokenPaths ?? []).join(", ");
  setupIconPathEl.value = web?.iconPath ?? detected?.iconPaths?.[0] ?? "";
  setupFontPathsEl.value = (detected?.fontPaths ?? []).join(", ");
  setupTestFrameworkEl.value = conventions?.testFramework ?? "none";
  setupStoryFormatEl.value = conventions?.storyFormat ?? "none";
  setupFileNamingEl.value =
    conventions?.fileNaming ?? (detected as { fileNaming?: string } | undefined)?.fileNaming ?? "PascalCase";
  setupBaseBranchEl.value = connection.vcs.baseBranch;
  setupPrTargetEl.value = connection.vcs.defaultPrTarget;
  setupNotesEl.value = llm?.notes ?? "";
}

const fallbackModels: Array<{ modelId: string; label: string; provider: string }> = [
  { modelId: "anthropic/claude-opus-4-7", label: "claude-opus-4-7", provider: "anthropic" },
  { modelId: "anthropic/claude-sonnet-4-6", label: "claude-sonnet-4-6", provider: "anthropic" },
  { modelId: "anthropic/claude-haiku-4-5", label: "claude-haiku-4-5", provider: "anthropic" },
  { modelId: "anthropic/claude-sonnet", label: "claude-sonnet", provider: "anthropic" },
  { modelId: "openai/gpt-5.5", label: "gpt-5.5", provider: "openai" },
  { modelId: "openai/gpt-5.4", label: "gpt-5.4", provider: "openai" },
  { modelId: "openai/gpt-5.4-mini", label: "gpt-5.4-mini", provider: "openai" },
  { modelId: "openai/gpt-4o", label: "gpt-4o", provider: "openai" },
  { modelId: "openai/o3", label: "o3", provider: "openai" },
];

function syncPushModelOptions(selectedModelId?: string) {
  const options = capabilityModels.length > 0 ? capabilityModels : fallbackModels;

  pushModelEl.innerHTML = options
    .map((model) => `<option value="${model.modelId}">${model.label}</option>`)
    .join("");

  const preferred =
    selectedModelId && options.some((model) => model.modelId === selectedModelId)
      ? selectedModelId
      : options[0]?.modelId;

  if (preferred) {
    pushModelEl.value = preferred;
  }
}

async function loadCapabilities(selectedModelId?: string) {
  try {
    const res = await fetch(`${apiBase}/capabilities`);
    if (!res.ok) return;
    const body = (await res.json()) as {
      models?: Array<{ modelId: string; label: string; provider: string }>;
    };
    if (body.models?.length) {
      capabilityModels = body.models;
      syncPushModelOptions(selectedModelId);
    }
  } catch {
    syncPushModelOptions(selectedModelId);
  }
}

function formatRepoName(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length === 0) return repoUrl;
  return parts[parts.length - 1]!;
}

function showSetupPreview(summary: string, correctedAt?: string) {
  setupPreviewEl.textContent = correctedAt
    ? `${summary}\n\nLast saved: ${new Date(correctedAt).toLocaleString()}`
    : summary;
  projectDetailsExpanded = false;
  syncProjectDetailsCollapse();
}

const PROJECT_DETAILS_SINGLE_LINE_HEIGHT = 36;

function syncProjectDetailsCollapse() {
  const needsCollapse = setupPreviewEl.scrollHeight > PROJECT_DETAILS_SINGLE_LINE_HEIGHT;
  projectDetailsBodyEl.classList.toggle("collapsed", !projectDetailsExpanded && needsCollapse);
  projectDetailsBodyEl.classList.toggle("expanded", projectDetailsExpanded || !needsCollapse);
  projectDetailsBodyEl.classList.toggle("is-compact", !needsCollapse);
  projectDetailsBodyEl.setAttribute("aria-expanded", String(projectDetailsExpanded || !needsCollapse));
}

function toggleProjectDetailsExpanded() {
  if (setupPreviewEl.scrollHeight <= PROJECT_DETAILS_SINGLE_LINE_HEIGHT) {
    return;
  }
  projectDetailsExpanded = !projectDetailsExpanded;
  syncProjectDetailsCollapse();
}

function showConnected(data: {
  connection: ConnectionPayload;
  summary?: string;
}) {
  connectScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
  connectedBadgeText.textContent = formatRepoName(data.connection.repoUrl);
  fillSetupForm(data.connection);
  setupSaved = Boolean(data.connection.setupCorrectedAt);
  editingSetup = false;
  syncMainScreenLayout({
    summary: data.summary,
    correctedAt: data.connection.setupCorrectedAt,
  });
  syncDefaultDisabled();
  statusEl.textContent = setupSaved
    ? llmConfigured
      ? "Select a component, confirm LLM settings, then push."
      : "Save LLM settings before pushing."
    : "Review setup and save before pushing components.";
}

function showDisconnected() {
  mainScreen.classList.add("hidden");
  connectScreen.classList.remove("hidden");
  setupSaved = false;
  editingSetup = false;
  llmConfigured = false;
  editingLlm = false;
  currentSelectionId = null;
  lastValidatedSelectionId = null;
  setResolvingMatch(false);
  clearMatchState();
  hideBuildPreview();
  buildCorrectionsEl.value = "";
  llmTokenEl.value = "";
  setupFormSection.classList.remove("hidden");
  readySection.classList.add("hidden");
  llmFormSection.classList.add("hidden");
  syncDefaultDisabled();
  statusEl.textContent = "Ready — connect your repo below.";
}

loadBranchesBtn.onclick = () => {
  const bitbucketError = missingBitbucketFields();
  if (bitbucketError) {
    statusEl.textContent = bitbucketError;
    return;
  }
  if (!tokenEl.value.trim() || !slugAEl.value.trim() || !slugBEl.value.trim()) {
    statusEl.textContent = "Enter workspace/owner, repo, and token first.";
    return;
  }
  beginLoading(loadBranchesBtn);
  parent.postMessage({ pluginMessage: formPayload("load-branches") }, "*");
};

connectBtn.onclick = () => {
  const bitbucketError = missingBitbucketFields();
  if (bitbucketError) {
    statusEl.textContent = bitbucketError;
    return;
  }
  if (!tokenEl.value.trim() || !slugAEl.value.trim() || !slugBEl.value.trim()) {
    statusEl.textContent = "Fill in all fields before connecting.";
    return;
  }
  beginLoading(connectBtn);
  parent.postMessage({ pluginMessage: formPayload("connect") }, "*");
};

rescanBtn.onclick = () => {
  const overrides = readSetupForm();
  if (!overrides.baseBranch || !overrides.defaultPrTarget) {
    statusEl.textContent = "Base branch and PR target are required.";
    return;
  }
  beginLoading(rescanBtn);
  parent.postMessage(
    {
      pluginMessage: {
        type: "rescan",
        apiBase,
        baseBranch: overrides.baseBranch,
        defaultPrTarget: overrides.defaultPrTarget,
      },
    },
    "*",
  );
};

saveSetupBtn.onclick = () => {
  const overrides = readSetupForm();
  if (!overrides.componentPath) {
    statusEl.textContent = "Component path is required.";
    return;
  }
  if (!overrides.baseBranch || !overrides.defaultPrTarget) {
    statusEl.textContent = "Base branch and PR target are required.";
    return;
  }
  beginLoading(saveSetupBtn);
  parent.postMessage({ pluginMessage: { type: "save-setup", overrides } }, "*");
};

editSetupBtn.onclick = (event) => {
  event.stopPropagation();
  editingSetup = true;
  editingLlm = false;
  syncMainScreenLayout();
  syncDefaultDisabled();
  statusEl.textContent = "Update setup, then save again before pushing.";
};

editLlmBtn.onclick = () => {
  editingLlm = !editingLlm;
  syncLlmFormVisibility();
  if (editingLlm) {
    statusEl.textContent = "Update model or API key, then save.";
  } else {
    syncLlmSummary();
    statusEl.textContent = llmConfigured
      ? "LLM settings ready — select a component and push."
      : "Save LLM settings before pushing.";
  }
};

saveLlmBtn.onclick = () => {
  const llm = readLlmForm();
  if (!llm.modelId) {
    statusEl.textContent = "Pick a model.";
    return;
  }
  if (!llm.token && !llmConfigured) {
    statusEl.textContent = "Enter your LLM API key.";
    return;
  }
  beginLoading(saveLlmBtn);
  parent.postMessage({ pluginMessage: { type: "save-llm", ...llm } }, "*");
};

pushModelEl.onchange = () => {
  syncLlmSummary();
};

pushBtn.onclick = () => {
  startBuild();
};

expandPreviewBtn.onclick = () => {
  openPreviewModal();
};

buildPreviewModePreviewBtn.onclick = () => {
  setPreviewViewMode("preview");
};

buildPreviewModeCodeBtn.onclick = () => {
  setPreviewViewMode("code");
};

previewModalModePreviewBtn.onclick = () => {
  setPreviewViewMode("preview");
};

previewModalModeCodeBtn.onclick = () => {
  setPreviewViewMode("code");
};

clearPreviewActionsBtn.onclick = () => {
  clearPreviewActionLogs();
};

clearPreviewModalActionsBtn.onclick = () => {
  clearPreviewActionLogs();
};

copyPreviewFileBtn.onclick = () => {
  copySelectedPreviewFile();
};

copyPreviewModalFileBtn.onclick = () => {
  copySelectedPreviewFile();
};

toggleCodeSidebarBtn.onclick = () => {
  toggleCodeSidebar();
};

togglePreviewModalCodeSidebarBtn.onclick = () => {
  toggleCodeSidebar();
};

closePreviewModalBtn.onclick = () => {
  closePreviewModal();
};

previewModalBackdropEl.onclick = () => {
  closePreviewModal();
};

rebuildWithCorrectionsBtn.onclick = () => {
  submitCorrection();
};

toggleAskBtn.onclick = () => {
  setAskComposerOpen(true);
};

buildCorrectionsEl.addEventListener("blur", () => {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active && previewActionBarEl.contains(active)) return;
    maybeCloseAskComposer();
  }, 150);
});

buildCorrectionsEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && askComposerOpen) {
    event.preventDefault();
    buildCorrectionsEl.value = "";
    setAskComposerOpen(false);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitCorrection();
  }
});

function submitCorrection() {
  const corrections = buildCorrectionsEl.value.trim();
  if (!corrections) {
    statusEl.textContent = "Describe the change you want.";
    return;
  }
  if (!currentBuildPreview) {
    statusEl.textContent = "Open a preview before applying corrections.";
    return;
  }
  activeStreamJobId = "pending";
  startBuild(corrections, rebuildWithCorrectionsBtn, {
    preservePreview: true,
    isCorrection: true,
  });
  buildCorrectionsEl.value = "";
  setAskComposerOpen(false);
}

disconnectBtn.onclick = () => {
  beginLoading(disconnectBtn);
  parent.postMessage({ pluginMessage: { type: "disconnect" } }, "*");
};

apiBaseEl.onchange = () => {
  apiBase = apiBaseEl.value.trim() || apiBase;
  parent.postMessage({ pluginMessage: { type: "save-api-base", apiBase } }, "*");
  void loadCapabilities();
};

function formatJobStatus(job: {
  id: string;
  status: string;
  componentName?: string;
  prUrl?: string;
  error?: string;
  codegenSummary?: string;
  changeSummary?: CodegenChangeSummary;
  patchCount?: number;
  buildPreview?: BuildPreview;
}): string {
  const lines = [
    job.componentName ? `Component: ${job.componentName}` : null,
    `Job: ${job.id}`,
    `Status: ${job.status}`,
  ].filter(Boolean) as string[];

  if (job.status === "validated") {
    if (job.patchCount !== undefined) {
      lines.push(`Patches: ${job.patchCount}`);
    }
    const summary =
      job.codegenSummary ?? "Codegen complete — workspace apply and PR ship in M5–M6.";
    if (job.changeSummary) {
      const hasBreaking = job.changeSummary.changes.some((item) => item.breaking);
      lines.push(
        "",
        hasBreaking ? "Includes breaking changes:" : "No API-breaking changes detected:",
      );
      for (const item of job.changeSummary.changes) {
        const fixSuffix = item.breaking && item.fix ? ` — Fix: ${item.fix}` : "";
        lines.push(`${item.breaking ? "⚠ " : "• "}${item.text}${fixSuffix}`);
      }
    } else {
      lines.push("", "Changes:");
      for (const item of formatSummaryAsListItems(summary)) {
        lines.push(`• ${item}`);
      }
    }
  } else if (job.status === "queued" || job.status === "running" || job.status === "codegen") {
    lines.push("", "Worker is processing your selection…");
  } else if (job.prUrl) {
    lines.push(`PR: ${job.prUrl}`);
  }

  if (job.error) {
    lines.push(`Error: ${job.error}`);
  }

  return lines.join("\n");
}

window.onmessage = (event: MessageEvent) => {
  const msg = event.data.pluginMessage as Record<string, unknown> | undefined;
  if (!msg?.type) return;

  if (msg.type === "init") {
    apiBase = (msg.apiBase as string) || apiBase;
    apiBaseEl.value = apiBase;
    if (typeof msg.atlassianEmail === "string") {
      atlassianEmailEl.value = msg.atlassianEmail;
    }
    syncProviderFields();
    hasValidSelection = Boolean(msg.hasValidSelection);
    const connection = msg.connection as ConnectionPayload | null;
    const llm = msg.llm as
      | { provider?: string; modelId?: string; hasToken?: boolean }
      | undefined;
    void loadCapabilities(llm?.modelId).then(() => {
      if (llm) {
        fillLlmForm(llm);
      }
      editingLlm = !llm?.hasToken;
      if (msg.connected && connection) {
        showConnected({
          connection,
          summary: msg.summary as string | undefined,
        });
      } else {
        showDisconnected();
      }
    });
    return;
  }

  if (msg.type === "selection-changed") {
    const nextSelectionId = typeof msg.selectionId === "string" ? msg.selectionId : null;
    hasValidSelection = Boolean(msg.hasValidSelection);

    if (
      lastValidatedSelectionId &&
      nextSelectionId !== lastValidatedSelectionId
    ) {
      clearValidatedBuildState();
    }

    if (nextSelectionId !== currentSelectionId) {
      clearMatchState();
      resetPreviewForSelectionChange();
    }

    currentSelectionId = nextSelectionId;
    syncBuildUiState();
    syncDefaultDisabled();
    return;
  }

  if (msg.type === "component-resolving") {
    const selId = typeof msg.selectionId === "string" ? msg.selectionId : null;
    if (selId && selId !== currentSelectionId) {
      return;
    }
    setResolvingMatch(true);
    return;
  }

  if (msg.type === "component-resolved") {
    const selId = typeof msg.selectionId === "string" ? msg.selectionId : null;
    if (selId && currentSelectionId && selId !== currentSelectionId) {
      return;
    }
    setResolvingMatch(false);

    const mode = msg.mode === "update" ? "update" : "create";
    if (mode === "update" && msg.matched && msg.bundleId && msg.bundle) {
      componentWorkflowMode = "update";
      currentResolvedBundle = msg.bundle as ResolvedBundleSummary;
      renderResolvedBundle(currentResolvedBundle);
      prepareExistingPreview(currentResolvedBundle, selId);
      showBuildProgress(currentResolvedBundle.componentName);
      statusEl.textContent = `Found ${currentResolvedBundle.componentName} — building preview…`;
    } else {
      componentWorkflowMode = "create";
      currentResolvedBundle = null;
      matchSectionEl.classList.add("hidden");
      if (msg.reason && typeof msg.reason === "string") {
        statusEl.textContent = msg.reason;
      }
    }
    syncPushButtonLabel();
    syncDefaultDisabled();
    return;
  }

  if (msg.type === "existing-preview-ready") {
    const selId = typeof msg.selectionId === "string" ? msg.selectionId : null;
    if (selId && currentSelectionId && selId !== currentSelectionId) return;
    hideBuildProgress();
    revealExistingPreview(
      msg.sessionId as string,
      msg.previewUrl as string,
    );
    statusEl.textContent = "";
    return;
  }

  if (msg.type === "existing-preview-failed") {
    hideBuildProgress();
    clearPreviewReadyTimer();
    const reason =
      typeof msg.reason === "string" && msg.reason.trim()
        ? msg.reason.trim()
        : "Preview could not be built — you can still browse the code files.";
    statusEl.textContent = reason;
    if (currentBuildPreview) {
      buildPreviewFormatEl.textContent = "Existing component";
      buildPreviewFrameEl.classList.add("hidden");
      buildPreviewEmptyEl.classList.remove("hidden");
      buildPreviewEmptyEl.textContent = reason;
      setPreviewViewMode("code");
      refreshCodeExplorers();
      buildPreviewSection.classList.remove("hidden");
      buildPreviewCardEl.classList.remove("hidden");
      previewWorkflowEl.classList.remove("hidden");
      syncBuildUiState();
      syncDefaultDisabled();
    }
    return;
  }

  if (msg.type === "status") {
    statusEl.textContent = String(msg.message ?? "");
  }

  if (msg.type === "branches-loaded") {
    endLoading();
    fillBranchSelects((msg.refs as Array<{ name: string }>) || []);
    statusEl.textContent = `Loaded ${(msg.refs as unknown[])?.length ?? 0} branch(es). Pick base + PR target.`;
  }

  if (msg.type === "connected") {
    endLoading();
    showConnected({
      connection: (msg as { connection: ConnectionPayload }).connection,
      summary: msg.summary as string | undefined,
    });
    if (msg.refreshed) {
      setupSaved = false;
      editingSetup = false;
      syncMainScreenLayout({ summary: msg.summary as string | undefined });
      syncDefaultDisabled();
      statusEl.textContent = "Detection refreshed — review setup and save again.";
    }
  }

  if (msg.type === "setup-saved") {
    endLoading();
    setupSaved = true;
    editingSetup = false;
    editingLlm = !llmConfigured;
    showConnected({
      connection: (msg as { connection: ConnectionPayload }).connection,
      summary: msg.summary as string | undefined,
    });
    syncLlmFormVisibility();
    statusEl.textContent = llmConfigured
      ? "Setup saved — select a component and push."
      : "Setup saved — save LLM settings, then push.";
  }

  if (msg.type === "llm-saved") {
    endLoading();
    llmConfigured = true;
    editingLlm = false;
    fillLlmForm({
      modelId: msg.modelId as string,
      hasToken: true,
    });
    syncLlmFormVisibility();
    syncDefaultDisabled();
    statusEl.textContent = "LLM settings saved — select a component and push.";
  }

  if (msg.type === "disconnected") {
    endLoading();
    showDisconnected();
  }

  if (msg.type === "debug-log") {
    console.log(`[fig2code] ${String(msg.label ?? "debug")}`, msg.data);
  }

  if (msg.type === "job-created") {
    const job = msg.job as { id: string; status: string; componentName?: string };
    const preservePreview =
      preservePreviewDuringJob ||
      activeStreamJobId === "pending" ||
      Boolean(correctionStreamEl.querySelector("[data-stream-status='true']"));
    if (preservePreview) {
      activeStreamJobId = job.id;
    } else {
      hideBuildPreview();
      buildCorrectionsEl.value = "";
    }
    if (!preservePreview) {
      statusEl.textContent = formatJobStatus(job);
    }
  }

  if (msg.type === "job-update") {
    const job = msg.job as {
      id: string;
      status: string;
      componentName?: string;
      prUrl?: string;
      error?: string;
      codegenSummary?: string;
      changeSummary?: CodegenChangeSummary;
      patchCount?: number;
      buildPreview?: BuildPreview;
    };
    handleJobStatusForActivityStream(job);
    const preservedRun = isPreservedPreviewJob(job.id);

    if (!preservedRun) {
      statusEl.textContent = formatJobStatus(job);
    }

    if (job.status === "validated" && job.buildPreview) {
      lastValidatedSelectionId = currentSelectionId;
      setPreviewBusy(false);
      if (!existingPreviewSessionId) {
        showBuildPreview(job.buildPreview, job.id);
      }
    } else if (job.status === "failed" || job.status === "needs_manual_fix") {
      if (!preservedRun) {
        clearValidatedBuildState();
      } else {
        setPreviewBusy(false);
      }
    }
    if (
      job.status === "validated" ||
      job.status === "pr_opened" ||
      job.status === "failed" ||
      job.status === "needs_manual_fix"
    ) {
      endLoading();
    }
  }

  if (msg.type === "error") {
    endLoading();
    statusEl.textContent = `Error: ${msg.message}`;
  }
};

window.addEventListener("message", (event: MessageEvent) => {
  if (!isPreviewMessage(event)) {
    return;
  }

  if (event.data?.type === PREVIEW_READY_MESSAGE) {
    previewHarnessReady = true;
    clearPreviewReadyTimer();
    buildPreviewFrameEl.classList.remove("hidden");
    buildPreviewEmptyEl.classList.add("hidden");
    postPreviewArgsToFrame(buildPreviewFrameEl);
    postPreviewArgsToFrame(previewModalFrameEl);
    return;
  }

  if (event.data?.type === PREVIEW_ACTION_MESSAGE) {
    const action = event.data.action as PreviewActionEntry | undefined;
    if (action?.name) {
      appendPreviewAction(action);
    }
  }
});

function isPreviewMessage(event: MessageEvent): boolean {
  const msgType = event.data?.type;
  if (typeof msgType !== "string") return false;
  if (!msgType.startsWith("fig2code-preview-")) return false;
  const apiOrigin = previewMessageOrigin();
  if (apiOrigin === "*") return true;
  if (event.origin === apiOrigin) return true;
  try {
    if (new URL(event.origin).hostname === "localhost") return true;
  } catch {}
  return false;
}

statusEl.textContent = "UI loaded — waiting for plugin…";

function mountPreviewIcon(button: HTMLButtonElement, icon: string) {
  button.innerHTML = icon;
}

mountPreviewIcon(buildPreviewModePreviewBtn, PREVIEW_ICON_PREVIEW);
mountPreviewIcon(buildPreviewModeCodeBtn, PREVIEW_ICON_CODE);
mountPreviewIcon(expandPreviewBtn, PREVIEW_ICON_EXPAND);
mountPreviewIcon(copyPreviewFileBtn, PREVIEW_ICON_COPY);
mountPreviewIcon(editSetupBtn, PREVIEW_ICON_EDIT);
mountPreviewIcon(editLlmBtn, PREVIEW_ICON_EDIT);
mountPreviewIcon(previewModalModePreviewBtn, PREVIEW_ICON_PREVIEW);
mountPreviewIcon(previewModalModeCodeBtn, PREVIEW_ICON_CODE);
mountPreviewIcon(copyPreviewModalFileBtn, PREVIEW_ICON_COPY);
mountPreviewIcon(closePreviewModalBtn, PREVIEW_ICON_CLOSE);

syncCodeSidebarExpanded();
correctionStreamEl.addEventListener("scroll", syncCorrectionStreamFade, { passive: true });
window.addEventListener("resize", syncCorrectionStreamFade);
setupCodeEditorEvents(inlineCodeExplorer);
setupCodeEditorEvents(modalCodeExplorer);

projectDetailsBodyEl.onclick = () => {
  toggleProjectDetailsExpanded();
};

projectDetailsBodyEl.onkeydown = (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleProjectDetailsExpanded();
  }
};

parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");
