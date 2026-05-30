import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  FilePatch,
  GateResult,
  JobIntent,
  PrunedSpec,
  ProjectTokensSummary,
  QaReport,
  ResolvedComponentFile,
  SyncConfig,
} from "@fig2code/spec";
import { resolvePrunedSpecTokens } from "@fig2code/repo";
import { normalizeGeneratedStyleClasses } from "./preview.js";
import {
  buildComponentEnvelope,
  buildComponentUpdateEnvelope,
  buildRepairEnvelope,
} from "@fig2code/prompts";
import {
  createLlmProviderForModel,
  parseCodegenOutput,
  type LLMProvider,
} from "@fig2code/llm";
import { findSyntaxIssues, formatIssuesForLlm } from "./syntax-check.js";
import {
  formatChangeSummaryText,
  normalizeChangeSummary,
} from "./change-summary.js";
import {
  appendExportPatchToFile,
  ensureCodegenScaffolds,
  finalizeBarrelExportPatches,
  isAppendExportPatch,
  planCodegenFiles,
  sanitizeUpdateBarrelPatches,
  buildPackageIndexAppendPatch,
} from "./scaffold.js";
import { formatChangedPatches, type FormatPatchContext } from "./format-patches.js";
import type { CodegenChangeSummary } from "@fig2code/spec";

const execFileAsync = promisify(execFile);

export interface ExistingFilesContext {
  componentName: string;
  files: ResolvedComponentFile[];
  relatedModules?: ResolvedComponentFile[];
  truncated?: boolean;
}

export interface CodegenContext {
  syncConfig: SyncConfig;
  prunedSpec: PrunedSpec;
  projectTokens: ProjectTokensSummary | Record<string, unknown>;
  tokenResolver: Record<string, string>;
  registryHints: Record<string, string>;
  exampleStyles: string;
  apiKey: string;
  llmProvider?: LLMProvider;
  intent?: JobIntent;
  existingFiles?: ExistingFilesContext;
  formatContext?: FormatPatchContext;
}

export interface CodegenRunResult {
  patches: FilePatch[];
  envelopeTokens: number;
  summary?: string;
  changeSummary?: CodegenChangeSummary;
}

