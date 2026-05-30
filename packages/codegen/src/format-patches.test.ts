import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatChangedPatches, isFormattablePatchPath } from "./format-patches.js";

describe("formatChangedPatches", () => {
  it("recognizes formattable source paths", () => {
    assert.ok(isFormattablePatchPath("src/Button.tsx"));
    assert.ok(!isFormattablePatchPath("README.md"));
  });

  it("formats messy TSX using repo .prettierrc", async () => {
    const root = await mkdtemp(join(tmpdir(), "fig2code-format-"));
    await mkdir(join(root, "src/components"), { recursive: true });
    await writeFile(
      join(root, ".prettierrc.json"),
      JSON.stringify({ singleQuote: true, semi: true, tabWidth: 2 }),
      "utf8",
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", private: true, devDependencies: { prettier: "^3.5.3" } }),
      "utf8",
    );

    const messy = `export function Button(){return <button className="btn" />}\n`;
    const [patch] = await formatChangedPatches(
      [{ path: "src/components/Button.tsx", action: "update", content: messy }],
      { formatter: "auto", repoRoot: root },
    );

    assert.match(patch?.content ?? "", /export function Button\(\) \{/);
    assert.match(patch?.content ?? "", /return <button className=/);
    assert.doesNotMatch(patch?.content ?? "", /Button\(\)\{return/);
  }, { timeout: 120_000 });

  it("infers style from existing files when no prettier config exists", async () => {
    const messy = `export const Foo=()=>{return <div/>}\n`;
    const [patch] = await formatChangedPatches(
      [{ path: "src/Foo.tsx", action: "update", content: messy }],
      {
        formatter: "auto",
        existingFiles: [
          {
            path: "src/Bar.tsx",
            content: "export const Bar = () => {\n  return null;\n};\n",
          },
        ],
      },
    );

    assert.match(patch?.content ?? "", /export const Foo = \(\) => \{/);
    assert.match(patch?.content ?? "", /return <div \/>;/);
  });

  it("leaves patches unchanged when formatter is none", async () => {
    const content = "export const Foo=()=>null\n";
    const [patch] = await formatChangedPatches(
      [{ path: "src/Foo.tsx", action: "update", content }],
      { formatter: "none" },
    );
    assert.equal(patch?.content, content);
  });

  it("formats only changed source files", async () => {
    const patches = await formatChangedPatches(
      [
        { path: "src/Foo.tsx", action: "update", content: "export const Foo=()=>null\n" },
        { path: "README.md", action: "update", content: "# Title\n" },
      ],
      {
        formatter: "prettier",
        existingFiles: [{ path: "src/Bar.tsx", content: "export const Bar = () => null;\n" }],
      },
    );

    assert.match(patches[0]?.content ?? "", /export const Foo = \(\) => null;/);
    assert.equal(patches[1]?.content, "# Title\n");
  });
});
