export interface FilePatch {
  path: string;
  action: "create" | "update" | "delete";
  content?: string;
}

export interface CodegenOutput {
  patches: FilePatch[];
  summary?: string;
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
