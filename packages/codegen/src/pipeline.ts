import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FilePatch, GateResult, PrunedSpec, ProjectTokensSummary, QaReport, SyncConfig } from "@fig2code/spec";
import { resolvePrunedSpecTokens } from "@fig2code/repo";
import { buildComponentEnvelope } from "@fig2code/prompts";
import {
  createLlmProviderForModel,
  parseCodegenOutput,
  type LLMProvider,
} from "@fig2code/llm";

const execFileAsync = promisify(execFile);

export interface CodegenContext {
  syncConfig: SyncConfig;
  prunedSpec: PrunedSpec;
  projectTokens: ProjectTokensSummary | Record<string, unknown>;
  tokenResolver: Record<string, string>;
  registryHints: Record<string, string>;
  exampleStyles: string;
  apiKey: string;
  llmProvider?: LLMProvider;
}

export interface CodegenRunResult {
  patches: FilePatch[];
  envelopeTokens: number;
  summary?: string;
}

export async function runCodegen(context: CodegenContext): Promise<CodegenRunResult> {
  const modelId = context.syncConfig.llm?.modelId ?? "anthropic/claude-sonnet";
  const profile = (context.syncConfig.llm?.promptProfile ?? "component-v1") as "component-v1";

  const resolvedSpec = resolvePrunedSpecTokens(context.prunedSpec, context.tokenResolver, {
    styleSystem: context.syncConfig.web?.styleSystem,
    tokenCatalog: context.syncConfig.tokens?.catalog,
  });

  const envelope = buildComponentEnvelope({
    profile,
    modelId,
    jobFacts: {
      intent: "component",
      targets: context.syncConfig.platforms,
      conventions: context.syncConfig.conventions,
      ...(context.syncConfig.llm?.notes
        ? { teamNotes: context.syncConfig.llm.notes }
        : {}),
    },
    prunedSpec: resolvedSpec,
    projectTokens: context.projectTokens,
    tokenResolver: context.tokenResolver,
    registryHints: context.registryHints,
    exampleStyles: context.exampleStyles,
    envelopeBudget: context.syncConfig.llm?.envelopeBudget?.estimatedTokensSoft,
  });

  const provider = context.llmProvider ?? createLlmProviderForModel(modelId);
  const raw = await provider.complete({ envelope, apiKey: context.apiKey });
  const output = parseCodegenOutput(raw);

  return {
    patches: output.patches,
    envelopeTokens: envelope.estimatedTotalTokens ?? 0,
    summary: output.summary,
  };
}

export async function applyPatches(workspaceRoot: string, patches: FilePatch[]): Promise<void> {
  for (const patch of patches) {
    const abs = join(workspaceRoot, patch.path);

    if (patch.action === "delete") {
      await rm(abs, { force: true });
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
