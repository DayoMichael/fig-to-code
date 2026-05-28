import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveHarnessTsConfig } from "./resolve-tsconfig.js";

test("resolveHarnessTsConfig picks nearest package tsconfig paths", async () => {
  const root = await mkTempDir("fig2code-resolve-tsconfig-");
  try {
    const packageDir = path.join(root, "packages", "ui");
    const srcDir = path.join(packageDir, "src", "components", "ui");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@repo/ui" }),
    );
    await writeFile(
      path.join(packageDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
          },
        },
      }),
    );
    await writeFile(path.join(srcDir, "button.tsx"), "export function Button() { return null; }");

    const resolved = await resolveHarnessTsConfig(
      root,
      "packages/ui/src/components/ui/button.tsx",
    );

    assert.equal(resolved.viteAliases["@"], "packages/ui/src");
    assert.deepEqual(resolved.tsPaths["@/*"], ["../packages/ui/src/*"]);
    assert.ok(resolved.include.some((entry) => entry.includes("packages/ui")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveHarnessTsConfig handles tsconfig include globs with /**/*", async () => {
  const root = await mkTempDir("fig2code-resolve-tsconfig-globs-");
  try {
    const packageDir = path.join(root, "packages", "ui");
    const srcDir = path.join(packageDir, "src", "components", "ui");
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@repo/ui" }));
    await writeFile(
      path.join(packageDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "./src",
          paths: { "@/*": ["*"] },
        },
        include: ["src/**/*", "src/**/*.json"],
      }),
    );
    await mkdir(path.join(packageDir, "node_modules", "react"), { recursive: true });
    await mkdir(path.join(packageDir, "node_modules", "react-dom"), { recursive: true });
    await writeFile(path.join(packageDir, "node_modules", "react", "package.json"), "{}");
    await writeFile(path.join(packageDir, "node_modules", "react-dom", "package.json"), "{}");
    await writeFile(path.join(srcDir, "button.tsx"), "export function Button() { return null; }");

    const resolved = await resolveHarnessTsConfig(
      root,
      "packages/ui/src/components/ui/button.tsx",
    );

    assert.equal(resolved.viteAliases["@"], "packages/ui/src");
    assert.equal(resolved.reactModules?.react, "packages/ui/node_modules/react");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function mkTempDir(prefix: string): Promise<string> {
  const dir = path.join(tmpdir(), `${prefix}${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
