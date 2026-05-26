import assert from "node:assert/strict";
import { describe, it } from "node:test";
import app from "./index.js";

describe("api", () => {
  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("GET /capabilities lists allowlisted models", async () => {
    const res = await app.request("/capabilities");
    const body = (await res.json()) as { models: Array<{ modelId: string }> };
    assert.ok(body.models.length >= 1);
  });

  it("OPTIONS /repos/refs includes CORS headers for plugin preflight", async () => {
    const res = await app.request("/repos/refs", {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "null");
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  });
});
