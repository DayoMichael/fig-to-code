import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrunedSpec } from "@fig2code/spec";
import { resolvePrunedSpecTokens } from "./resolve-pruned-spec.js";

describe("resolvePrunedSpecTokens", () => {
  const resolver = {
    "color/text-primary": "text-primary",
    "typography/sm": "text-sm",
    "typography/semibold": "font-semibold",
    "typography/body": "font-body",
  };

  it("resolves color and typography tokens to tailwind classes in pruned_spec", () => {
    const spec: PrunedSpec = {
      name: "InlineAlert",
      kind: "component",
      typography: {
        title: {
          text: "token:color/text-primary",
          fontSize: "token:typography/sm",
          fontWeight: "token:typography/semibold",
          fontFamily: "token:typography/body",
        },
      },
      styles: {
        "warning+default": {
          bg: "token:color/surface-warning",
          text: "token:color/text-primary",
        },
      },
    };

    const resolved = resolvePrunedSpecTokens(
      {
        ...spec,
        styles: {
          "warning+default": {
            bg: "token:color/text-primary",
            text: "token:color/text-primary",
          },
        },
      },
      resolver,
      { styleSystem: "tailwind" },
    );

    assert.equal(resolved.typography?.title?.text, "text-text-primary");
    assert.equal(resolved.typography?.title?.fontSize, "text-sm");
    assert.equal(resolved.typography?.title?.fontWeight, "font-semibold");
    assert.equal(resolved.typography?.title?.fontFamily, "font-body");
    assert.equal(resolved.styles?.["warning+default"]?.bg, "bg-text-primary");
    assert.equal(resolved.styles?.["warning+default"]?.text, "text-text-primary");
  });

  it("resolves semantic bg tokens from figma variable names", () => {
    const resolved = resolvePrunedSpecTokens(
      {
        name: "InlineAlert",
        kind: "component",
        styles: {
          warning: {
            bg: "token:color/color-bg-accent-yellow-default",
          },
        },
      },
      {
        "color/color-bg-accent-yellow-default": "color-bg-accent-yellow-default",
      },
      { styleSystem: "tailwind" },
    );

    assert.equal(resolved.styles?.warning?.bg, "bg-color-bg-accent-yellow-default");
  });

  it("resolves raw rgb tokens via catalog hex lookup at codegen time", () => {
    const catalog = {
      sourcePath: "src/tokens/colors.css",
      format: "css-variables" as const,
      styleSystem: "tailwind" as const,
      entries: [
        {
          category: "color" as const,
          name: "color-bg-accent-yellow-default",
          usage: "color-bg-accent-yellow-default",
          value: "#ffdd52",
        },
      ],
    };

    const resolved = resolvePrunedSpecTokens(
      {
        name: "InlineAlert",
        kind: "component",
        styles: {
          warning: {
            bg: "token:color/raw/255-221-82",
          },
        },
      },
      {},
      { styleSystem: "tailwind", tokenCatalog: catalog },
    );

    assert.equal(resolved.styles?.warning?.bg, "bg-color-bg-accent-yellow-default");
  });

  it("never emits bg-raw classes for unresolved raw tokens", () => {
    const resolved = resolvePrunedSpecTokens(
      {
        name: "InlineAlert",
        kind: "component",
        styles: {
          warning: {
            bg: "token:color/raw/255-221-82",
          },
        },
      },
      {},
      { styleSystem: "tailwind" },
    );

    assert.equal(resolved.styles?.warning?.bg, "bg-[rgb(255,221,82)]");
    assert.doesNotMatch(resolved.styles?.warning?.bg ?? "", /bg-raw-/);
  });

  it("resolves spacing variable names to tailwind classes", () => {
    const resolved = resolvePrunedSpecTokens(
      {
        name: "Card",
        kind: "component",
        styles: {
          default: {
            padding: "token:spacing/2 token:spacing/4 token:spacing/2 token:spacing/4",
            gap: "token:spacing/3",
          },
        },
      },
      {},
      { styleSystem: "tailwind" },
    );

    assert.equal(resolved.styles?.default?.padding, "2 4 2 4");
    assert.equal(resolved.styles?.default?.gap, "gap-3");
  });

  it("resolves radius variable names to tailwind classes", () => {
    const resolved = resolvePrunedSpecTokens(
      {
        name: "Card",
        kind: "component",
        styles: {
          default: {
            radius: "token:radius/md",
          },
        },
      },
      {},
      { styleSystem: "tailwind" },
    );

    assert.equal(resolved.styles?.default?.radius, "rounded-md");
  });

  it("resolves color variable names directly without catalog", () => {
    const resolved = resolvePrunedSpecTokens(
      {
        name: "InlineAlert",
        kind: "component",
        styles: {
          info: {
            bg: "token:color/color-bg-state-info-default",
          },
        },
      },
      {},
      { styleSystem: "tailwind" },
    );

    assert.equal(resolved.styles?.info?.bg, "bg-color-bg-state-info-default");
  });
});
