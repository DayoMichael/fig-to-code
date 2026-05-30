/**
 * Audits story discovery the same way resolveComponentBundle + preview do.
 * Run: node scripts/story-resolution-audit.mjs [repoRoot]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveComponentBundle } from "../packages/repo/dist/resolve-component.js";

const repoRoot = process.argv[2] ?? process.env.FIG2CODE_AUDIT_REPO;
if (!repoRoot) {
  console.error("Usage: node scripts/story-resolution-audit.mjs <repoRoot>");
  process.exit(1);
}

const kudaSyncConfig = {
  vcs: {
    provider: "github",
    owner: "kuda",
    repo: "kuda-web-component-library",
    baseBranch: "main",
    defaultPrTarget: "main",
  },
  platforms: ["web"],
  web: {
    styleSystem: "tailwind",
    componentPath: "packages/ui/src/components/ui",
    tokenPaths: ["packages/ui/src/styles/tokens.css"],
    iconPath: "packages/ui/src/components/icons",
    exampleComponent: "packages/ui/src/components/ui/button.tsx",
  },
  conventions: {
    exportStyle: "named",
    propsPattern: "interface",
    fileNaming: "kebab-case",
    testFramework: "vitest",
    storyFormat: "csf3",
  },
};

const readFile = async (filePath) => {
  try {
    return await fs.readFile(path.join(repoRoot, filePath), "utf8");
  } catch {
    return null;
  }
};

function fileBaseToPascal(file) {
  return file
    .replace(/\.tsx$/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function figmaStyleName(pascal) {
  return pascal.replace(/([a-z])([A-Z])/g, "$1 $2");
}

const componentDir = path.join(repoRoot, "packages/ui/src/components/ui");
const entries = await fs.readdir(componentDir);
const componentFiles = entries.filter((f) => f.endsWith(".tsx"));

async function auditWithName(name) {
  const bucket = { storyFound: [], storyMissing: [], resolveFailed: [] };

  for (const file of componentFiles.sort()) {
    const pascal = fileBaseToPascal(file);
    const queryName = name === "figma" ? figmaStyleName(pascal) : pascal;
    const bundle = await resolveComponentBundle({
      componentName: queryName,
      syncConfig: kudaSyncConfig,
      readFile,
    });

    if (!bundle) {
      bucket.resolveFailed.push({ file, queryName });
      continue;
    }

    const storyFile = bundle.files.find((f) => f.role === "story");
    if (storyFile?.content?.trim()) {
      bucket.storyFound.push(pascal);
    } else {
      bucket.storyMissing.push(pascal);
    }
  }

  return bucket;
}

const pascalAudit = await auditWithName("pascal");
const figmaAudit = await auditWithName("figma");

console.log(
  JSON.stringify(
    {
      total: componentFiles.length,
      pascalCaseNames: {
        storyFound: pascalAudit.storyFound.length,
        storyMissing: pascalAudit.storyMissing.length,
        missing: pascalAudit.storyMissing,
      },
      figmaSpacedNames: {
        storyFound: figmaAudit.storyFound.length,
        storyMissing: figmaAudit.storyMissing.length,
        missing: figmaAudit.storyMissing,
      },
      previewMode: {
        withStory: figmaAudit.storyFound.length,
        fallback: figmaAudit.storyMissing.length,
      },
    },
    null,
    2,
  ),
);
