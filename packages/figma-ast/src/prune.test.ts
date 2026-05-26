import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pruneNodeTree } from "./prune.js";
import type { FigmaNodeSnapshot } from "./snapshot.js";

describe("pruneNodeTree", () => {
  it("produces a minimal Button PrunedSpec from a component set snapshot", () => {
    const node: FigmaNodeSnapshot = {
      id: "1:234",
      name: "Button",
      type: "COMPONENT_SET",
      componentPropertyDefinitions: {
        Variant: { type: "VARIANT", variantOptions: ["primary", "secondary"] },
        Size: { type: "VARIANT", variantOptions: ["sm", "md"] },
      },
      cornerRadius: 8,
      paddingTop: 8,
      paddingRight: 16,
      paddingBottom: 8,
      paddingLeft: 16,
      fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }],
      children: [
        {
          id: "1:235",
          name: "Variant=primary, Size=md",
          type: "COMPONENT",
          variantValues: { variant: "primary", size: "md" },
          cornerRadius: 8,
          fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }],
          children: [
            {
              id: "1:236",
              name: "Label",
              type: "TEXT",
              characters: "Click me",
            },
          ],
        },
      ],
    };

    const spec = pruneNodeTree(node);

    assert.equal(spec.name, "Button");
    assert.deepEqual(spec.variants?.variant, ["primary", "secondary"]);
    assert.equal(spec.slots?.label?.type, "text");
    assert.ok(spec.styles?.["primary+md"]);
  });

  it("maps all Figma component property types generically", () => {
    const node: FigmaNodeSnapshot = {
      id: "2184:521",
      name: "Inline Alert",
      type: "COMPONENT_SET",
      componentPropertyDefinitions: {
        "Show Title#2184:0": { type: "BOOLEAN", defaultValue: true },
        "Title#2184:4": { type: "TEXT", defaultValue: "Alert title" },
        "Subtext#2184:8": { type: "TEXT", defaultValue: "Alert subtext" },
        "Swap Icon#2184:12": {
          type: "INSTANCE_SWAP",
          defaultValue: "abc123",
          preferredValues: [{ key: "abc123", name: "EtchCircleInfo" }],
        },
        Type: { type: "VARIANT", variantOptions: ["Warning", "Success", "Error", "Info", "Neutral"] },
      },
      children: [
        {
          id: "2184:522",
          name: "Type=Warning, Show Title=True",
          type: "COMPONENT",
          variantValues: { type: "Warning", showTitle: "True" },
          fills: [{ type: "SOLID", color: { r: 0.99, g: 0.97, b: 0.95 } }],
          cornerRadius: 5,
          layoutMode: "HORIZONTAL",
          itemSpacing: 8,
          paddingTop: 12,
          paddingRight: 16,
          paddingBottom: 12,
          paddingLeft: 16,
          children: [
            {
              id: "2184:523",
              name: "Swap Icon",
              type: "INSTANCE",
              mainComponent: { name: "EtchCircleInfo", key: "abc123" },
            },
            {
              id: "2184:524",
              name: "Title",
              type: "TEXT",
              characters: "Warning",
              typography: { fontSize: 14, fontWeight: 600, fontFamily: "Inter" },
              componentPropertyReferences: { "Title#2184:4": "characters" },
            },
          ],
        },
        {
          id: "2184:525",
          name: "Type=Success, Show Title=True",
          type: "COMPONENT",
          variantValues: { type: "Success", showTitle: "True" },
          fills: [{ type: "SOLID", color: { r: 0.9, g: 0.98, b: 0.92 } }],
          cornerRadius: 5,
        },
      ],
    };

    const spec = pruneNodeTree(node, {
      typography: {
        fontPaths: ["src/styles/typography.css"],
        families: { body: "Inter, sans-serif" },
        scales: [
          { name: "sm", usage: "text-sm", fontSize: 14 },
          { name: "semibold", usage: "font-semibold", fontWeight: 600, fontSize: 14 },
        ],
      },
    });

    assert.equal(spec.name, "InlineAlert");
    assert.deepEqual(spec.variants?.type, ["Warning", "Success", "Error", "Info", "Neutral"]);
    assert.equal(spec.props?.showTitle?.type, "boolean");
    assert.equal(spec.props?.title?.type, "text");
    assert.equal(spec.props?.subtext?.type, "text");
    assert.equal(spec.slots?.swapIcon?.type, "icon");
    assert.equal(spec.slots?.swapIcon?.componentKey, "abc123");
    assert.equal(spec.slots?.swapIcon?.componentName, "EtchCircleInfo");
    assert.equal(spec.slots?.title?.type, "text");
    assert.equal(spec.typography?.title?.fontSize, "token:typography/sm");
    assert.equal(spec.typography?.title?.fontWeight, "token:typography/semibold");
    assert.ok(spec.styles?.warning);
    assert.ok(spec.styles?.success);
    assert.equal(spec.styles?.warning?.layout, "horizontal");
    assert.ok(spec.layout?.children?.length);
  });

  it("maps bound figma color variables to repo token names", () => {
    const node: FigmaNodeSnapshot = {
      id: "1:1",
      name: "Inline Alert",
      type: "COMPONENT_SET",
      componentPropertyDefinitions: {
        Type: { type: "VARIANT", variantOptions: ["Warning"] },
      },
      children: [
        {
          id: "1:2",
          name: "Type=Warning",
          type: "COMPONENT",
          variantValues: { type: "Warning" },
          fills: [
            {
              type: "SOLID",
              color: { r: 1, g: 0.867, b: 0.322 },
              colorToken: "color-bg-accent-yellow-default",
            },
          ],
        },
      ],
    };

    const spec = pruneNodeTree(node, {
      tokenCatalog: {
        sourcePath: "src/tokens/colors.css",
        format: "css-variables",
        styleSystem: "tailwind",
        entries: [
          {
            category: "color",
            name: "color-bg-accent-yellow-default",
            usage: "color-bg-accent-yellow-default",
            value: "#ffdd52",
          },
        ],
      },
    });

    assert.equal(spec.styles?.warning?.bg, "token:color/color-bg-accent-yellow-default");
  });

  it("falls back to raw rgb when no variable is bound", () => {
    const node: FigmaNodeSnapshot = {
      id: "1:1",
      name: "Page-level Alert",
      type: "COMPONENT_SET",
      componentPropertyDefinitions: {
        Type: { type: "VARIANT", variantOptions: ["Warning"] },
      },
      children: [
        {
          id: "1:2",
          name: "Type=Warning",
          type: "COMPONENT",
          variantValues: { type: "Warning" },
          fills: [{ type: "SOLID", color: { r: 250 / 255, g: 184 / 255, b: 148 / 255 } }],
        },
      ],
    };

    const spec = pruneNodeTree(node);
    assert.equal(spec.styles?.warning?.bg, "token:color/raw/250-184-148");
  });

  it("falls back to root styles when no variant components exist", () => {
    const node: FigmaNodeSnapshot = {
      id: "1:1",
      name: "Badge",
      type: "COMPONENT",
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
      children: [{ id: "1:2", name: "Label", type: "TEXT", characters: "New" }],
    };

    const spec = pruneNodeTree(node);

    assert.ok(spec.styles?.["default+default"]?.bg);
    assert.equal(spec.slots?.label?.type, "text");
  });
});
