import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildJobPreview, previewFullText, previewSnippet, storyFormatLabel } from "./preview.js";

describe("buildJobPreview", () => {
  it("extracts story and component files with variant label", () => {
    const preview = buildJobPreview({
      prunedSpec: {
        name: "Button",
        kind: "component",
        variants: { variant: ["primary"], size: ["md"] },
      },
      storyFormat: "csf3",
      patches: [
        {
          path: "src/components/Button/Button.tsx",
          action: "create",
          content: "export function Button() { return <button />; }\n",
        },
        {
          path: "src/components/Button/Button.stories.tsx",
          action: "create",
          content:
            "import type { StoryObj } from '@storybook/react';\nexport const Primary: Story = { args: { variant: 'primary' } };\n",
        },
      ],
    });

    assert.equal(preview.componentName, "Button");
    assert.equal(preview.variantLabel, "Primary");
    assert.equal(preview.storyPath, "src/components/Button/Button.stories.tsx");
    assert.equal(storyFormatLabel(preview.storyFormat), "Storybook CSF3");
    assert.match(previewSnippet(preview), /Primary: Story/);
    assert.match(previewFullText(preview), /Button\.tsx/);
    assert.match(previewFullText(preview), /Button\.stories\.tsx/);
    assert.equal(preview.files?.length, 2);
    assert.equal(preview.files?.[0]?.path, "src/components/Button/Button.tsx");
  });

  it("includes every patch in preview files", () => {
    const preview = buildJobPreview({
      prunedSpec: { name: "Button", kind: "component" },
      patches: [
        {
          path: "src/components/Button/Button.tsx",
          action: "create",
          content: "export function Button() { return <button />; }\n",
        },
        {
          path: "src/components/Button/index.ts",
          action: "create",
          content: "export { Button } from './Button';\n",
        },
        {
          path: "src/components/Button/Button.stories.tsx",
          action: "create",
          content: "export const Primary = { args: {} };\n",
        },
      ],
    });

    assert.equal(preview.files?.length, 3);
    assert.deepEqual(
      preview.files?.map((file) => file.path),
      [
        "src/components/Button/Button.tsx",
        "src/components/Button/index.ts",
        "src/components/Button/Button.stories.tsx",
      ],
    );
  });

  it("falls back to variant props when no story export exists", () => {
    const preview = buildJobPreview({
      prunedSpec: {
        name: "Badge",
        kind: "component",
        variants: { tone: ["neutral"] },
      },
      patches: [
        {
          path: "src/components/Badge/Badge.tsx",
          action: "create",
          content: "export function Badge() { return <span />; }\n",
        },
      ],
    });

    assert.equal(preview.variantLabel, "tone=neutral");
    assert.match(previewSnippet(preview), /Badge\(\)/);
  });
});
