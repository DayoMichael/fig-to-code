import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractImports,
  isPreviewModuleSource,
  resolveImportCandidates,
  resolvePreviewImports,
  shouldResolvePreviewImport,
} from "./preview-dependencies.js";

describe("preview dependencies", () => {
  it("extracts icon imports with module paths", () => {
    assert.deepEqual(
      extractImports(`
import { EtchCircleInfoIcon } from "@/icons/etch";
import type { InlineAlertProps } from "./InlineAlert.types";
`),
      [{ bindings: ["EtchCircleInfoIcon"], fromPath: "@/icons/etch" }],
    );
  });

  it("resolves icon import candidates from iconPath and alias paths", () => {
    const candidates = resolveImportCandidates(
      { bindings: ["EtchCircleInfoIcon"], fromPath: "@/icons/etch-icons" },
      {
        componentPath: "packages/ui/src/components/InlineAlert/InlineAlert.tsx",
        iconPath: "packages/ui/src/components/icons/etch-icons",
      },
    );

    assert.ok(candidates.includes("packages/ui/src/components/icons/etch-icons/etch-circle-info.tsx"));
    assert.ok(candidates.includes("packages/ui/src/components/icons/etch-icons/EtchCircleInfoIcon.tsx"));
    assert.ok(!candidates.includes("packages/ui/src/components/icons/etch-icons"));
  });

  it("rejects bitbucket directory listings as preview module source", () => {
    assert.equal(
      isPreviewModuleSource(
        JSON.stringify({
          values: [{ path: "packages/ui/src/components/icons/etch-icons/etch-anchor.tsx" }],
          pagelen: 10,
        }),
      ),
      false,
    );
    assert.equal(
      isPreviewModuleSource(
        `export const EtchCircleInfoIcon = () => <svg />;`,
      ),
      true,
    );
  });

  it("resolves preview imports from generated component source", () => {
    const resolutions = resolvePreviewImports(
      `
import { cn } from "@/lib/utils";
import { EtchCircleInfoIcon } from "@/icons/etch";

export const InlineAlert = () => <EtchCircleInfoIcon />;
`,
      {
        componentPath: "src/components/InlineAlert/InlineAlert.tsx",
        iconPath: "src/icons",
      },
    );

    assert.equal(resolutions.length, 1);
    assert.deepEqual(resolutions[0]?.bindings, ["EtchCircleInfoIcon"]);
    assert.ok(
      resolutions[0]?.candidatePaths.includes("src/icons/etch/EtchCircleInfoIcon.tsx"),
    );
  });

  it("ignores non-icon imports", () => {
    assert.equal(
      shouldResolvePreviewImport({ bindings: ["cn"], fromPath: "@/lib/utils" }),
      false,
    );
    assert.equal(
      shouldResolvePreviewImport({ bindings: ["EtchCircleInfoIcon"], fromPath: "@/icons/etch" }),
      true,
    );
  });
});
