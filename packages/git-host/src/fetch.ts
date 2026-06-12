import type { GitHostAuth } from "./auth.js";
import { bitbucketAuthorizationHeader } from "./auth.js";

export type FetchFn = typeof fetch;

let fetchImpl: FetchFn = globalThis.fetch.bind(globalThis);

export function setFetchImplementation(fn: FetchFn): void {
  fetchImpl = fn;
}

export function resetFetchImplementation(): void {
  fetchImpl = globalThis.fetch.bind(globalThis);
}

export async function bitbucketFetch(
  url: string,
  init: RequestInit & { auth: GitHostAuth },
): Promise<Response> {
  const { auth, headers, ...rest } = init;
  const response = await fetchImpl(url, {
    ...rest,
    headers: {
      Accept: "application/json",
      Authorization: bitbucketAuthorizationHeader(auth),
      ...headers,
    },
  });

  // An email turns auth into Basic email:token — correct for Atlassian API
  // tokens, guaranteed 401 for repository/workspace access tokens and OAuth
  // tokens, which are Bearer-only. Users routinely fill the email field with
  // the wrong token kind; one Bearer retry self-heals that instead of walling
  // them off with an auth error. (Bodies here are strings, safe to resend.)
  if (response.status === 401 && auth.atlassianEmail?.trim()) {
    return fetchImpl(url, {
      ...rest,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.token.trim()}`,
        ...headers,
      },
    });
  }

  return response;
}

export async function hostFetch(
  url: string,
  init: RequestInit & { token: string },
): Promise<Response> {
  const { token, headers, ...rest } = init;
  return fetchImpl(url, {
    ...rest,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
  });
}

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new GitHostApiError(response.status, body);
  }
  return response.json() as Promise<T>;
}

export class GitHostApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly operation?: string,
  ) {
    const prefix = operation ? ` (${operation})` : "";
    super(`Git host API error ${status}${prefix}: ${body.slice(0, 500)}`);
    this.name = "GitHostApiError";
  }
}
