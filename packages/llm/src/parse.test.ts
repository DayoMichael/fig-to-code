import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { extractCodegenJson, extractBalancedJsonObject, parseCodegenOutput } from "./parse.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

describe("parseCodegenOutput", () => {
  it("parses bare JSON codegen output", () => {
    const raw = readFileSync(join(fixturesDir, "golden-codegen-response.json"), "utf8");
    const output = parseCodegenOutput(raw);

    assert.equal(output.patches.length, 2);
    assert.equal(output.patches[0]?.path, "src/components/Button/Button.tsx");
    assert.match(output.summary ?? "", /Generated Button/);
  });

  it("extracts JSON from fenced model output", () => {
    const raw = readFileSync(join(fixturesDir, "golden-codegen-response-fenced.txt"), "utf8");
    const output = parseCodegenOutput(raw);

    assert.equal(output.patches.length, 1);
    assert.equal(output.patches[0]?.action, "create");
  });

  it("rejects patches missing required content", () => {
    assert.throws(
      () =>
        parseCodegenOutput(
          JSON.stringify({
            patches: [{ path: "src/Button.tsx", action: "create" }],
          }),
        ),
      /content is required/,
    );
  });

  it("extractCodegenJson throws when no JSON is present", () => {
    assert.throws(() => extractCodegenJson("not json at all"), /Could not locate JSON/);
  });

  it("repairs invalid escape sequences in model JSON output", () => {
    const raw = String.raw`{"patches":[{"path":"src/Button.tsx","action":"create","content":"const pattern = /\d+/;\nconst path = \"C:\Users\dev\";"}],"summary":"ok"}`;
    const output = parseCodegenOutput(raw);

    assert.equal(output.patches.length, 1);
    assert.match(output.patches[0]?.content ?? "", /\\d+/);
    assert.match(output.patches[0]?.content ?? "", /C:\\Users\\dev/);
  });

  it("extractBalancedJsonObject ignores trailing prose after JSON", () => {
    const json =
      '{"patches":[{"path":"src/Button.tsx","action":"update","content":"function Button() { return 1; }"}],"summary":"ok"}';
    const raw = `Here is the update:\n${json}\n\nLet me know if you need changes.`;
    const start = raw.indexOf("{");
    const balanced = extractBalancedJsonObject(raw, start);
    assert.equal(balanced, json);
    const output = parseCodegenOutput(raw);
    assert.equal(output.patches.length, 1);
  });

  it("formatCodegenParseError explains truncated JSON", () => {
    assert.throws(
      () =>
        parseCodegenOutput(
          '{"patches":[{"path":"x.tsx","action":"update","content":"export function X() {\\n  return \\"hi',
        ),
      /invalid or truncated JSON/i,
    );
  });
});
