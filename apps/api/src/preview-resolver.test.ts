import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobBuildPreview } from "@fig2code/spec";
import { loadPreviewDependenciesFromRepo } from "./preview-resolver.js";

const buildPreview: JobBuildPreview = {
  componentName: "InlineAlert",
  storyFormat: "csf3",
  variantLabel: "type=Warning",
  componentPath: "src/components/InlineAlert/InlineAlert.tsx",
  componentContent: `
import { forwardRef } from "react";
import { EtchCircleInfoIcon } from "@/icons/etch";

export const InlineAlert = forwardRef(({ title, message }, ref) => (
  <div ref={ref}>
    <EtchCircleInfoIcon aria-hidden />
    {title}: {message}
  </div>
));
`,
};

describe("preview resolver", () => {
  it("loads icon modules from the connected repo", async () => {
    const files = new Map<string, string>([
      [
        "packages/ui/src/components/icons/etch-icons/etch-circle-info.tsx",
        `import { forwardRef } from "react";
export const EtchCircleInfoIcon = forwardRef((props, ref) => (
  <svg ref={ref} viewBox="0 0 16 16" {...props}><circle cx="8" cy="8" r="6" /></svg>
));`,
      ],
    ]);

    const result = await loadPreviewDependenciesFromRepo(
      {
        ...buildPreview,
        componentContent: `
import { EtchCircleInfoIcon } from "@/components/icons/etch-icons";

export const InlineAlert = () => <EtchCircleInfoIcon aria-hidden />;
`,
      },
      {
        iconPath: "packages/ui/src/components/icons/etch-icons",
        readFile: async (path) => files.get(path) ?? null,
      },
    );

    assert.equal(result.sources.length, 1);
    assert.ok(result.resolvedBindings.includes("EtchCircleInfoIcon"));
    assert.match(result.sources[0] ?? "", /const EtchCircleInfoIcon = forwardRef/);
  });

  it("falls back to stubs when icon files are missing", async () => {
    const result = await loadPreviewDependenciesFromRepo(buildPreview, {
      iconPath: "src/icons",
      readFile: async () => null,
    });

    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.resolvedBindings, []);
  });

  it("ignores barrel files that do not define the requested icon binding", async () => {
    const result = await loadPreviewDependenciesFromRepo(buildPreview, {
      iconPath: "packages/ui/src/components/icons/etch-icons",
      readFile: async (path) => {
        if (path.endsWith("index.tsx")) {
          return `export { EtchCircleInfoIcon } from "./etch-circle-info";`;
        }
        if (path.endsWith("etch-circle-info.tsx")) {
          return `export const EtchCircleInfoIcon = () => <svg />;`;
        }
        return null;
      },
    });

    assert.equal(result.resolvedBindings.includes("EtchCircleInfoIcon"), true);
    assert.match(result.sources.join("\n"), /const EtchCircleInfoIcon/);
  });
});
