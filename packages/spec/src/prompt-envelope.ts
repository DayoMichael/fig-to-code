export type PromptSlotId =
  | "system_core"
  | "job_facts"
  | "pruned_spec"
  | "project_tokens"
  | "token_resolver"
  | "registry_hints"
  | "example_styles"
  | "existing_files"
  | "output_contract"
  | "repair_context";

export interface PromptSlot {
  id: PromptSlotId;
  content: string;
  estimatedChars?: number;
  estimatedTokens?: number;
}

export interface PromptEnvelope {
  profile: string;
  modelId: string;
  slots: PromptSlot[];
  estimatedTotalTokens?: number;
}

export interface RepairEnvelope extends PromptEnvelope {
  attempt: number;
  gateName: string;
  gateExitCode: number;
  truncatedStderr: string;
  lastPatchSummary?: Record<string, unknown>;
}

export interface CompactionResult {
  version: "v1";
  slotId: PromptSlotId;
  replacement: string;
  droppedFacts: string[];
  invariantChecks: {
    tokenCoverageOk: boolean;
    unresolvedRefs?: string[];
  };
}
