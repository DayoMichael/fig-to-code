import { GitHostApiError } from "./fetch.js";

export function formatGitHostApiError(
  error: GitHostApiError,
  provider?: string,
): string {
  if (error.status === 401 || error.status === 403) {
    if (provider === "bitbucket") {
      return [
        "Bitbucket authentication failed.",
        "API tokens (they start with ATATT): pair with your Atlassian account email, include Repository read scope (read:repository:bitbucket), create at id.atlassian.com → Security → API tokens → Create API token with scopes → Bitbucket Cloud.",
        "Repository/workspace access tokens: leave the email field empty.",
        "Signed in with Bitbucket? Sessions expire after ~2 hours — sign in again.",
      ].join(" ");
    }

    return `Authentication failed (${error.status}). Check your token and permissions.`;
  }

  const detail = (error.body ?? "").trim();
  return detail ? `${error.message} ${detail}` : error.message;
}
