import type { CodegenChangeItem, CodegenChangeSummary, CodegenOutput } from "@fig2code/spec";

const BREAKING_LINE_RE = /^\[(breaking)\]\s*/i;
const NON_BREAKING_LINE_RE = /^\[(non-breaking|nonbreaking)\]\s*/i;

const SUMMARY_VERB_SPLIT_RE =
  /\s+(?=(?:Added|Updated|Removed|Fixed|Changed|Renamed|Introduced|Replaced|Set|Moved|Adjusted|Counter|All|Deprecated|Aligned|Kept|Extended|Refactored|Normalized|Simplified)\b)/i;

/** Conservative heuristics — upgrade to breaking when the text suggests consumer risk. */
const LIKELY_BREAKING_PATTERNS: RegExp[] = [
  /\b(removed?|removing|deleted?|deleting|dropped?|dropping|eliminated?)\b/i,
  /\b(renamed?|renaming)\b/i,
  /\b(replaced)\b.+\bwith\b/i,
  /\b(changed?|changing|updated?|updating)\s+(the\s+)?default/i,
  /\bdefault(s)?\s+(changed|updated|is now|from|to)\b/i,
  /\b(now\s+)?required\b/i,
  /\b(made|is|became)\s+required\b/i,
  /\boptional\s+(to|→|->)\s+required\b/i,
  /\bno longer\b/i,
  /\bdeprecated?\b/i,
  /\b(behaviou?r)\s+(changed|change|differs)\b/i,
  /\b(export|exported)\s+(removed|changed|renamed|dropped)\b/i,
  /\bremoved\s+variant\b/i,
  /\bvariant(s)?\s+.*\b(removed|renamed|changed|dropped|replaced)\b/i,
  /\bprop(s)?\s+.*\b(removed|renamed|changed|narrowed|retyped|replaced|dropped)\b/i,
  /\b(narrowed|stricter|restricted|tightened)\b/i,
  /\btype(s)?\s+(changed|narrowed|stricter|tightened|updated)\b/i,
  /\b(signature|signatures)\s+(changed|change|updated)\b/i,
  /\b(slot|slots|children|sub-?component(s)?)\s+.*\b(removed|renamed|changed|required)\b/i,
  /\b(cva|className|class\s+name)\s+.*\b(removed|renamed|changed|key)\b/i,
  /\bvariant\s+key(s)?\b/i,
  /\b(breaking)\b/i,
  /\bpublic\s+api\b/i,
  /\b(instead\s+of|rather\s+than)\b/i,
  /\bfrom\s+['"`][\w-]+['"`]\s+to\s+['"`][\w-]+['"`]\b/i,
];

