import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { preparePreviewAnnotationsForHarness } from "./storybook-harness.js";

describe("preparePreviewAnnotationsForHarness", () => {
  it("rewrites barrel imports to direct provider files", async () => {
    const root = await mkdir(path.join(tmpdir(), `fig2code-harness-${Date.now()}`), {
      recursive: true,
    }).then((dir) => dir);

    const harnessPath = path.join(root, ".fig2code-preview");
    const previewPath = path.join(root, "apps/storybook/.storybook/preview.tsx");
    const indexPath = path.join(root, "packages/ui/src/index.ts");
    const providerPath = path.join(root, "packages/ui/src/ThemeProvider.tsx");

    await mkdir(path.dirname(previewPath), { recursive: true });
    await mkdir(path.dirname(indexPath), { recursive: true });
    await mkdir(harnessPath, { recursive: true });

    await writeFile(
      indexPath,
      `export { Button } from "./Button";\n`,
      "utf-8",
    );
    await writeFile(
      providerPath,
      `export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}\n`,
      "utf-8",
    );
    await writeFile(
      previewPath,
      `import { ThemeProvider } from "../../../packages/ui/src/index.ts";

export const decorators = [
  (Story) => (
    <ThemeProvider>
      <Story />
    </ThemeProvider>
  ),
];
`,
      "utf-8",
    );

    try {
      const resolved = await preparePreviewAnnotationsForHarness(
        root,
        harnessPath,
        "apps/storybook/.storybook/preview.tsx",
        { "@": "packages/ui/src" },
      );

      assert.equal(resolved, ".fig2code-preview/preview-annotations.shim.tsx");
      const shim = await readShim(harnessPath);
      assert.match(shim, /ThemeProvider/);
      assert.match(shim, /packages\/ui\/src\/ThemeProvider/);
      assert.doesNotMatch(shim, /from ['"].*index\.ts['"]/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns original path when barrel exports resolve", async () => {
    const root = await mkdir(path.join(tmpdir(), `fig2code-harness-${Date.now()}`), {
      recursive: true,
    }).then((dir) => dir);

    const harnessPath = path.join(root, ".fig2code-preview");
    const previewPath = path.join(root, "apps/storybook/.storybook/preview.tsx");
    const indexPath = path.join(root, "packages/ui/src/index.ts");

    await mkdir(path.dirname(previewPath), { recursive: true });
    await mkdir(path.dirname(indexPath), { recursive: true });
    await mkdir(harnessPath, { recursive: true });

    await writeFile(
      indexPath,
      `export { ThemeProvider } from "./ThemeProvider";\n`,
      "utf-8",
    );
    await writeFile(
      path.join(root, "packages/ui/src/ThemeProvider.tsx"),
      `export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}\n`,
      "utf-8",
    );
    await writeFile(
      previewPath,
      `import { ThemeProvider } from "../../../packages/ui/src/index.ts";
export const decorators = [(Story) => <ThemeProvider><Story /></ThemeProvider>];
`,
      "utf-8",
    );

    try {
      const resolved = await preparePreviewAnnotationsForHarness(
        root,
        harnessPath,
        "apps/storybook/.storybook/preview.tsx",
        {},
      );

      assert.equal(resolved, "apps/storybook/.storybook/preview.tsx");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readShim(harnessPath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path.join(harnessPath, "preview-annotations.shim.tsx"), "utf-8");
}
