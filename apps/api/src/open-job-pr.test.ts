import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobBuildPreview } from "@fig2code/spec";
import { buildPatchesFromJobPreview, resolvePullRequestPatches } from "./open-job-pr.js";

describe("buildPatchesFromJobPreview", () => {
  const preview: JobBuildPreview = {
    componentName: "Button",
    storyFormat: "csf3",
    componentPath: "src/components/Button/Button.tsx",
    componentContent: "export function Button() {}",
    storyPath: "src/components/Button/Button.stories.tsx",
    storyContent: "export default { component: Button };",
    variantLabel: "Default",
    files: [
      {
        path: "src/components/Button/Button.tsx",
        action: "update",
        content: "export function Button() {}",
      },
    ],
  };

  it("merges preview overrides by path", () => {
    const patches = buildPatchesFromJobPreview(preview, [
      {
        path: "src/components/Button/Button.tsx",
        content: "export function Button() { return null; }",
      },
    ]);

    const componentPatch = patches.find(
      (patch) => patch.path === "src/components/Button/Button.tsx",
    );
    assert.match(componentPatch?.content ?? "", /return null/);
  });

  it("includes story patch when present", () => {
    const patches = buildPatchesFromJobPreview(preview);
    assert.ok(
      patches.some((patch) => patch.path === "src/components/Button/Button.stories.tsx"),
    );
  });

  it("prefers client diff patches over full preview files", () => {
    const patches = resolvePullRequestPatches(preview, {
      patches: [
        {
          path: "src/components/Button/Button.tsx",
          action: "update",
          content: "export function Button() { return null; }",
        },
      ],
    });

    assert.equal(patches.length, 1);
    assert.match(patches[0]?.content ?? "", /return null/);
  });
});
