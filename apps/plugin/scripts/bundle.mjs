import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcDir = join(root, "src");
const distDir = join(root, "dist");

mkdirSync(distDir, { recursive: true });

const watch = process.argv.includes("--watch");

const uiBuild = {
  entryPoints: [join(srcDir, "ui.ts")],
  bundle: true,
  outfile: join(root, "ui.js"),
  target: "es2017",
  format: "iife",
  logLevel: "info",
};

function inlineUiHtml() {
  let html = readFileSync(join(srcDir, "ui.html"), "utf8");
  const uiJs = readFileSync(join(root, "ui.js"), "utf8");
  html = html.replace(
    '<script src="ui.js"></script>',
    `<script>${uiJs}</script>`,
  );
  writeFileSync(join(root, "ui.html"), html);
  return html;
}

function codeBuildOptions(html) {
  return {
    entryPoints: [join(srcDir, "code.ts")],
    bundle: true,
    outfile: join(root, "code.js"),
    target: "es2017",
    format: "iife",
    logLevel: "info",
    define: {
      __html__: JSON.stringify(html),
    },
  };
}

async function copyUiAssets() {
  copyFileSync(join(root, "manifest.json"), join(distDir, "manifest.json"));
}

async function buildPlugin() {
  await esbuild.build(uiBuild);
  const html = inlineUiHtml();
  await esbuild.build(codeBuildOptions(html));
  await copyUiAssets();
  console.log("Plugin bundle written next to manifest.json:");
  console.log(`  ${join(root, "manifest.json")}`);
  console.log(`  ${join(root, "code.js")}`);
  console.log(`  ${join(root, "ui.html")} (ui.js inlined for Figma)`);
}

if (watch) {
  await buildPlugin();
  const codeCtx = await esbuild.context(codeBuildOptions(inlineUiHtml()));
  const uiCtx = await esbuild.context({
    ...uiBuild,
    plugins: [
      {
        name: "rebuild-code-on-ui-change",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length > 0) return;
            const html = inlineUiHtml();
            await esbuild.build(codeBuildOptions(html));
          });
        },
      },
    ],
  });
  await Promise.all([codeCtx.watch(), uiCtx.watch()]);
  console.log("Watching plugin — import manifest from apps/plugin/manifest.json");
} else {
  await buildPlugin();
}
