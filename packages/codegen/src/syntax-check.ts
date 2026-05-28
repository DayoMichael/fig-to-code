import { parse } from "@babel/parser";
import type { FilePatch } from "@fig2code/spec";

export interface SyntaxIssue {
  path: string;
  line?: number;
  column?: number;
  message: string;
  snippet?: string;
}

const CHECKABLE_EXT_RE = /\.(tsx|jsx|ts|mts|cts|js|mjs|cjs)$/i;
const SNIPPET_RADIUS = 3;

/**
 * Parse every patch with @babel/parser using a TS+JSX-friendly config.
 * Returns the issues we should send back to the LLM for repair. Empty array
 * means the LLM output is syntactically clean.
 */
export function findSyntaxIssues(patches: FilePatch[]): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];

  for (const patch of patches) {
    if (patch.action === "delete") continue;
    if (!patch.content) continue;
    if (!CHECKABLE_EXT_RE.test(patch.path)) continue;

    try {
      parse(patch.content, {
        sourceType: "module",
        errorRecovery: false,
        allowImportExportEverywhere: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        plugins: [
          "jsx",
          "typescript",
          "decorators-legacy",
          "classProperties",
          "topLevelAwait",
        ],
      });
    } catch (error) {
      const err = error as Error & {
        loc?: { line: number; column: number };
      };
      const line = err.loc?.line;
      const column = err.loc?.column;
      issues.push({
        path: patch.path,
        line,
        column,
        message: err.message,
        snippet: extractSnippet(patch.content, line),
      });
    }
  }

  return issues;
}

function extractSnippet(content: string, line?: number): string | undefined {
  if (!line || line < 1) return undefined;
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, line - 1 - SNIPPET_RADIUS);
  const end = Math.min(lines.length, line + SNIPPET_RADIUS);
  const width = String(end).length;
  return lines
    .slice(start, end)
    .map((text, i) => {
      const lineNum = start + i + 1;
      const prefix = lineNum === line ? ">" : " ";
      return `${prefix} ${String(lineNum).padStart(width, " ")} | ${text}`;
    })
    .join("\n");
}

export function formatIssuesForLlm(issues: SyntaxIssue[]): string {
  return issues
    .map((issue) => {
      const where =
        issue.line !== undefined
          ? `${issue.path}:${issue.line}:${issue.column ?? 0}`
          : issue.path;
      const snippet = issue.snippet ? `\n${issue.snippet}` : "";
      return `- ${where} — ${issue.message}${snippet}`;
    })
    .join("\n");
}
