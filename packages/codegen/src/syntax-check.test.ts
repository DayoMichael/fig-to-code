import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FilePatch } from "@fig2code/spec";
import { findSyntaxIssues } from "./syntax-check.js";

describe("findSyntaxIssues", () => {
  it("returns empty for well-formed component code", () => {
    const patches: FilePatch[] = [
      {
        path: "src/components/Button.tsx",
        action: "create",
        content: `
import * as React from "react";
interface ButtonProps {
  label: string;
  disabled?: boolean;
}
export function Button(props: ButtonProps) {
  const { label, disabled } = props;
  return <button disabled={disabled}>{label}</button>;
}
`.trim(),
      },
    ];
    assert.deepEqual(findSyntaxIssues(patches), []);
  });

  it("detects the broken destructure pattern reported by users (}{ instead of }: {)", () => {
    const broken = `
import * as React from "react";
export function Button({
  variant,
  size,
  onDragStart,
  onDragEnd,
}{
  disabled?: boolean;
  'aria-disabled'?: boolean;
  'aria-busy'?: boolean;
} = {}) {
  return <button onDragStart={onDragStart}>{size}</button>;
}
`.trim();
    const patches: FilePatch[] = [
      { path: "src/components/Button.tsx", action: "create", content: broken },
    ];
    const issues = findSyntaxIssues(patches);
    assert.equal(issues.length, 1, "expected one syntax issue");
    assert.equal(issues[0].path, "src/components/Button.tsx");
    assert.ok(typeof issues[0].line === "number", "expected line info");
    assert.ok(
      (issues[0].snippet ?? "").includes("}{"),
      "snippet should show the offending region",
    );
  });

  it("ignores non-source files (md, json) and deleted patches", () => {
    const patches: FilePatch[] = [
      {
        path: "README.md",
        action: "create",
        content: "# hi\n```ts\nconst x =\n```",
      },
      { path: "package.json", action: "update", content: "{ broken json" },
      { path: "src/Button.tsx", action: "delete" },
    ];
    assert.deepEqual(findSyntaxIssues(patches), []);
  });
});
