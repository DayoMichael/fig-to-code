import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pruneNodeTree } from "@fig2code/figma-ast";

describe("plugin pruning integration", () => {
  it("can build a PrunedSpec from a synthetic snapshot", () => {
    const spec = pruneNodeTree({
      id: "1:1",
      name: "Button",
      type: "COMPONENT",
      children: [{ id: "1:2", name: "Label", type: "TEXT", characters: "Go" }],
    });

    assert.equal(spec.name, "Button");
  });
});
