import type { PrunedSpec } from "./pruned-spec.js";
import type { Platform } from "./detected-config.js";
import type { SyncConfig, VcsConfig } from "./sync-config.js";
import type { CodegenChangeSummary } from "./codegen.js";

export type JobStatus =
  | "queued"
  | "running"
  | "codegen"
  | "gates"
  | "pr_opened"
  | "validated"
  | "failed"
  | "needs_manual_fix";

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "pr_opened",
  "validated",
  "failed",
  "needs_manual_fix",
]);

export type JobIntent = "component" | "component-update" | "screen" | "token" | "icon";

export interface CreateJobRequest {
  intent: JobIntent;
  prunedSpec: PrunedSpec;
  targets: Platform[];
  figmaFileKey?: string;
  figmaAccessToken?: string;
}

/** Plugin → API payload: spec plus repo context for the worker (M3+). */
export interface EnqueueJobRequest extends CreateJobRequest {
  sessionId: string;
  vcs: VcsConfig;
  syncConfig: SyncConfig;
  /** Set when intent === "component-update" to point at a resolved repo bundle. */
  bundleId?: string;
  /** Inline file contents from the plugin preview (edits + corrections). */
  previewFileOverrides?: Array<{
    path: string;
    role: string;
    content: string;
  }>;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  intent: JobIntent;
  componentName?: string;
  createdAt: string;
  updatedAt: string;
  prUrl?: string;
  error?: string;
  retriesUsed?: number;
  codegenSummary?: string;
  changeSummary?: CodegenChangeSummary;
  patchCount?: number;
  buildPreview?: JobBuildPreview;
}

export interface JobBuildPreviewFile {
  path: string;
  action: "create" | "update" | "delete";
  content?: string;
}

export interface JobBuildPreviewPropControl {
  name: string;
  control: "select" | "text" | "boolean" | "number";
  options?: string[];
}

export interface JobBuildPreview {
  componentName: string;
  storyFormat: "csf3" | "csf2" | "none";
  storyPath?: string;
  storyContent?: string;
  componentPath?: string;
  componentContent?: string;
  variantLabel: string;
  variants?: Record<string, string[]>;
  /** Editable non-variant props for live preview controls. */
  propControls?: JobBuildPreviewPropControl[];
  /** True when preview falls back to component source (no linked Storybook story). */
  storyMissing?: boolean;
  /** All generated/edited files from codegen patches. */
  files?: JobBuildPreviewFile[];
  /** CSS variable definitions for design tokens used in the component. */
  tokenCss?: string;
}

/** Worker claim payload — includes secrets; never expose via GET /jobs. */
export interface ClaimedJobPayload extends EnqueueJobRequest {
  jobId: string;
  gitToken: string;
  atlassianEmail?: string;
  llmToken?: string;
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function validatePrunedSpec(spec: PrunedSpec | undefined): string | null {
  if (!spec?.name?.trim()) {
    return "PrunedSpec.name is required";
  }
  if (spec.kind !== "component" && spec.kind !== "screen") {
    return "PrunedSpec.kind must be component or screen";
  }
  return null;
}

export interface CapabilitiesResponse {
  models: Array<{
    provider: string;
    modelId: string;
    label: string;
    maxContextHint?: number;
  }>;
  gitHosts: Array<{
    provider: string;
    label: string;
    authMethods: string[];
  }>;
}
