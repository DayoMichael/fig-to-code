import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { buildTypographyConfig, typographyToTokenResolver } from "./typography.js";

describe("typography parser", () => {
  const tempDirs: string[] = [];

  after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRepo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fig2code-typography-"));
    tempDirs.push(dir);

    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(dir, relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }

    return dir;
  }

  it("parses css typography variables into a catalog", async () => {
    const rootDir = await makeRepo({
      "src/styles/typography.css": `
        :root {
          --font-size-sm: 14px;
          --font-weight-semibold: 600;
          --line-height-sm: 20px;
          --letter-spacing-tight: -0.2px;
          --font-family-body: "Inter", sans-serif;
        }
      `,
    });

    const config = await buildTypographyConfig({
      rootDir,
      fontPaths: ["src/styles/typography.css"],
      styleSystem: "tailwind",
    });

    assert.equal(config.catalog.scales.some((scale) => scale.name === "sm" && scale.fontSize === 14), true);
    assert.equal(
      config.catalog.scales.some((scale) => scale.name === "semibold" && scale.fontWeight === 600),
      true,
    );
    assert.deepEqual(config.catalog.families.body, "Inter, sans-serif");
  });

  it("builds token resolver entries for typography tokens", async () => {
    const rootDir = await makeRepo({
      "tokens/typography.css": `
        :root {
          --font-size-md: 16px;
        }
      `,
    });

    const config = await buildTypographyConfig({
      rootDir,
      fontPaths: ["tokens/typography.css"],
      styleSystem: "tailwind",
    });

    const resolver = typographyToTokenResolver(config.catalog, "tailwind");
    assert.equal(resolver["typography/md"], "text-md");
  });

  it("maps css font families to tailwind font-* classes in the resolver", async () => {
    const rootDir = await makeRepo({
      "src/styles/typography.css": `
        :root {
          --font-family-body: "Inter", sans-serif;
        }
      `,
    });

    const config = await buildTypographyConfig({
      rootDir,
      fontPaths: ["src/styles/typography.css"],
      styleSystem: "tailwind",
    });

    const resolver = typographyToTokenResolver(config.catalog, "tailwind");
    assert.equal(resolver["typography/family/body"], "font-body");
  });

  it("maps css line-height tokens to tailwind leading-* classes", async () => {
    const rootDir = await makeRepo({
      "src/styles/typography.css": `
        :root {
          --line-height-sm: 20px;
        }
      `,
    });

    const config = await buildTypographyConfig({
      rootDir,
      fontPaths: ["src/styles/typography.css"],
      styleSystem: "tailwind",
    });

    const scale = config.catalog.scales.find((entry) => entry.name === "sm");
    assert.equal(scale?.usage, "leading-sm");
    assert.equal(scale?.lineHeight, 20);
  });
});
