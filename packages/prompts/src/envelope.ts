import type { PromptEnvelope, PromptSlot, ProjectTokensSummary, RepairEnvelope } from "@fig2code/spec";

export const PROMPT_PROFILES = {
  "component-v1": "prompts/component-gen@v1",
} as const;

export type PromptProfile = keyof typeof PROMPT_PROFILES;

export interface EnvelopeBuildInput {
  profile: PromptProfile;
  modelId: string;
  jobFacts: Record<string, unknown>;
  prunedSpec: Record<string, unknown> | { name: string; kind: string };
  projectTokens: ProjectTokensSummary | Record<string, unknown>;
  tokenResolver: Record<string, string>;
  registryHints: Record<string, string>;
  exampleStyles: string;
  envelopeBudget?: number;
}

export interface SlotBudget {
  maxChars: number;
}

export const SLOT_BUDGETS: Record<string, SlotBudget> = {
  system_core: { maxChars: 4_000 },
  job_facts: { maxChars: 8_000 },
  pruned_spec: { maxChars: 32_000 },
  project_tokens: { maxChars: 24_000 },
  token_resolver: { maxChars: 16_000 },
  registry_hints: { maxChars: 8_000 },
  example_styles: { maxChars: 24_000 },
  output_contract: { maxChars: 4_000 },
  repair_context: { maxChars: 12_000 },
};

const SYSTEM_CORE_V1 = `You are Fig2Code, a codegen assistant for design-system components.
Output ONLY valid JSON matching the output contract: { "patches": [{ "path", "action", "content?" }], "summary?" }.
Match the team's conventions exactly. Never invent import paths outside registry_hints.
In React/JSX, the style prop must be an object mapping camelCase CSS properties to values (style={{ marginRight: 8 }}), never an HTML/CSS string.

Design tokens: pruned_spec styles, typography, and layout.typography already contain resolved Tailwind classes from the team repo (e.g. text-text-primary, text-sm, font-body, bg-surface-warning).
Copy those class strings into className exactly — do not substitute rgb/hex values, arbitrary Tailwind classes, or re-resolve token: references.
project_tokens and token_resolver document the team's naming; use pruned_spec as the source of truth for this component.
Never emit arbitrary Tailwind values copied from Figma (font-[...], text-[14px], text-[rgb(...)]) when pruned_spec already provides the matching class.
Follow example_styles for patterns not covered by pruned_spec.`;

const OUTPUT_CONTRACT_V1 = `{
  "patches": [{ "path": "string", "action": "create"|"update"|"delete", "content": "string?" }],
  "summary": "string?"
}`;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 20)}\n...[truncated]`;
}

export function buildComponentEnvelope(input: EnvelopeBuildInput): PromptEnvelope {
  const slots: PromptSlot[] = [
    slot("system_core", SYSTEM_CORE_V1),
    slot("job_facts", JSON.stringify(input.jobFacts)),
    slot("pruned_spec", JSON.stringify(input.prunedSpec)),
    slot("project_tokens", JSON.stringify(input.projectTokens)),
    slot("token_resolver", JSON.stringify(input.tokenResolver)),
    slot("registry_hints", JSON.stringify(input.registryHints)),
    slot("example_styles", input.exampleStyles),
    slot("output_contract", OUTPUT_CONTRACT_V1),
  ];

  const estimatedTotalTokens = slots.reduce(
    (sum, s) => sum + (s.estimatedTokens ?? 0),
    0,
  );

  let envelope: PromptEnvelope = {
    profile: input.profile,
    modelId: input.modelId,
    slots,
    estimatedTotalTokens,
  };

  if (input.envelopeBudget && estimatedTotalTokens > input.envelopeBudget) {
    envelope = applyTruncationLadder(envelope);
  }

  return envelope;
}

export function buildRepairEnvelope(
  base: PromptEnvelope,
  repair: {
    attempt: number;
    gateName: string;
    gateExitCode: number;
    truncatedStderr: string;
    lastPatchSummary?: Record<string, unknown>;
  },
): RepairEnvelope {
  const repairContext = JSON.stringify({
    gate: repair.gateName,
    exitCode: repair.gateExitCode,
    stderr: repair.truncatedStderr,
    lastPatchSummary: repair.lastPatchSummary,
  });

  const slots = base.slots
    .filter((s) => s.id !== "example_styles" && s.id !== "registry_hints")
    .concat(slot("repair_context", repairContext));

  return {
    ...base,
    slots,
    attempt: repair.attempt,
    gateName: repair.gateName,
    gateExitCode: repair.gateExitCode,
    truncatedStderr: repair.truncatedStderr,
    lastPatchSummary: repair.lastPatchSummary,
    estimatedTotalTokens: slots.reduce((sum, s) => sum + (s.estimatedTokens ?? 0), 0),
  };
}

function slot(id: PromptSlot["id"], content: string): PromptSlot {
  const budget = SLOT_BUDGETS[id]?.maxChars ?? 32_000;
  const trimmed = truncateToBudget(content, budget);
  return {
    id,
    content: trimmed,
    estimatedChars: trimmed.length,
    estimatedTokens: estimateTokens(trimmed),
  };
}

/** Deterministic truncation order from architecture.md */
function applyTruncationLadder(envelope: PromptEnvelope): PromptEnvelope {
  const order: PromptSlot["id"][] = [
    "example_styles",
    "project_tokens",
    "registry_hints",
    "token_resolver",
  ];

  const slots = envelope.slots.map((s) => ({ ...s }));

  for (const slotId of order) {
    const idx = slots.findIndex((s) => s.id === slotId);
    if (idx === -1) continue;

    const current = slots[idx]!;
    const budget = SLOT_BUDGETS[slotId]?.maxChars ?? 8_000;
    const shrunk = truncateToBudget(current.content, Math.floor(budget * 0.5));
    slots[idx] = {
      ...current,
      content: shrunk,
      estimatedChars: shrunk.length,
      estimatedTokens: estimateTokens(shrunk),
    };

    const total = slots.reduce((sum, s) => sum + (s.estimatedTokens ?? 0), 0);
    if (!envelope.estimatedTotalTokens || total <= envelope.estimatedTotalTokens) {
      return { ...envelope, slots, estimatedTotalTokens: total };
    }
  }

  return {
    ...envelope,
    slots,
    estimatedTotalTokens: slots.reduce((sum, s) => sum + (s.estimatedTokens ?? 0), 0),
  };
}
