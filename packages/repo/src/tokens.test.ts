import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildCombinedTokenResolver,
  buildProjectTokensSummary,
  buildTokenConfig,
  normalizeColorValue,
  replaceArbitraryTailwindColors,
  tokenCatalogToResolver,
} from "./tokens.js";

describe("token parser", () => {
  const tempDirs: string[] = [];

  after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRepo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fig2code-tokens-"));
    tempDirs.push(dir);

    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(dir, relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }

    return dir;
  }

  it("parses tailwind theme tokens into resolver entries", async () => {
    const rootDir = await makeRepo({
      "tailwind.config.ts": `
        export default {
          theme: {
            extend: {
              colors: {
                "text-primary": "#1b161d",
              },
              fontFamily: {
                "suisse-intl": ["Suisse Intl", "sans-serif"],
              },
              fontSize: {
                sm: ["14px", { lineHeight: "20px" }],
                md: ["16px", { lineHeight: "24px" }],
              },
            },
          },
        };
      `,
    });

    const config = await buildTokenConfig({
      rootDir,
      tokenPaths: ["tailwind.config.ts"],
      tailwindConfigPath: "tailwind.config.ts",
      styleSystem: "tailwind",
    });

    const resolver = tokenCatalogToResolver(config.catalog);
    assert.equal(normalizeColorValue("#1b161d"), "#1b161d");
    assert.equal(resolver["color/text-primary"], "text-primary");
    assert.equal(resolver["fontFamily/suisse-intl"], "font-suisse-intl");
    assert.equal(resolver["typography/sm"], "text-sm");

    const combined = buildCombinedTokenResolver({
      tokenCatalog: config.catalog,
      styleSystem: "tailwind",
    });
    assert.equal(combined["fontFamily/suisse-intl"], "font-suisse-intl");

    const summary = buildProjectTokensSummary(config);
    assert.equal(summary.categories.color.some((entry) => entry.name === "text-primary"), true);
    assert.ok(summary.sourceExcerpt?.includes("text-primary"));
  });

  it("merges tokens from multiple source files", async () => {
    const rootDir = await makeRepo({
      "src/tokens/colors.css": `
        :root {
          --color-text-primary: #1b161d;
        }
      `,
      "src/tokens/spacing.css": `
        :root {
          --spacing-md: 16px;
        }
      `,
    });

    const config = await buildTokenConfig({
      rootDir,
      tokenPaths: ["src/tokens/colors.css", "src/tokens/spacing.css"],
      styleSystem: "tailwind",
    });

    const resolver = tokenCatalogToResolver(config.catalog);
    assert.equal(resolver["color/text-primary"], "text-primary");
    assert.equal(resolver["spacing/md"], "md");
    assert.equal(config.tokenPaths.length, 2);
  });

  it("parses css color tokens without resolved hex values for name matching", async () => {
    const rootDir = await makeRepo({
      "src/tokens/colors.css": `
        :root {
          --color-color-bg-accent-yellow-default: var(--primitive-yellow-400);
          --color-bg-accent-success-default: rgb(145 229 181);
        }
      `,
    });

    const config = await buildTokenConfig({
      rootDir,
      tokenPaths: ["src/tokens/colors.css"],
      styleSystem: "tailwind",
    });

    assert.equal(
      config.catalog.entries.some(
        (entry) => entry.category === "color" && entry.name === "color-bg-accent-yellow-default",
      ),
      true,
    );
    assert.equal(
      config.catalog.entries.find((entry) => entry.name === "bg-accent-success-default")?.value,
      "#91e5b5",
    );
  });

  it("replaces arbitrary tailwind rgb colors with token classes", async () => {
    const rootDir = await makeRepo({
      "tailwind.config.ts": `
        export default {
          theme: {
            extend: {
              colors: {
                "text-primary": "#1b161d",
              },
            },
          },
        };
      `,
    });

    const config = await buildTokenConfig({
      rootDir,
      tokenPaths: ["tailwind.config.ts"],
      tailwindConfigPath: "tailwind.config.ts",
      styleSystem: "tailwind",
    });

    const source =
      'className={cn("font-semibold text-[rgb(27,22,29)]", isMobile ? "text-sm" : "text-md")}';
    const resolved = replaceArbitraryTailwindColors(source, config.catalog);
    assert.match(resolved, /text-text-primary/);
    assert.doesNotMatch(resolved, /rgb\(27,22,29\)/);
  });
});
