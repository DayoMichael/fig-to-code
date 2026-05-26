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

export function extractCodegenJson(raw: string): string {
  const trimmed = raw.trim();

  try {
    parseJsonObject(trimmed);
    return trimmed;
  } catch {
    // fall through
  }

  const fenced = JSON_FENCE_RE.exec(trimmed);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("Could not locate JSON object in model output");
}

export function parseCodegenOutput(raw: string): CodegenOutput {
  const json = extractCodegenJson(raw);
  const parsed = parseJsonObject(json);
  validateCodegenOutput(parsed);
  return parsed;
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
