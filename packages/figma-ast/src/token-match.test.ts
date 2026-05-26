import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchColorToToken,
  matchSpacingToToken,
  matchRadiusToToken,
  normalizeColorTokenName,
} from "./token-match.js";

describe("matchColorToToken", () => {
  it("uses the figma variable name directly when provided", () => {
    const token = matchColorToToken(
      { r: 1, g: 0.867, b: 0.322 },
      undefined,
      "color-bg-state-info-default",
    );
    assert.equal(token, "token:color/color-bg-state-info-default");
  });

  it("normalizes slashes in variable names", () => {
    const token = matchColorToToken(
      { r: 1, g: 0.867, b: 0.322 },
      undefined,
      "color/bg-accent-yellow-default",
    );
    assert.equal(token, "token:color/color-bg-accent-yellow-default");
  });

  it("falls back to raw rgb when no variable is bound", () => {
    const token = matchColorToToken({ r: 1, g: 0.867, b: 0.322 });
    assert.equal(token, "token:color/raw/255-221-82");
  });
});

describe("matchSpacingToToken", () => {
  it("uses the figma variable name directly when provided", () => {
    const token = matchSpacingToToken(8, undefined, "2");
    assert.equal(token, "token:spacing/2");
  });

  it("uses variable names with paths", () => {
    const token = matchSpacingToToken(16, undefined, "4");
    assert.equal(token, "token:spacing/4");
  });

  it("falls back to raw px when no variable is bound", () => {
    const token = matchSpacingToToken(12);
    assert.equal(token, "token:spacing/raw/12px");
  });
});

describe("matchRadiusToToken", () => {
  it("uses the figma variable name directly when provided", () => {
    const token = matchRadiusToToken(8, undefined, "md");
    assert.equal(token, "token:radius/md");
  });

  it("falls back to raw px when no variable is bound", () => {
    const token = matchRadiusToToken(4);
    assert.equal(token, "token:radius/raw/4px");
  });
});

describe("normalizeColorTokenName", () => {
  it("replaces slashes with dashes", () => {
    assert.equal(normalizeColorTokenName("color/bg-accent-yellow-default"), "color-bg-accent-yellow-default");
  });

  it("lowercases and trims", () => {
    assert.equal(normalizeColorTokenName("  Color/BG-Primary  "), "color-bg-primary");
  });
});
