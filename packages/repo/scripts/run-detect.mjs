import { performance } from "node:perf_hooks";
import { detectProjectConfig, detectedConfigToSyncConfig } from "../dist/detect.js";

const args = process.argv.slice(2);
const bench = args.includes("--bench");
const rootDir = args.find((arg) => !arg.startsWith("--"));

if (!rootDir) {
  console.error("Usage: node scripts/run-detect.mjs <repo-root> [--bench]");
  process.exit(1);
}

async function runOnce() {
  const start = performance.now();
  const detected = await detectProjectConfig({ rootDir });
  const elapsed = performance.now() - start;
  return { detected, elapsed };
}

if (bench) {
  const runs = 5;
  const timings = [];
  let detected;

  for (let i = 0; i < runs; i += 1) {
    const result = await runOnce();
    detected = result.detected;
    timings.push(result.elapsed);
  }

  const avg = timings.reduce((sum, value) => sum + value, 0) / timings.length;
  const min = Math.min(...timings);
  const max = Math.max(...timings);

  console.log("=== BENCHMARK ===");
  console.log(`runs: ${runs}`);
  console.log(`avg: ${avg.toFixed(1)}ms`);
  console.log(`min: ${min.toFixed(1)}ms`);
  console.log(`max: ${max.toFixed(1)}ms`);
  console.log(`components: ${detected?.existingComponents.length ?? 0}`);
  process.exit(0);
}

const { detected, elapsed } = await runOnce();
const syncConfig = detectedConfigToSyncConfig(detected, {
  provider: "bitbucket",
  workspace: "Kuda-engineering",
  repo: "kuda-web-component-library",
  baseBranch: "main",
  defaultPrTarget: "main",
});

console.log(`detect: ${elapsed.toFixed(1)}ms`);
console.log("=== DETECTION SUMMARY ===");
console.log("styleSystem:", detected.styleSystem);
console.log("tailwindConfigPath:", detected.tailwindConfigPath);
console.log("testFramework:", detected.testFramework);
console.log("storyFormat:", detected.storyFormat);
console.log("fileNaming:", detected.fileNaming);
console.log("componentPaths:", detected.componentPaths);
console.log("tokenPaths:", detected.tokenPaths);
console.log("iconPaths:", detected.iconPaths);
console.log("fontPaths:", detected.fontPaths);
console.log("platforms:", detected.platforms);
console.log("existingComponents count:", detected.existingComponents.length);
console.log(
  "existingComponents:",
  detected.existingComponents.slice(0, 20).map((c) => `${c.name} (${c.path})`),
);
console.log("existingTokens:", detected.existingTokens);
console.log("\n=== SYNC CONFIG WEB ===");
console.log(JSON.stringify(syncConfig.web, null, 2));