export async function runCodegen(context: CodegenContext): Promise<CodegenRunResult> {
  const modelId = context.syncConfig.llm?.modelId ?? "anthropic/claude-sonnet";
  const isUpdate = context.intent === "component-update" && Boolean(context.existingFiles);

  const filePlan = planCodegenFiles(context.syncConfig, context.prunedSpec.name);

  const resolvedSpec = resolvePrunedSpecTokens(context.prunedSpec, context.tokenResolver, {
    styleSystem: context.syncConfig.web?.styleSystem,
    tokenCatalog: context.syncConfig.tokens?.catalog,
  });

  const baseInput = {
    modelId,
    prunedSpec: resolvedSpec,
    projectTokens: context.projectTokens,
    tokenResolver: context.tokenResolver,
    registryHints: context.registryHints,
    exampleStyles: context.exampleStyles,
    envelopeBudget: context.syncConfig.llm?.envelopeBudget?.estimatedTokensSoft,
  };

  const envelope = isUpdate
    ? buildComponentUpdateEnvelope({
        ...baseInput,
        profile: "component-update-v1",
        jobFacts: {
          intent: "component-update",
          targets: context.syncConfig.platforms,
          conventions: context.syncConfig.conventions,
          componentName: context.existingFiles!.componentName,
          primaryComponentPath:
            context.existingFiles!.files.find((file) => file.role === "component")?.path,
          storyPath: context.existingFiles!.files.find((file) => file.role === "story")?.path,
          testPath: context.existingFiles!.files.find((file) => file.role === "test")?.path,
          barrelPath:
            context.existingFiles!.files.find((file) => file.role === "barrel")?.path ??
            context.existingFiles!.files.find(
              (file) => file.role === "related" && file.path.endsWith("/index.ts"),
            )?.path,
          packageIndexPath: (() => {
            const componentPath = context.existingFiles!.files.find(
              (file) => file.role === "component",
            )?.path;
            return componentPath
              ? planCodegenFiles(
                  context.syncConfig,
                  context.existingFiles!.componentName,
                  componentPath,
                ).packageIndexPath
              : undefined;
          })(),
          packageIndexPatchExample: (() => {
            const componentPath = context.existingFiles!.files.find(
              (file) => file.role === "component",
            )?.path;
            if (!componentPath) {
              return undefined;
            }
            const plan = planCodegenFiles(
              context.syncConfig,
              context.existingFiles!.componentName,
              componentPath,
            );
            return plan.packageIndexPath
              ? buildPackageIndexAppendPatch(plan)
              : undefined;
          })(),
          ...(context.syncConfig.llm?.notes
            ? { teamNotes: context.syncConfig.llm.notes }
            : {}),
        },
        existingFiles: context.existingFiles!,
      })
    : buildComponentEnvelope({
        ...baseInput,
        profile: "component-v1",
        jobFacts: {
          intent: "component",
          targets: context.syncConfig.platforms,
          conventions: context.syncConfig.conventions,
          componentName: context.prunedSpec.name,
          expectedFiles: {
            ...filePlan,
            packageIndexPatchExample: filePlan.packageIndexPath
              ? buildPackageIndexAppendPatch(filePlan)
              : undefined,
          },
          ...(context.syncConfig.llm?.notes
            ? { teamNotes: context.syncConfig.llm.notes }
            : {}),
        },
      });

  const provider = context.llmProvider ?? createLlmProviderForModel(modelId);
  const raw = await provider.complete({ envelope, apiKey: context.apiKey });
  let output: Awaited<ReturnType<typeof parseCodegenOutput>>;
  try {
    output = parseCodegenOutput(raw);
  } catch (parseError) {
    const repairEnvelope = buildRepairEnvelope(envelope, {
      attempt: 1,
      gateName: "json-parse",
      gateExitCode: 1,
      truncatedStderr: buildJsonParseRepairInstructions(parseError, raw),
    });
    const repaired = await provider.complete({
      envelope: repairEnvelope,
      apiKey: context.apiKey,
    });
    output = parseCodegenOutput(repaired);
  }
  let bestOutput = output;
  let bestIssues = findSyntaxIssues(output.patches);

  const MAX_REPAIR_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS && bestIssues.length > 0; attempt += 1) {
    const repairEnvelope = buildRepairEnvelope(envelope, {
      attempt,
      gateName: "preview-syntax",
      gateExitCode: 1,
      truncatedStderr: buildSyntaxRepairInstructions(bestIssues, attempt),
      lastPatchSummary: {
        patchCount: bestOutput.patches.length,
        firstPath: bestOutput.patches[0]?.path,
      },
    });
    const repaired = await provider.complete({
      envelope: repairEnvelope,
      apiKey: context.apiKey,
    });
    const repairedOutput = parseCodegenOutput(repaired);
    const repairedIssues = findSyntaxIssues(repairedOutput.patches);
    if (repairedIssues.length < bestIssues.length) {
      bestOutput = repairedOutput;
      bestIssues = repairedIssues;
    }
    if (bestIssues.length === 0) break;
  }

  output = {
    ...bestOutput,
    patches: await formatChangedPatches(normalizeCodegenPatches(bestOutput.patches, context), {
      formatter: context.syncConfig.conventions.formatter ?? "auto",
      ...context.formatContext,
      existingFiles:
        context.formatContext?.existingFiles ??
        context.existingFiles?.files.map((file) => ({
          path: file.path,
          content: file.content,
        })),
    }),
  };

  const changeSummary = isUpdate ? normalizeChangeSummary(output) : null;
  let summary =
    bestIssues.length > 0
      ? appendUnresolvedIssuesSummary(output.summary, bestIssues)
      : output.summary;
  if (!summary && changeSummary) {
    summary = formatChangeSummaryText(changeSummary);
  }

  return {
    patches: output.patches,
    envelopeTokens: envelope.estimatedTotalTokens ?? 0,
    summary,
    changeSummary: changeSummary ?? undefined,
  };
}

function buildJsonParseRepairInstructions(parseError: unknown, raw: string): string {
  const detail = parseError instanceof Error ? parseError.message : String(parseError);
  const excerpt = raw.length > 1800 ? `${raw.slice(0, 1800)}\n...[truncated]` : raw;
  return `Your previous response was not valid JSON (${detail}).

Re-emit ONLY one complete JSON object matching output_contract — no markdown fences or prose.
- Escape quotes, backslashes, and newlines inside every patch "content" string (\\", \\\\, \\n).
- Emit ONLY files that changed; omit unchanged story/test/barrel files unless they need edits.
- Do not truncate mid-string — finish the JSON object even when patch content is large.

Broken output (for reference):
${excerpt}`;
}

