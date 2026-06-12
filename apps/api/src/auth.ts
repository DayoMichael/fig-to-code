import { randomUUID } from "node:crypto";
import { Hono } from "hono";

/**
 * OAuth for the Figma plugin. Plugins can't receive browser redirects, so the
 * flow is a browser handoff:
 *
 *   1. plugin → POST /auth/:provider/start        → { authUrl, pollKey }
 *   2. plugin opens authUrl in the system browser
 *   3. provider → GET /auth/:provider/callback    (code exchanged server-side)
 *   4. plugin polls GET /auth/result/:pollKey     → { token } exactly once
 *
 * Tokens are held in memory only, keyed by an unguessable pollKey, deleted on
 * first read or after a short TTL. Provider apps are configured via env:
 * GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET and
 * BITBUCKET_OAUTH_CLIENT_ID / BITBUCKET_OAUTH_CLIENT_SECRET, with redirect
 * URIs pointing at {PUBLIC_API_BASE}/auth/:provider/callback.
 */

export type OAuthProviderId = "github" | "bitbucket";

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export interface AuthRouterOptions {
  providers?: Partial<Record<OAuthProviderId, OAuthProviderConfig>>;
  /** Public base URL of this API, used to build redirect URIs. */
  publicBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface PendingAuth {
  provider: OAuthProviderId;
  pollKey: string;
  createdAt: number;
}

interface AuthResult {
  provider: OAuthProviderId;
  token: string;
  /** Bitbucket OAuth tokens expire (~2h); surfaced so the plugin can warn. */
  expiresInSeconds?: number;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

export function resolveOAuthProviders(
  explicit?: Partial<Record<OAuthProviderId, OAuthProviderConfig>>,
): Partial<Record<OAuthProviderId, OAuthProviderConfig>> {
  if (explicit) return explicit;
  const providers: Partial<Record<OAuthProviderId, OAuthProviderConfig>> = {};
  if (process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET) {
    providers.github = {
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
    };
  }
  if (process.env.BITBUCKET_OAUTH_CLIENT_ID && process.env.BITBUCKET_OAUTH_CLIENT_SECRET) {
    providers.bitbucket = {
      clientId: process.env.BITBUCKET_OAUTH_CLIENT_ID,
      clientSecret: process.env.BITBUCKET_OAUTH_CLIENT_SECRET,
    };
  }
  return providers;
}

export function createAuthRouter(options: AuthRouterOptions = {}): Hono {
  const providers = resolveOAuthProviders(options.providers);
  const publicBaseUrl = (
    options.publicBaseUrl ??
    process.env.PUBLIC_API_BASE ??
    `http://localhost:${process.env.PORT ?? 3000}`
  ).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  const pendingByState = new Map<string, PendingAuth>();
  const resultsByPollKey = new Map<string, AuthResult>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [state, pending] of pendingByState) {
      if (now - pending.createdAt > PENDING_TTL_MS) pendingByState.delete(state);
    }
    for (const [key, result] of resultsByPollKey) {
      if (now - result.createdAt > PENDING_TTL_MS) resultsByPollKey.delete(key);
    }
  }, 60_000);
  sweep.unref?.();

  const app = new Hono();

  app.post("/:provider/start", (c) => {
    const provider = c.req.param("provider") as OAuthProviderId;
    const config = providers[provider];
    if (!config) {
      return c.json({ error: `OAuth is not configured for ${provider}` }, 400);
    }

    const state = randomUUID();
    const pollKey = randomUUID();
    pendingByState.set(state, { provider, pollKey, createdAt: Date.now() });

    const redirectUri = `${publicBaseUrl}/auth/${provider}/callback`;
    const authUrl =
      provider === "github"
        ? `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(config.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo&state=${state}`
        : `https://bitbucket.org/site/oauth2/authorize?client_id=${encodeURIComponent(config.clientId)}&response_type=code&state=${state}`;

    return c.json({ authUrl, pollKey });
  });

  app.get("/:provider/callback", async (c) => {
    const provider = c.req.param("provider") as OAuthProviderId;
    const config = providers[provider];
    const code = c.req.query("code");
    const state = c.req.query("state");

    const pending = state ? pendingByState.get(state) : undefined;
    if (state) pendingByState.delete(state);

    if (!config || !code || !pending || pending.provider !== provider) {
      return c.html(callbackHtml(false, "This sign-in link is invalid or has expired. Return to Figma and try again."), 400);
    }

    try {
      const redirectUri = `${publicBaseUrl}/auth/${provider}/callback`;
      const result =
        provider === "github"
          ? await exchangeGitHubCode(fetchImpl, config, code, redirectUri)
          : await exchangeBitbucketCode(fetchImpl, config, code);

      resultsByPollKey.set(pending.pollKey, {
        provider,
        token: result.token,
        expiresInSeconds: result.expiresInSeconds,
        createdAt: Date.now(),
      });
      return c.html(callbackHtml(true));
    } catch (err) {
      console.error(`[fig2code] ${provider} oauth exchange failed`, err);
      return c.html(callbackHtml(false, "Sign-in failed while talking to the provider. Return to Figma and try again."), 502);
    }
  });

  app.get("/result/:pollKey", (c) => {
    const pollKey = c.req.param("pollKey");
    const result = resultsByPollKey.get(pollKey);
    if (!result) {
      // Still pending or never existed — the plugin polls until TTL.
      return c.json({ pending: true }, 202);
    }
    // One-time read: the poller is the only legitimate holder of the key.
    resultsByPollKey.delete(pollKey);
    return c.json({
      provider: result.provider,
      token: result.token,
      expiresInSeconds: result.expiresInSeconds,
    });
  });

  return app;
}

async function exchangeGitHubCode(
  fetchImpl: typeof fetch,
  config: OAuthProviderConfig,
  code: string,
  redirectUri: string,
): Promise<{ token: string; expiresInSeconds?: number }> {
  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `GitHub exchange failed (${res.status})`);
  }
  return { token: body.access_token };
}

async function exchangeBitbucketCode(
  fetchImpl: typeof fetch,
  config: OAuthProviderConfig,
  code: string,
): Promise<{ token: string; expiresInSeconds?: number }> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64");
  const res = await fetchImpl("https://bitbucket.org/site/oauth2/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
  });
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `Bitbucket exchange failed (${res.status})`);
  }
  return { token: body.access_token, expiresInSeconds: body.expires_in };
}

function callbackHtml(success: boolean, message?: string): string {
  const title = success ? "Connected!" : "Sign-in failed";
  const detail = success
    ? "You're signed in. Return to Figma — the plugin will pick it up automatically."
    : (message ?? "Something went wrong.");
  const color = success ? "#15803d" : "#b91c1c";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Fig2Code · ${title}</title>
  <style>
    body { margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; font-family: Inter, system-ui, sans-serif; background: #f8fafc; color: #374151; }
    .card { text-align: center; max-width: 420px; padding: 32px; }
    h1 { font-size: 20px; color: ${color}; margin: 0 0 8px; }
    p { font-size: 14px; line-height: 1.6; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${detail}</p>
  </div>
</body>
</html>`;
}
