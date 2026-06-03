import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolvePreviewTheme } from "./preview-theme.js";

test("resolvePreviewTheme loads token CSS and tailwind color config", async () => {
  const root = await mkTempDir("fig2code-preview-theme-");
  try {
    const packageDir = path.join(root, "packages", "ui");
    const tokensDir = path.join(packageDir, "tokens");
    const presetDir = path.join(packageDir, "src", "preset");
    await mkdir(tokensDir, { recursive: true });
    await mkdir(presetDir, { recursive: true });

    await writeFile(
      path.join(tokensDir, "primitives.css"),
      ':root { --k-spacing-4: 16px; --k-typography-family-body: "Inter"; }',
    );
    await writeFile(
      path.join(tokensDir, "theme-retail-light.css"),
      '[data-brand="retail"][data-theme="light"] { --k-color-bg-accent-yellow-default: #ffcc00; }',
    );
    await writeFile(
      path.join(presetDir, "color-token-paths.generated.json"),
      JSON.stringify(["bg.accent.yellow.default"]),
    );
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@repo/ui" }),
    );

    const theme = await resolvePreviewTheme(
      root,
      "packages/ui/src/components/ui/inline-alert.tsx",
      { tokenPaths: ["packages/ui/tokens"] },
    );

    assert.ok(theme);
    assert.match(theme!.css, /--k-color-bg-accent-yellow-default/);
    assert.match(theme!.css, /--k-spacing-4/);
    assert.equal(theme!.htmlAttrs["data-brand"], "retail");
    assert.equal(theme!.htmlAttrs["data-theme"], "light");
    assert.match(
      theme!.tailwindConfigJson,
      /bg-accent-yellow-default/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function mkTempDir(prefix: string): Promise<string> {
  const dir = path.join(tmpdir(), `${prefix}${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
