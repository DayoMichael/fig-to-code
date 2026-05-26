#!/usr/bin/env node
/**
 * Internal engineering script — scaffolds new Fig2Code packages.
 * Cursor SDK integration lands in a later milestone; this is the M0 stub.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const name = process.argv[2];

if (!name) {
  console.error("Usage: pnpm --filter @fig2code/scripts scaffold <package-name>");
  process.exit(1);
}

const pkgDir = join(process.cwd(), "..", "packages", name);

mkdirSync(join(pkgDir, "src"), { recursive: true });

writeFileSync(
  join(pkgDir, "package.json"),
  JSON.stringify(
    {
      name: `@fig2code/${name}`,
      version: "0.0.0",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        clean: "rm -rf dist",
      },
    },
    null,
    2,
  ),
);

writeFileSync(
  join(pkgDir, "tsconfig.json"),
  JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      compilerOptions: { outDir: "dist", rootDir: "src" },
      include: ["src"],
    },
    null,
    2,
  ),
);

writeFileSync(join(pkgDir, "src/index.ts"), `export const PACKAGE = "@fig2code/${name}";\n`);

console.log(`Scaffolded packages/${name}`);
