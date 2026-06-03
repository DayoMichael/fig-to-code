import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  discoverThemeCatalog,
  listThemeBrands,
  listThemeModes,
  resolveThemeCatalogEntry,
  slugThemeToken,
} from "./theme-catalog.js";

test("discoverThemeCatalog reads theme CSS files and attributes", async () => {
  const root = await mkTempDir("fig2code-theme-catalog-");
  try {
    const tokensDir = path.join(root, "packages", "ui", "tokens");
    await mkdir(tokensDir, { recursive: true });
    await writeFile(path.join(tokensDir, "primitives.css"), ":root {}");
    await writeFile(
      path.join(tokensDir, "theme-retail-light.css"),
      '[data-brand="retail"][data-theme="light"] { --color: red; }',
    );
    await writeFile(
      path.join(tokensDir, "theme-business-dark.css"),
      '[data-brand="business"][data-theme="dark"] { --color: blue; }',
    );

    const catalog = await discoverThemeCatalog(root, ["packages/ui/tokens"]);
    assert.ok(catalog);
    assert.equal(catalog!.entries.length, 2);
    assert.deepEqual(listThemeBrands(catalog!), ["business", "retail"]);
    assert.deepEqual(listThemeModes(catalog!, "retail"), ["light"]);
    assert.deepEqual(listThemeModes(catalog!, "business"), ["dark"]);

    const entry = resolveThemeCatalogEntry(catalog, { brand: "business", mode: "dark" });
    assert.equal(entry?.cssFile, "theme-business-dark.css");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slugThemeToken normalizes labels", () => {
  assert.equal(slugThemeToken("Retail Light"), "retail-light");
  assert.equal(slugThemeToken("  Dark Mode  "), "dark-mode");
});

async function mkTempDir(prefix: string): Promise<string> {
  const dir = path.join(tmpdir(), `${prefix}${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
