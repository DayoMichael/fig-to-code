import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildRepoIndex,
  indexFindDirsNamed,
  indexFindFilesNamed,
  indexHasFileSuffix,
} from "./repo-index.js";

describe("buildRepoIndex", () => {
  const tempDirs: string[] = [];

  after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("indexes files and directories in one pass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fig2code-index-"));
    tempDirs.push(dir);

    await mkdir(join(dir, "packages/ui/src/components/ui"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}", "utf8");
    await writeFile(join(dir, "packages/ui/package.json"), "{}", "utf8");
    await writeFile(join(dir, "packages/ui/tailwind.config.js"), "module.exports = {};\n", "utf8");
    await writeFile(join(dir, "packages/ui/src/components/ui/button.tsx"), "export {};\n", "utf8");
    await mkdir(join(dir, "apps/storybook/src/stories"), { recursive: true });
    await writeFile(
      join(dir, "apps/storybook/src/stories/Button.stories.tsx"),
      "export default {};\n",
      "utf8",
    );
    await mkdir(join(dir, "apps/storybook/public/design-tokens/web"), { recursive: true });
    await writeFile(
      join(dir, "apps/storybook/public/design-tokens/web/primitives.css"),
      ":root {}\n",
      "utf8",
    );

    const index = await buildRepoIndex(dir);

    assert.ok(indexFindFilesNamed(index, "package.json").length >= 2);
    assert.ok(indexFindFilesNamed(index, "tailwind.config.js").includes("packages/ui/tailwind.config.js"));
    assert.ok(indexFindDirsNamed(index, "components").includes("packages/ui/src/components"));
    assert.ok(indexHasFileSuffix(index, ".stories.tsx"));
    assert.ok(!index.files.some((file) => file.includes("apps/storybook/public/")));
  });
});
