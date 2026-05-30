import type {
  PromptEnvelope,
  PromptSlot,
  ProjectTokensSummary,
  RepairEnvelope,
  ResolvedComponentFile,
} from "@fig2code/spec";

export const PROMPT_PROFILES = {
  "component-v1": "prompts/component-gen@v1",
  "component-update-v1": "prompts/component-update@v1",
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

export interface ExistingFilesSlot {
  componentName: string;
  files: ResolvedComponentFile[];
  relatedModules?: ResolvedComponentFile[];
  truncated?: boolean;
}

export interface UpdateEnvelopeBuildInput extends EnvelopeBuildInput {
  profile: "component-update-v1";
  existingFiles: ExistingFilesSlot;
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
  existing_files: { maxChars: 48_000 },
  output_contract: { maxChars: 4_000 },
  repair_context: { maxChars: 12_000 },
};

const SYSTEM_CORE_UPDATE_V1 = `You are Fig2Code, a codegen assistant that updates existing design-system components to match a Figma selection.
You receive:
- existing_files: the team's current implementation (component, story, tests, barrels, optional related modules)
- pruned_spec: the target design/behavior from Figma
- job_facts: team conventions and match metadata
- example_styles, registry_hints, project_tokens, token_resolver: team patterns
Produce an updated implementation that:
1. Preserves the team's file paths, export style, and conventions from existing_files
2. Reflects pruned_spec (minimal diff — only change what Figma requires)
3. Runs in Fig2Code's in-plugin preview (same constraints as new component generation)
Output ONLY valid JSON: { "patches": [{ "path", "action", "content?" }], "summary?", "changeSummary?" }
- changeSummary: REQUIRED. Object with hasBreakingChanges (boolean) and changes (array of { text, breaking, fix? }).
  Classify conservatively — if a change MIGHT break an existing consumer, mark breaking=true.
  - breaking=true (non-exhaustive — when unsure, choose true):
    • removed / renamed / retyped props, variants, slots, sub-components, or exports
    • stricter or narrowed prop types; optional → required; new required props without defaults
    • changed default values (component or story) that alter rendered output for existing callers
    • removed or renamed CVA/className variant keys consumers may pass
    • behaviour, event-handler signature, DOM structure, or accessibility contract changes
    • styling/token/class changes on surfaces existing callers depend on (not purely internal)
    • any change to public API, file exports, or story args teams copy into apps
  - breaking=false ONLY when you are confident existing callers cannot break:
    • purely additive optional props/variants with safe defaults
    • internal implementation refactors with identical public API and rendered output
    • story-only metadata that does not change component defaults
  - fix: REQUIRED when breaking=true. One short, actionable migration step for app teams (e.g. "Rename prop bodyText to subtitle at all call sites" or "Pass size explicitly — default changed from md to sm").
  - hasBreakingChanges MUST be true if ANY entry has breaking=true.
  - Do NOT mark renames, removals, default changes, or type tightening as non-breaking.
- summary: optional plain-text mirror; if omitted, UI uses changeSummary.

==============================
HARD SYNTAX RULES — read first
==============================
Every emitted .ts/.tsx file MUST parse with @babel/parser using { plugins: ["jsx","typescript"], sourceType: "module" }.
If it does not parse, the job is rejected.

Rule 1 — Declare prop types ABOVE the function and reference them by name. Do NOT inline destructured type annotations.

BAD (this is the failure we hit in production — the colon between \`}\` and \`{\` is gone):
    function Button({
      variant,
      size,
      onDragStart,
      onDragEnd,
    }{
      disabled?: boolean;
      'aria-disabled'?: boolean;
    } = {} as ButtonProps) { ... }

ALSO BAD (inline destructured type annotation — fragile, do not emit even if syntactically legal):
    function Button({ variant, size, onDragStart, onDragEnd }: ButtonProps & {
      disabled?: boolean;
      'aria-disabled'?: boolean;
    }) { ... }

GOOD (this is the only shape you should emit):
    interface ButtonProps {
      variant?: "primary" | "secondary";
      size?: "sm" | "md" | "lg";
      disabled?: boolean;
      "aria-disabled"?: boolean;
      "aria-busy"?: boolean;
      onDragStart?: React.DragEventHandler<HTMLButtonElement>;
      onDragEnd?: React.DragEventHandler<HTMLButtonElement>;
    }
    export function Button(props: ButtonProps) {
      const { variant, size, onDragStart, onDragEnd, ...rest } = props;
      return <button onDragStart={onDragStart} onDragEnd={onDragEnd} {...rest} />;
    }

Rule 2 — Never emit the token sequence \`}{\` anywhere in a function parameter list. If you ever feel like writing it, stop and use the GOOD pattern above.
Rule 3 — Use single-line, balanced braces inside object types. Do not split \`}: {\` across lines.
Rule 4 — The component file MUST export the React component in PascalCase under exactly the name in job_facts.componentName (e.g. \`export function Button\`, \`export const Button = forwardRef(...)\`). Declare the component as the FIRST PascalCase export. Utility consts (\`buttonVariants\`, \`buttonStyles\`, \`tokens\`, etc.) must use lowerCamelCase — never PascalCase, never UPPER_SNAKE — because our preview picks the first PascalCase declaration as the component to render.
Rule 5 — Do NOT export the component as a plain object of sub-components (e.g. \`export const Button = { Root, Icon }\`). Keep \`Button\` as the function/forwardRef itself; attach sub-components via \`Button.Icon = ...\` after the declaration.
Rule 6 — Component file is a self-contained module: a single named (or default) export of the component plus its prop type. No barrel re-exports inside the component file.
Rule 7 — Default story args must render the component synchronously. No router, data fetching, or context providers the preview cannot satisfy.

============
PATCH RULES
============
- Use action "update" for paths that exist in existing_files; "create" only for missing required files (e.g. a new story when none exists).
- Do not invent import paths outside registry_hints. Prefer relative imports already present in existing_files.
- Update .stories.tsx (and tests if present) only when the component change requires it.
- When no story exists in existing_files and conventions.storyFormat is not "none", create the story at the team's story path (see expectedFiles in job_facts when present).
- When no test exists and conventions.testFramework is not "none", create the test file.
- When a barrel or package index export is missing, add it (package index uses /* fig2code:append-export */ marker for append-only updates).
- Copy Tailwind classes from pruned_spec exactly — no arbitrary text-[14px] or raw hex when classes exist.
- Do NOT emit Tailwind arbitrary CSS-var utilities like \`bg-[var(--token)]\` or \`hover:bg-[var(--token)]\`. Use semantic token utility classes from pruned_spec / registry_hints (e.g. \`bg-k-color-button-bg-filled\`, \`hover:bg-k-color-button-bg-filled-hovered\`).
- JSX style prop must be an object, never a CSS string.
- Preview-safe: keep component + default story self-contained; avoid deep monorepo imports you cannot satisfy.
- If job_facts.corrections or teamNotes exist, follow them.
- If Figma already matches repo, say so in summary; still emit the story patch so the preview renders the updated default args.`;

const SYSTEM_CORE_V1 = `You are Fig2Code, a codegen assistant for design-system components.
Output ONLY valid JSON matching the output contract: { "patches": [{ "path", "action", "content?" }], "summary?" }.
summary: when present, a newline-separated bullet list — each line starts with "- " and describes ONE change. No prose paragraphs.
Match the team's conventions exactly. Never invent import paths outside registry_hints.
In React/JSX, the style prop must be an object mapping camelCase CSS properties to values (style={{ marginRight: 8 }}), never an HTML/CSS string.

==============================
HARD SYNTAX RULES — read first
==============================
Every emitted .ts/.tsx file MUST parse with @babel/parser using { plugins: ["jsx","typescript"], sourceType: "module" }. If it does not parse, the job is rejected.

Declare prop types ABOVE the function and reference them by name. Do NOT inline destructured type annotations.

BAD (do not emit — this exact failure mode keeps recurring):
    function Button({
      variant,
      onDragStart,
      onDragEnd,
    }{
      disabled?: boolean;
    } = {} as ButtonProps) { ... }

GOOD:
    interface ButtonProps {
      variant?: "primary" | "secondary";
      disabled?: boolean;
      onDragStart?: React.DragEventHandler<HTMLButtonElement>;
      onDragEnd?: React.DragEventHandler<HTMLButtonElement>;
    }
    export function Button(props: ButtonProps) {
      const { variant, onDragStart, onDragEnd, ...rest } = props;
      return <button onDragStart={onDragStart} onDragEnd={onDragEnd} {...rest} />;
    }

Never emit the token sequence \`}{\` in a function parameter list under any circumstances.
Export the React component in PascalCase as the FIRST PascalCase declaration in the file. Utility consts (variants, styles, tokens) must use lowerCamelCase, never PascalCase.
Never export the component as a plain object (\`export const Button = { Root, Icon }\`); keep \`Button\` as a function/forwardRef and attach sub-components afterwards (\`Button.Icon = ...\`).

When job_facts.conventions.storyFormat is csf3 or csf2, ALWAYS emit a Storybook story file at job_facts.expectedFiles.storyPath (create) with meta.component set to the component under test and preview-safe Default args.
When job_facts.conventions.testFramework is vitest or jest, ALWAYS emit a test file at job_facts.expectedFiles.testPath (create).
When job_facts.expectedFiles.barrelPath is set, emit that index.ts barrel exporting the component and its props type.
When job_facts.expectedFiles.packageIndexPath is set, emit an update patch for that file using the fig2code append-export marker exactly as in job_facts.expectedFiles.packageIndexPatchExample.

Design tokens: pruned_spec styles, typography, and layout.typography already contain resolved Tailwind classes from the team repo (e.g. text-text-primary, text-sm, font-body, bg-surface-warning).
Copy those class strings into className exactly — do not substitute rgb/hex values, arbitrary Tailwind classes, or re-resolve token: references.
project_tokens and token_resolver document the team's naming; use pruned_spec as the source of truth for this component.
Never emit arbitrary Tailwind values copied from Figma (font-[...], text-[14px], text-[rgb(...)]) when pruned_spec already provides the matching class.
Do NOT emit Tailwind arbitrary CSS-var utilities like \`bg-[var(--token)]\` or \`hover:bg-[var(--token)]\`. Use semantic token utility classes from pruned_spec / registry_hints (e.g. \`bg-k-color-button-bg-filled\`, \`hover:bg-k-color-button-bg-filled-hovered\`).
Follow example_styles for patterns not covered by pruned_spec.`;

const OUTPUT_CONTRACT_V1 = `{
  "patches": [{ "path": "string", "action": "create"|"update"|"delete", "content": "string?" }],
  "summary": "string?",
  "changeSummary": {
    "hasBreakingChanges": "boolean",
    "changes": [{ "text": "string", "breaking": "boolean", "fix": "string?" }]
  }
}`;

const OUTPUT_CONTRACT_UPDATE_V1 = `{
  "patches": [{ "path": "string", "action": "create"|"update"|"delete", "content": "string?" }],
  "changeSummary": {
    "hasBreakingChanges": "boolean",
    "changes": [{ "text": "string — one discrete change", "breaking": "boolean", "fix": "string? — required when breaking=true" }]
  },
  "summary": "string? — optional; same bullets as changeSummary.changes"
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

export function buildComponentUpdateEnvelope(
  input: UpdateEnvelopeBuildInput,
): PromptEnvelope {
  const slots: PromptSlot[] = [
    slot("system_core", SYSTEM_CORE_UPDATE_V1),
    slot("job_facts", JSON.stringify(input.jobFacts)),
    slot("existing_files", JSON.stringify(serializeExistingFiles(input.existingFiles))),
    slot("pruned_spec", JSON.stringify(input.prunedSpec)),
    slot("project_tokens", JSON.stringify(input.projectTokens)),
    slot("token_resolver", JSON.stringify(input.tokenResolver)),
    slot("registry_hints", JSON.stringify(input.registryHints)),
    slot("example_styles", input.exampleStyles),
    slot("output_contract", OUTPUT_CONTRACT_UPDATE_V1),
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

function serializeExistingFiles(input: ExistingFilesSlot) {
  return {
    componentName: input.componentName,
    files: input.files.map((file) => ({
      path: file.path,
      role: file.role,
      content: file.content,
    })),
    relatedModules: (input.relatedModules ?? []).map((file) => ({
      path: file.path,
      role: file.role,
      content: file.content,
    })),
    truncated: input.truncated ?? false,
  };
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
    "existing_files",
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
