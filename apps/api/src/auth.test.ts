import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { createAuthRouter } from "./auth.js";

function buildApp(fetchImpl: typeof fetch): Hono {
  const app = new Hono();
  app.route(
    "/auth",
    createAuthRouter({
      providers: {
        github: { clientId: "gh-client", clientSecret: "gh-secret" },
        bitbucket: { clientId: "bb-client", clientSecret: "bb-secret" },
      },
      publicBaseUrl: "https://api.example.com",
      fetchImpl,
    }),
  );
  return app;
}

describe("auth router", () => {
  it("start → callback → poll hands the GitHub token over exactly once", async () => {
    const app = buildApp(async (url, init) => {
      assert.equal(String(url), "https://github.com/login/oauth/access_token");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.client_id, "gh-client");
      assert.equal(body.code, "the-code");
      assert.equal(body.redirect_uri, "https://api.example.com/auth/github/callback");
      return new Response(JSON.stringify({ access_token: "gho_oauth_token" }), { status: 200 });
    });

    const startRes = await app.request("/auth/github/start", { method: "POST" });
    assert.equal(startRes.status, 200);
    const start = (await startRes.json()) as { authUrl: string; pollKey: string };
    assert.match(start.authUrl, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    assert.match(start.authUrl, /scope=repo/);
    const state = new URL(start.authUrl).searchParams.get("state")!;

    // Polling before the callback reports pending.
    const early = await app.request(`/auth/result/${start.pollKey}`);
    assert.equal(early.status, 202);

    const cbRes = await app.request(`/auth/github/callback?code=the-code&state=${state}`);
    assert.equal(cbRes.status, 200);
    assert.match(await cbRes.text(), /Connected!/);

    const pollRes = await app.request(`/auth/result/${start.pollKey}`);
    assert.equal(pollRes.status, 200);
    const result = (await pollRes.json()) as { token: string; provider: string };
    assert.equal(result.token, "gho_oauth_token");
    assert.equal(result.provider, "github");

    // One-time read: the second poll must not return the token again.
    const second = await app.request(`/auth/result/${start.pollKey}`);
    assert.equal(second.status, 202);
  });

  it("exchanges Bitbucket codes with basic auth and surfaces expiry", async () => {
    const app = buildApp(async (url, init) => {
      assert.equal(String(url), "https://bitbucket.org/site/oauth2/access_token");
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get("Authorization"),
        `Basic ${Buffer.from("bb-client:bb-secret").toString("base64")}`,
      );
      assert.match(String(init?.body), /grant_type=authorization_code/);
      return new Response(
        JSON.stringify({ access_token: "bb_token", expires_in: 7200 }),
        { status: 200 },
      );
    });

    const start = (await (
      await app.request("/auth/bitbucket/start", { method: "POST" })
    ).json()) as { authUrl: string; pollKey: string };
    const state = new URL(start.authUrl).searchParams.get("state")!;

    await app.request(`/auth/bitbucket/callback?code=c&state=${state}`);
    const result = (await (
      await app.request(`/auth/result/${start.pollKey}`)
    ).json()) as { token: string; expiresInSeconds?: number };
    assert.equal(result.token, "bb_token");
    assert.equal(result.expiresInSeconds, 7200);
  });

  it("rejects callbacks with an unknown or reused state", async () => {
    const app = buildApp(async () => {
      throw new Error("exchange must not be attempted");
    });
    const res = await app.request("/auth/github/callback?code=x&state=forged");
    assert.equal(res.status, 400);
    assert.match(await res.text(), /invalid or has expired/);
  });

  it("refuses to start a flow for unconfigured providers", async () => {
    const app = new Hono();
    app.route("/auth", createAuthRouter({ providers: {}, publicBaseUrl: "https://x" }));
    const res = await app.request("/auth/github/start", { method: "POST" });
    assert.equal(res.status, 400);
  });
});
