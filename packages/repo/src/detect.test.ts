import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { classifyName, detectFileNaming, detectProjectConfig } from "./detect.js";

describe("detectProjectConfig", () => {
  const tempDirs: string[] = [];

  after(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRepo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fig2code-detect-"));
    tempDirs.push(dir);

    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(dir, relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }

    return dir;
  }

  it("detects prettier from config files and dependencies", async () => {
    const rootDir = await makeRepo({
      "package.json": JSON.stringify({
        name: "root",
        devDependencies: { prettier: "^3.0.0" },
      }),
      ".prettierrc.json": JSON.stringify({ singleQuote: true }),
      "src/components/Button.tsx": "export const Button = () => null;\n",
    });

    const detected = await detectProjectConfig({ rootDir });
    assert.equal(detected.formatter, "prettier");
  });

  it("finds jest in workspace packages and test files", async () => {
    const rootDir = await makeRepo({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "packages/ui/package.json": JSON.stringify({
        name: "@acme/ui",
        devDependencies: { jest: "^29.0.0" },
      }),
      "packages/ui/src/Button/Button.tsx": "export const Button = () => null;\n",
      "packages/ui/src/Button/Button.test.tsx": "test('x', () => {});\n",
      "packages/ui/src/data/helpers.ts": "export {};\n",
    });

    const detected = await detectProjectConfig({ rootDir });
    assert.equal(detected.testFramework, "jest");
    assert.ok(detected.existingComponents.some((c) => c.name === "Button"));
    assert.ok(!detected.existingComponents.some((c) => c.name === "data"));
  });

  it("detects kebab-case file and folder naming", async () => {
    const rootDir = await makeRepo({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "src/components/button/button.tsx": "export const Button = () => null;\n",
      "src/components/text-field/text-field.tsx": "export const TextField = () => null;\n",
    });

    const detected = await detectProjectConfig({ rootDir });
    assert.equal(detected.fileNaming, "kebab-case");
    assert.ok(detected.existingComponents.some((c) => c.name === "button"));
  });

  it("detects flat shadcn-style ui folders in monorepos", async () => {
    const rootDir = await makeRepo({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/ui/package.json": JSON.stringify({
        name: "@acme/ui",
        devDependencies: { jest: "^29.0.0", tailwindcss: "^3.4.0" },
        peerDependencies: { tailwindcss: "^3.4.0" },
      }),
      "packages/ui/tailwind.config.js": "module.exports = { content: ['./src/**/*.tsx'] };\n",
      "packages/ui/tokens/primitives.css": ":root { --color-brand: #000; }\n",
      "packages/ui/fonts.css": "@font-face { font-family: 'Brand'; }\n",
      "packages/ui/src/components/ui/button.tsx":
        "interface ButtonProps {}\nexport const Button = (props: ButtonProps) => null;\n",
      "packages/ui/src/components/ui/balance-group.tsx":
        "interface BalanceGroupProps {}\nexport const BalanceGroup = (props: BalanceGroupProps) => null;\n",
      "packages/ui/src/components/ui/text-field.tsx":
        "interface TextFieldProps {}\nexport const TextField = (props: TextFieldProps) => null;\n",
      "packages/ui/src/components/icons/logo/kuda-logo.tsx":
        "export const KudaLogo = () => null;\n",
      "apps/storybook/src/stories/Button.stories.tsx": "export default { title: 'Button' };\n",
    });

    const detected = await detectProjectConfig({ rootDir });
    assert.equal(detected.styleSystem, "tailwind");
    assert.equal(detected.tailwindConfigPath, "packages/ui/tailwind.config.js");
    assert.equal(detected.testFramework, "jest");
    assert.equal(detected.storyFormat, "csf3");
    assert.equal(detected.fileNaming, "kebab-case");
    assert.equal(detected.componentPaths[0], "packages/ui/src/components/ui");
    assert.ok(detected.tokenPaths.includes("packages/ui/tokens"));
    assert.ok(detected.iconPaths.includes("packages/ui/src/components/icons"));
    assert.ok(detected.fontPaths.includes("packages/ui/fonts.css"));
    assert.ok(detected.existingComponents.some((c) => c.name === "button"));
    assert.ok(detected.existingComponents.some((c) => c.name === "balance-group"));
    assert.equal(detected.exportStyle, "named");
    assert.equal(detected.propsPattern, "interface");
  });

  it("does not treat story files as css-modules", async () => {
    const rootDir = await makeRepo({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "src/components/Button/Button.tsx": "export const Button = () => null;\n",
      "src/components/Button/Button.stories.tsx": "export default { title: 'Button' };\n",
    });

    const detected = await detectProjectConfig({ rootDir });
    assert.notEqual(detected.styleSystem, "css-modules");
  });

  it("classifyName recognizes common casing styles", () => {
    assert.equal(classifyName("Button"), "PascalCase");
    assert.equal(classifyName("text-field"), "kebab-case");
    assert.equal(classifyName("textField"), "camelCase");
    assert.equal(classifyName("data"), "camelCase");
  });
});