export function inferBreakingFromText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return LIKELY_BREAKING_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function inferFixFromText(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return "Search the repo for usages and update call sites before merging.";
  }

  const renameMatch = normalized.match(
    /\brenamed?\s+(?:prop(?:erty)?|variant|export|slot|key)?\s*['"`]?([\w-]+)['"`]?\s+to\s+['"`]?([\w-]+)['"`]?/i,
  );
  if (renameMatch) {
    return `Update call sites: rename \`${renameMatch[1]}\` to \`${renameMatch[2]}\`.`;
  }

  const fromToMatch = normalized.match(/\bfrom\s+['"`]?([\w-]+)['"`]?\s+to\s+['"`]?([\w-]+)['"`]?/i);
  if (fromToMatch && /\b(prop|variant|export|default|key|size|type)\b/i.test(normalized)) {
    return `Update call sites: replace \`${fromToMatch[1]}\` with \`${fromToMatch[2]}\`.`;
  }

  if (/\b(replaced)\b.+\bwith\b/i.test(normalized)) {
    return "Update every call site to match the new API shape before upgrading.";
  }

  if (/\b(removed?|deleted?|dropped?)\s+(?:prop(?:erty)?|variant|export|slot)\s+['"`]?([\w-]+)['"`]?/i.test(normalized)) {
    const removed = normalized.match(
      /\b(removed?|deleted?|dropped?)\s+(?:prop(?:erty)?|variant|export|slot)\s+['"`]?([\w-]+)['"`]?/i,
    );
    if (removed?.[2]) {
      return `Remove or replace usages of \`${removed[2]}\` before upgrading.`;
    }
    return "Remove or replace usages of the dropped API before upgrading.";
  }

  if (/\bremoved\s+variant\b/i.test(normalized) || /\bvariant(s)?\s+.*\b(removed|dropped)\b/i.test(normalized)) {
    return "Replace the removed variant with a supported alternative at each call site.";
  }

  if (/\bdefault(s)?\s+(changed|updated|is now|from|to)\b/i.test(normalized) || /\b(changed?|changing)\s+(the\s+)?default/i.test(normalized)) {
    return "Pass the prop explicitly at call sites that relied on the previous default.";
  }

  if (/\b(now\s+)?required\b/i.test(normalized) || /\b(made|is|became)\s+required\b/i.test(normalized)) {
    const prop = normalized.match(/\bprop(?:erty)?\s+['"`]?([\w-]+)['"`]?/i);
    if (prop?.[1]) {
      return `Ensure all call sites pass \`${prop[1]}\`.`;
    }
    return "Ensure all call sites supply the newly required prop.";
  }

  if (/\b(narrowed|stricter|restricted|tightened)\b/i.test(normalized) || /\btype(s)?\s+(changed|narrowed|stricter)/i.test(normalized)) {
    return "Audit call sites for values outside the new type and update them.";
  }

  if (/\b(behaviou?r)\s+(changed|change)\b/i.test(normalized)) {
    return "Verify affected flows and update tests or call sites that depend on the old behaviour.";
  }

  if (/\b(export|exported)\s+(removed|changed|renamed|dropped)\b/i.test(normalized)) {
    return "Update imports and re-exports that reference the changed public API.";
  }

  return "Search the repo for usages and update call sites before merging.";
}

export function applyConservativeBreakingFlags(
  items: CodegenChangeItem[],
): CodegenChangeItem[] {
  return items.map((item) => ({
    ...item,
    breaking: item.breaking || inferBreakingFromText(item.text),
  }));
}

export function ensureBreakingFixes(items: CodegenChangeItem[]): CodegenChangeItem[] {
  return items.map((item) => {
    if (!item.breaking) return item;
    const fix = item.fix?.trim() || inferFixFromText(item.text);
    return { ...item, fix };
  });
}

export function splitSummaryIntoLines(summary: string): string[] {
  const text = summary.trim();
  if (!text) return [];

  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    return lines.map((line) =>
      line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim(),
    );
  }

  const verbSplit = text
    .split(SUMMARY_VERB_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean);
  if (verbSplit.length > 1) {
    return verbSplit;
  }

  if (text.includes(";")) {
    const parts = text
      .split(/;\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      return parts.map((part) =>
        /[.!?]$/.test(part) ? part : `${part.replace(/[.,]$/, "")}.`,
      );
    }
  }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length > 1) {
    return sentences;
  }

  return [text];
}

function parseLineBreakingFlag(line: string): { text: string; breaking?: boolean } {
  if (BREAKING_LINE_RE.test(line)) {
    return { text: line.replace(BREAKING_LINE_RE, "").trim(), breaking: true };
  }
  if (NON_BREAKING_LINE_RE.test(line)) {
    return { text: line.replace(NON_BREAKING_LINE_RE, "").trim(), breaking: false };
  }
  return { text: line.trim() };
}

function normalizeChangeItems(raw: unknown): CodegenChangeItem[] {
  if (!Array.isArray(raw)) return [];

  const items: CodegenChangeItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const text = "text" in entry && typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text) continue;
    items.push({
      text,
      breaking: Boolean((entry as { breaking?: unknown }).breaking),
      fix:
        "fix" in entry && typeof (entry as { fix?: unknown }).fix === "string"
          ? (entry as { fix: string }).fix.trim() || undefined
          : undefined,
    });
  }
  return items;
}

function finalizeChangeSummary(changes: CodegenChangeItem[]): CodegenChangeSummary {
  const normalized = ensureBreakingFixes(applyConservativeBreakingFlags(changes));
  return {
    hasBreakingChanges: normalized.some((item) => item.breaking),
    changes: normalized,
  };
}

/** Normalize LLM output into a structured changelog (with summary fallback). */
export function normalizeChangeSummary(
  output: Pick<CodegenOutput, "summary" | "changeSummary">,
): CodegenChangeSummary | null {
  const structuredItems = normalizeChangeItems(output.changeSummary?.changes);
  if (structuredItems.length > 0) {
    return finalizeChangeSummary(structuredItems);
  }

  if (!output.summary?.trim()) {
    return null;
  }

  const parsed = splitSummaryIntoLines(output.summary).map((line) => {
    const { text, breaking } = parseLineBreakingFlag(line);
    const explicitBreaking = breaking ?? false;
    return {
      text,
      breaking: explicitBreaking || inferBreakingFromText(text),
    };
  });

  if (parsed.length === 0) {
    return null;
  }

  return finalizeChangeSummary(parsed);
}

export function formatChangeSummaryText(summary: CodegenChangeSummary): string {
  return summary.changes
    .map((item) => {
      const prefix = item.breaking ? "[breaking] " : "";
      const fix = item.breaking && item.fix ? ` — Fix: ${item.fix}` : "";
      return `${prefix}${item.text}${fix}`;
    })
    .join("\n");
}
