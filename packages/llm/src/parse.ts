import type { CodegenOutput, FilePatch } from "@fig2code/spec";

const JSON_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;
const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** Fix common LLM JSON mistakes such as `\d`, `\w`, or Windows paths in patch content. */
export function repairInvalidJsonEscapes(source: string): string {
  let out = "";
  let inString = false;
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;

    if (!inString) {
      out += char;
      if (char === '"') {
        inString = true;
      }
      index += 1;
      continue;
    }

    if (char === "\\") {
      const next = source[index + 1];

      if (next === undefined) {
        out += "\\\\";
        index += 1;
        continue;
      }

      if (next === "u") {
        const hex = source.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += source.slice(index, index + 6);
          index += 6;
          continue;
        }
        out += "\\\\";
        index += 1;
        continue;
      }

      if (VALID_JSON_ESCAPES.has(next)) {
        out += char + next;
        index += 2;
        continue;
      }

      out += "\\\\";
      index += 1;
      continue;
    }

    out += char;
    if (char === '"') {
      inString = false;
    }
    index += 1;
  }

  return out;
}

function parseJsonObject(json: string): CodegenOutput {
  try {
    return JSON.parse(json) as CodegenOutput;
  } catch (firstError) {
    try {
      return JSON.parse(repairInvalidJsonEscapes(json)) as CodegenOutput;
    } catch {
      throw firstError;
    }
  }
}

/** Walk from `{` and return the matching `}` object slice, respecting JSON strings. */
export function extractBalancedJsonObject(source: string, openBraceIndex: number): string | null {
  if (source[openBraceIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let index = openBraceIndex;

  while (index < source.length) {
    const char = source[index]!;

    if (inString) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      index += 1;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex, index + 1);
      }
    }

    index += 1;
  }

  return null;
}

export function formatCodegenParseError(error: unknown, rawLength?: number): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/Unterminated string|Unterminated JSON|Unexpected end of JSON input|Expected .* in JSON/i.test(detail)) {
    const sizeHint = rawLength ? ` (${rawLength} chars received)` : "";
    return [
      "The model returned invalid or truncated JSON.",
      detail,
      `This usually means the codegen response was cut off or had unescaped quotes/newlines inside a patch${sizeHint}.`,
      "Try Update with Figma again; for large components, simplify the selection or ask for a smaller change.",
    ].join(" ");
  }
  return detail;
}

function locateCodegenJsonCandidate(raw: string): string {
  const trimmed = raw.trim();

  try {
    parseJsonObject(trimmed);
    return trimmed;
  } catch {
    // fall through
  }

  const fenced = JSON_FENCE_RE.exec(trimmed);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    try {
      parseJsonObject(inner);
      return inner;
    } catch {
      const start = inner.indexOf("{");
      if (start !== -1) {
        const balanced = extractBalancedJsonObject(inner, start);
        if (balanced) {
          return balanced;
        }
      }
    }
  }

  const start = trimmed.indexOf("{");
  if (start !== -1) {
    const balanced = extractBalancedJsonObject(trimmed, start);
    if (balanced) {
      return balanced;
    }
    throw new Error(
      `Unterminated JSON object in model output (${trimmed.length} chars received)`,
    );
  }

  throw new Error("Could not locate JSON object in model output");
}

export function extractCodegenJson(raw: string): string {
  return locateCodegenJsonCandidate(raw);
}

export function parseCodegenOutput(raw: string): CodegenOutput {
  try {
    const json = locateCodegenJsonCandidate(raw);
    const parsed = parseJsonObject(json);
    validateCodegenOutput(parsed);
    return parsed;
  } catch (error) {
    throw new Error(formatCodegenParseError(error, raw.length));
  }
}

export function validateCodegenOutput(output: CodegenOutput): void {
  if (!output || typeof output !== "object") {
    throw new Error("Invalid codegen output: expected object");
  }

  if (!Array.isArray(output.patches)) {
    throw new Error("Invalid codegen output: missing patches array");
  }

  for (const [index, patch] of output.patches.entries()) {
    validatePatch(patch, index);
  }

  if (output.summary !== undefined && typeof output.summary !== "string") {
    throw new Error("Invalid codegen output: summary must be a string");
  }

  if (output.changeSummary !== undefined) {
    validateChangeSummary(output.changeSummary);
  }
}

function validateChangeSummary(changeSummary: NonNullable<CodegenOutput["changeSummary"]>): void {
  if (!changeSummary || typeof changeSummary !== "object") {
    throw new Error("Invalid codegen output: changeSummary must be an object");
  }
  if (
    changeSummary.hasBreakingChanges !== undefined &&
    typeof changeSummary.hasBreakingChanges !== "boolean"
  ) {
    throw new Error("Invalid codegen output: changeSummary.hasBreakingChanges must be boolean");
  }
  if (!Array.isArray(changeSummary.changes)) {
    throw new Error("Invalid codegen output: changeSummary.changes must be an array");
  }
  for (const [index, item] of changeSummary.changes.entries()) {
    if (!item || typeof item !== "object" || typeof item.text !== "string" || !item.text.trim()) {
      throw new Error(`Invalid changeSummary.changes[${index}]: text is required`);
    }
    if (typeof item.breaking !== "boolean") {
      throw new Error(`Invalid changeSummary.changes[${index}]: breaking must be boolean`);
    }
    if (item.fix !== undefined && typeof item.fix !== "string") {
      throw new Error(`Invalid changeSummary.changes[${index}]: fix must be a string`);
    }
  }
}

function validatePatch(patch: FilePatch, index: number): void {
  if (!patch?.path?.trim()) {
    throw new Error(`Invalid patch at index ${index}: path is required`);
  }

  if (patch.action !== "create" && patch.action !== "update" && patch.action !== "delete") {
    throw new Error(`Invalid patch at index ${index}: unknown action "${String(patch.action)}"`);
  }

  if (patch.action !== "delete" && typeof patch.content !== "string") {
    throw new Error(`Invalid patch at index ${index}: content is required for ${patch.action}`);
  }
}
