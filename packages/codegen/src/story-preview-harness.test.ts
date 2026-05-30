import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generatePreviewMainTsx,
  usesStorybookPreview,
} from "./story-preview-harness.js";
import { pickDefaultStoryExportName } from "./preview-utils.js";

describe("story preview harness", () => {
  it("uses Storybook when a story path and content exist", () => {
    assert.equal(
      usesStorybookPreview({
        componentName: "Button",
        storyFormat: "csf3",
        storyPath: "src/Button.stories.tsx",
        storyContent: "export const Default = {};",
      }),
      true,
    );
    assert.equal(
      usesStorybookPreview({
        componentName: "Button",
        storyFormat: "csf3",
        storyPath: "src/Button.stories.tsx",
        storyMissing: true,
      }),
      false,
    );
  });

  it("picks Default story export first", () => {
    const story = `
export const Playground: Story = {};
export const Default: Story = {};
`;
    assert.equal(pickDefaultStoryExportName(story), "Default");
  });

  it("generates composeStories harness when a story is available", () => {
    const main = generatePreviewMainTsx({
      buildPreview: {
        componentName: "Select",
        storyFormat: "csf3",
        componentContent: "export const Select = () => null;",
        storyPath: "apps/storybook/src/stories/Select.stories.tsx",
        storyContent: `
import type { StoryObj } from '@storybook/react';
export const Default: StoryObj = { args: { placeholder: 'Pick one' } };
`,
        variants: { size: ["sm", "md"] },
        variantLabel: "size=sm",
      },
      componentName: "Select",
      componentRepoPath: "packages/ui/src/components/ui/select.tsx",
      useDefaultImport: false,
      storyRepoPath: "apps/storybook/src/stories/Select.stories.tsx",
      previewAnnotationsPath: "apps/storybook/.storybook/preview.tsx",
    });

    assert.match(main, /composeStories/);
    assert.match(main, /setProjectAnnotations/);
    assert.match(main, /const PreviewStory = composedStories\["Default"\]/);
    assert.doesNotMatch(main, /Preview message/);
    assert.match(main, /apps\/storybook\/src\/stories\/Select\.stories/);
    assert.match(main, /apps\/storybook\/\.storybook\/preview/);
    assert.match(main, /composedStories\["Default"\]/);
  });

  it("falls back to flat component render when story is missing", () => {
    const main = generatePreviewMainTsx({
      buildPreview: {
        componentName: "Badge",
        storyFormat: "none",
        componentContent: "export function Badge() { return <span />; }",
        storyMissing: true,
        variants: {},
        variantLabel: "Default",
      },
      componentName: "Badge",
      componentRepoPath: "src/components/Badge.tsx",
      useDefaultImport: false,
    });

    assert.doesNotMatch(main, /composeStories/);
    assert.match(main, /<Badge key=\{COMPONENT_NAME/);
  });
});
