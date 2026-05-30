/**
 * Static preview readiness audit for Kuda-style component libraries.
 * Run: node --import tsx scripts/preview-component-audit.mjs [repoRoot]
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  extractComponentName,
  extractExistingPreviewMetadata,
  defaultPreviewArgs,
} from "../packages/codegen/dist/preview-utils.js";

const repoRoot = process.argv[2] ?? process.env.FIG2CODE_AUDIT_REPO;
if (!repoRoot) {
  console.error("Usage: node --import tsx scripts/preview-component-audit.mjs <repoRoot>");
  process.exit(1);
}

const componentDir = path.join(
  repoRoot,
  "packages/ui/src/components/ui",
);
const storyDir = path.join(repoRoot, "apps/storybook/src/stories");

async function readStory(name) {
  for (const ext of [".stories.tsx", ".stories.ts"]) {
    const file = path.join(storyDir, `${name}${ext}`);
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      // try next
    }
  }
  return "";
}

function namesMatch(expected, extracted) {
  if (expected === extracted) {
    return true;
  }
  if (expected.toLowerCase() === extracted.toLowerCase()) {
    return true;
  }
  if (extracted.startsWith(expected) || expected.startsWith(extracted)) {
    return true;
  }
  return false;
}

function classify(name, componentContent, storyContent, extractedName) {
  if (!namesMatch(name, extractedName)) {
    return "broken";
  }
  if (storyContent) {
    return "works";
  }
  const metadata = extractExistingPreviewMetadata(componentContent, storyContent);
  defaultPreviewArgs({
    componentName: name,
    storyFormat: storyContent ? "csf3" : "none",
    componentContent,
    storyContent,
    variants: metadata.variants,
    variantLabel: metadata.variantLabel,
    propControls: metadata.propControls,
  });
  if (!storyContent && /(?:ListItem|Group|Table|Navigation|Layout|Screen)/.test(name)) {
    return "risky";
  }
  return storyContent || Object.keys(metadata.variants).length > 0 ? "works" : "risky";
}

const entries = await fs.readdir(componentDir);
const components = entries.filter((f) => f.endsWith(".tsx")).map((f) => ({
  file: f,
  name: f.replace(/\.tsx$/, "").replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase()).replace(/-/g, ""),
}));

// kebab to PascalCase fix
function fileBaseToPascal(file) {
  return file
    .replace(/\.tsx$/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const buckets = { works: [], risky: [], broken: [] };

for (const file of entries.filter((f) => f.endsWith(".tsx"))) {
  const base = file.replace(/\.tsx$/, "");
  const name = fileBaseToPascal(file);
  const componentPath = path.join(componentDir, file);
  const componentContent = await fs.readFile(componentPath, "utf8");
  const storyContent = await readStory(name);
  const extractedName = extractComponentName(componentContent, name);
  const status = classify(name, componentContent, storyContent, extractedName);
  buckets[status].push(name);
}

console.log(JSON.stringify({
  total: entries.filter((f) => f.endsWith(".tsx")).length,
  works: buckets.works.length,
  risky: buckets.risky.length,
  broken: buckets.broken.length,
  buckets,
}, null, 2));
