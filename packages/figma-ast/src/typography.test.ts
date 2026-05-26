import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TypographyCatalog } from "@fig2code/spec";
import { matchTypographyToTokens } from "./typography.js";

describe("matchTypographyToTokens", () => {
  const catalog: TypographyCatalog = {
    fontPaths: ["src/styles/typography.css"],
    families: {
      body: "Inter, sans-serif",
    },
    scales: [
      { name: "sm", usage: "text-sm", fontSize: 14 },
      { name: "semibold", usage: "font-semibold", fontWeight: 600, fontSize: 14 },
      { name: "body", usage: "font-body", fontFamily: "Inter" },
    ],
  };

  it("maps figma text styles to setup typography tokens", () => {
    const tokens = matchTypographyToTokens(
      {
        fontSize: 14,
        fontWeight: 600,
        fontFamily: "Inter",
      },
      catalog,
    );

    assert.equal(tokens.fontSize, "token:typography/sm");
    assert.equal(tokens.fontWeight, "token:typography/semibold");
    assert.equal(tokens.fontFamily, "token:typography/body");
  });

  it("maps css-only font families to typography/family tokens", () => {
    const tokens = matchTypographyToTokens(
      { fontFamily: "Roboto" },
      {
        fontPaths: ["src/styles/typography.css"],
        families: { display: "Roboto, sans-serif" },
        scales: [],
      },
    );

    assert.equal(tokens.fontFamily, "token:typography/family/display");
  });

  it("falls back to raw tokens when no catalog is configured", () => {
    const tokens = matchTypographyToTokens(
      {
        fontSize: 18,
        fontWeight: 500,
        fontFamily: "Roboto",
      },
      undefined,
    );

    assert.equal(tokens.fontSize, "token:typography/raw/18px");
    assert.equal(tokens.fontWeight, "token:typography/raw/500");
  });
});
