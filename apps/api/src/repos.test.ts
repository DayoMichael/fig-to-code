import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixturePath } from "@fig2code/repo";
import app from "./index.js";
import { formatRepoUrl } from "./repos.js";

describe("repos routes", () => {
  it("GET /repos/fixtures lists fixture paths", async () => {
    const res = await app.request("/repos/fixtures");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tailwind: string; styled: string };
    assert.ok(body.tailwind.includes("tailwind-app"));
    assert.ok(body.styled.includes("styled-app"));
  });

  it("POST /repos/detect/local runs auto-detect on tailwind fixture", async () => {
    const res = await app.request("/repos/detect/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: fixturePath("tailwind-app"),
        vcs: {
          provider: "github",
          owner: "acme",
          repo: "tailwind-app",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      detected: { styleSystem: string };
      syncConfig: { web?: { styleSystem?: string } };
    };
    assert.equal(body.detected.styleSystem, "tailwind");
    assert.equal(body.syncConfig.web?.styleSystem, "tailwind");
  });

  it("POST /repos/refs accepts Bitbucket without email for repository access tokens", async () => {
    const res = await app.request("/repos/refs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vcs: {
          provider: "bitbucket",
          workspace: "acme",
          repo: "app",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
        token: "secret",
      }),
    });

    assert.notEqual(res.status, 400);
  });

  it("POST /repos/refs rejects missing token", async () => {
    const res = await app.request("/repos/refs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vcs: {
          provider: "bitbucket",
          workspace: "acme",
          repo: "app",
          baseBranch: "main",
          defaultPrTarget: "main",
        },
        token: "",
      }),
    });

    assert.equal(res.status, 400);
  });

  it("formatRepoUrl builds bitbucket url", () => {
    assert.equal(
      formatRepoUrl({
        provider: "bitbucket",
        workspace: "acme-team",
        repo: "design-system",
        baseBranch: "main",
        defaultPrTarget: "main",
      }),
      "bitbucket.org/acme-team/design-system",
    );
  });
});
