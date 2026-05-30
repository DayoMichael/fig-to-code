import { GitHostApiError } from "./fetch.js";

export function formatGitHostApiError(
  error: GitHostApiError,
  provider?: string,
): string {
  if (error.status === 401 || error.status === 403) {
    if (provider === "bitbucket") {
      return [
        "Bitbucket authentication failed.",
        "For API tokens: use your Atlassian account email (Bitbucket → Personal settings → Email aliases), not your Bitbucket username.",
        "The token must include Repository read scope (read:repository:bitbucket).",
        "Create tokens at id.atlassian.com → Security → API tokens → Create API token with scopes → Bitbucket Cloud.",
        "If you use a repository access token instead, leave the email field empty.",
      ].join(" ");
    }

    return `Authentication failed (${error.status}). Check your token and permissions.`;
  }

  const detail = (error.body ?? "").trim();
  return detail ? `${error.message} ${detail}` : error.message;
}
