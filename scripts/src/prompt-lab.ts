#!/usr/bin/env node
/**
 * Runs golden PrunedSpec fixtures through prompt envelope builder.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildComponentEnvelope } from "@fig2code/prompts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../packages/prompts/fixtures");
const goldenButton = JSON.parse(
  readFileSync(join(fixturesDir, "golden-button-pruned-spec.json"), "utf8"),
);

const envelope = buildComponentEnvelope({
  profile: "component-v1",
  modelId: "anthropic/claude-sonnet",
  jobFacts: { intent: "component", targets: ["web"] },
  prunedSpec: goldenButton,
  projectTokens: { categories: {} },
  tokenResolver: { "color/primary/500": "bg-primary-500" },
  registryHints: { Button: "src/components/Button" },
  exampleStyles: "// example component digest",
});

console.log(JSON.stringify({
  profile: envelope.profile,
  modelId: envelope.modelId,
  estimatedTotalTokens: envelope.estimatedTotalTokens,
  slotIds: envelope.slots.map((s) => s.id),
}, null, 2));