function buildSyntaxRepairInstructions(
  issues: ReturnType<typeof findSyntaxIssues>,
  attempt: number,
): string {
  const prefix = attempt === 1
    ? "Your previous output failed JS/TS/JSX parsing in our in-plugin Babel preview compiler. The job will be rejected unless you fix it."
    : "Your previous repair attempt STILL did not parse. This is your last chance. Re-emit the FULL JSON patch list with every issue below fixed.";

  return `${prefix}

How to think about this:
- The preview iframe runs each component file through @babel/parser with the TypeScript and JSX plugins. The file must parse.
- The most common slip is dropping the colon between a destructured param list and its inline type:
    BAD:  function Foo({ a, b }{ c?: number }) { ... }
    GOOD: function Foo({ a, b }: { a: T; b: T; c?: number }) { ... }
  Better still — don't use inline destructured types at all:
    GOOD: interface FooProps { a: T; b: T; c?: number; }
          function Foo(props: FooProps) { const { a, b, c } = props; ... }
- Re-emit the FULL JSON patch list (every file you intended to change), not just the one with the bug.
- Do NOT add new files; keep paths and \`action\` values consistent with the previous output.
- Keep design tokens / class strings / behaviour identical; only fix the parse error.

Parse errors to fix:
${formatIssuesForLlm(issues)}`;
}

function normalizeCodegenPatches(
  patches: FilePatch[],
  context: CodegenContext,
): FilePatch[] {
  const tokenCss = context.syncConfig.tokens?.sourceExcerpt;
  const catalog = context.syncConfig.tokens?.catalog;

  const normalized = patches.map((patch) => {
    if (!patch.content) {
      return patch;
    }
    return {
      ...patch,
      content: normalizeGeneratedStyleClasses(patch.content, tokenCss, catalog),
    };
  });

  const sanitized = sanitizeUpdateBarrelPatches(normalized, {
    intent: context.intent,
    existingFiles: context.existingFiles,
    syncConfig: context.syncConfig,
    componentName: context.prunedSpec.name,
  });

  const scaffolded = ensureCodegenScaffolds(
    sanitized,
    context.syncConfig,
    context.prunedSpec,
    context.existingFiles,
  );

  return finalizeBarrelExportPatches(scaffolded, {
    existingFiles: context.existingFiles,
    componentName: context.prunedSpec.name,
  });
}

function appendUnresolvedIssuesSummary(
  summary: string | undefined,
  issues: ReturnType<typeof findSyntaxIssues>,
): string {
  const lead =
    "Preview may show a Babel compile error — the model could not produce parseable code after repair attempts. Edit the file in the code panel and rebuild to clear it.";
  const details = formatIssuesForLlm(issues);
  return summary ? `${summary}\n\n${lead}\n${details}` : `${lead}\n${details}`;
}

export async function applyPatches(workspaceRoot: string, patches: FilePatch[]): Promise<void> {
  for (const patch of patches) {
    const abs = join(workspaceRoot, patch.path);

    if (patch.action === "delete") {
      await rm(abs, { force: true });
      continue;
    }

    if (patch.content && isAppendExportPatch(patch.content)) {
      await appendExportPatchToFile(abs, patch.content);
      continue;
    }

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, patch.content ?? "", "utf8");
  }
}

export interface GateRunnerOptions {
  workspaceRoot: string;
  maxRetries?: number;
}

export async function runQualityGates(options: GateRunnerOptions): Promise<QaReport> {
  const { workspaceRoot } = options;
  const gates: GateResult[] = [];

  gates.push(await runGate("tsc", workspaceRoot, "npx", ["tsc", "--noEmit"]));
  gates.push(await runGate("eslint", workspaceRoot, "npx", ["eslint", ".", "--max-warnings=0"]));

  const passed = gates.every((g) => g.passed);

  return {
    jobId: "local",
    gates,
    retriesUsed: 0,
    passed,
    generatedAt: new Date().toISOString(),
  };
}

async function runGate(
  name: string,
  cwd: string,
  cmd: string,
  args: string[],
): Promise<GateResult> {
  const started = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      env: process.env,
    });

    return {
      name,
      passed: true,
      exitCode: 0,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };

    return {
      name,
      passed: false,
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: truncate(err.stdout ?? ""),
      stderr: truncate(err.stderr ?? err.message),
      durationMs: Date.now() - started,
    };
  }
}

function truncate(text: string, max = 4_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated]`;
}

export function formatQaMarkdown(report: QaReport): string {
  const lines = [
    "## Fig2Code QA Summary",
    "",
    `**Overall:** ${report.passed ? "PASSED" : "FAILED"}`,
    `**Retries used:** ${report.retriesUsed}`,
    "",
    "| Gate | Result | Duration |",
    "| --- | --- | --- |",
  ];

  for (const gate of report.gates) {
    lines.push(
      `| ${gate.name} | ${gate.passed ? "✓" : "✗"} | ${gate.durationMs ?? "—"}ms |`,
    );
  }

  const failed = report.gates.filter((g) => !g.passed);
  if (failed.length > 0) {
    lines.push("", "### stderr excerpts");
    for (const gate of failed) {
      lines.push("", `**${gate.name}**`, "```", gate.stderr ?? "", "```");
    }
  }

  return lines.join("\n");
}
