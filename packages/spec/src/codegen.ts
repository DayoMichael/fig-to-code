export interface FilePatch {
  path: string;
  action: "create" | "update" | "delete";
  content?: string;
}

export interface CodegenChangeItem {
  text: string;
  breaking: boolean;
  /** Actionable migration step for consumers when breaking=true. */
  fix?: string;
}

/** Structured update changelog for component-update jobs. */
export interface CodegenChangeSummary {
  hasBreakingChanges: boolean;
  changes: CodegenChangeItem[];
}

export interface CodegenOutput {
  patches: FilePatch[];
  summary?: string;
  changeSummary?: CodegenChangeSummary;
  registryUpdates?: Record<string, unknown>;
}

export interface GateResult {
  name: string;
  passed: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export interface QaReport {
  jobId: string;
  gates: GateResult[];
  retriesUsed: number;
  passed: boolean;
  generatedAt: string;
}
