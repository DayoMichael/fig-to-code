import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseViteReadyPort } from "./preview-session.js";

describe("parseViteReadyPort", () => {
  it("parses classic Vite local URL banner", () => {
    const output = `
  VITE v6.0.0  ready in 842 ms
  ➜  Local:   http://127.0.0.1:58676/
`;
    assert.equal(parseViteReadyPort(output), 58676);
  });

  it("parses localhost banner", () => {
    assert.equal(
      parseViteReadyPort("  Local:   http://localhost:5173/\n"),
      5173,
    );
  });

  it("returns null when banner is missing", () => {
    assert.equal(parseViteReadyPort("optimizing dependencies...\n"), null);
  });
});
