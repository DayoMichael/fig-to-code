import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyConservativeBreakingFlags,
  inferBreakingFromText,
  inferFixFromText,
  normalizeChangeSummary,
  splitSummaryIntoLines,
} from "./change-summary.js";

describe("change-summary", () => {
  it("normalizes structured changeSummary from the LLM", () => {
    const summary = normalizeChangeSummary({
      changeSummary: {
        hasBreakingChanges: true,
        changes: [
          { text: "Renamed prop bodyText to subtitle", breaking: true },
          { text: "Added optional showSubtitle prop", breaking: false },
        ],
      },
    });

    assert.ok(summary);
    assert.equal(summary.hasBreakingChanges, true);
    assert.equal(summary.changes.length, 2);
    assert.equal(summary.changes[0]?.breaking, true);
    assert.equal(summary.changes[1]?.breaking, false);
  });

  it("upgrades misclassified non-breaking items using conservative heuristics", () => {
    const summary = normalizeChangeSummary({
      changeSummary: {
        hasBreakingChanges: false,
        changes: [
          { text: "Renamed variant Neutral to Subtle", breaking: false },
          { text: "Changed default size from md to sm", breaking: false },
          { text: "Added optional showSubtitle prop", breaking: false },
        ],
      },
    });

    assert.ok(summary);
    assert.equal(summary.hasBreakingChanges, true);
    assert.equal(summary.changes[0]?.breaking, true);
    assert.equal(summary.changes[1]?.breaking, true);
    assert.equal(summary.changes[2]?.breaking, false);
  });

  it("sets hasBreakingChanges from items even when the LLM flag is false", () => {
    const summary = normalizeChangeSummary({
      changeSummary: {
        hasBreakingChanges: false,
        changes: [{ text: "Removed deprecated size xl variant", breaking: true }],
      },
    });

    assert.ok(summary);
    assert.equal(summary.hasBreakingChanges, true);
  });

  it("parses [breaking] markers from legacy summary strings", () => {
    const summary = normalizeChangeSummary({
      summary: [
        "[breaking] Removed variant Neutral",
        "[non-breaking] Updated font class to font-suisse-intl",
      ].join("\n"),
    });

    assert.ok(summary);
    assert.equal(summary.hasBreakingChanges, true);
    assert.equal(summary.changes[0]?.breaking, true);
    assert.equal(summary.changes[1]?.breaking, false);
  });

  it("infers breaking from summary prose the LLM mislabeled", () => {
    const summary = normalizeChangeSummary({
      summary: "Replaced prop label with title across stories.",
    });

    assert.ok(summary);
    assert.equal(summary.hasBreakingChanges, true);
    assert.equal(summary.changes[0]?.breaking, true);
  });

  it("splits prose summaries into discrete changes", () => {
    const lines = splitSummaryIntoLines(
      "Added showSubtitle prop. Updated font class from font-body to font-suisse-intl.",
    );
    assert.equal(lines.length, 2);
  });

  it("inferBreakingFromText catches common slip patterns", () => {
    assert.equal(inferBreakingFromText("Removed variant Neutral"), true);
    assert.equal(inferBreakingFromText("Made subtitle prop required"), true);
    assert.equal(inferBreakingFromText("Added optional icon prop"), false);
  });

  it("applyConservativeBreakingFlags never downgrades explicit breaking", () => {
    const items = applyConservativeBreakingFlags([
      { text: "Adjusted internal spacing", breaking: true },
    ]);
    assert.equal(items[0]?.breaking, true);
  });

  it("adds fix guidance for breaking changes", () => {
    const summary = normalizeChangeSummary({
      changeSummary: {
        hasBreakingChanges: true,
        changes: [
          {
            text: "Renamed prop bodyText to subtitle",
            breaking: true,
            fix: "Rename bodyText to subtitle in consuming apps.",
          },
          { text: "Added optional icon prop", breaking: false },
        ],
      },
    });

    assert.ok(summary);
    assert.equal(summary.changes[0]?.fix, "Rename bodyText to subtitle in consuming apps.");
    assert.equal(summary.changes[1]?.breaking, false);
    assert.equal(summary.changes[1]?.fix, undefined);
  });

  it("infers fix text when the LLM omits it", () => {
    assert.match(
      inferFixFromText("Renamed prop bodyText to subtitle"),
      /rename `bodyText` to `subtitle`/i,
    );
  });
});
