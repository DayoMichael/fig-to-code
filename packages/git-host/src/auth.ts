export interface GitHostAuth {
  token: string;
  /** Atlassian account email — required for Bitbucket Cloud API tokens on REST APIs. */
  atlassianEmail?: string;
}

export function asGitHostAuth(token: string | GitHostAuth): GitHostAuth {
  return typeof token === "string" ? { token } : token;
}

export function bitbucketAuthorizationHeader(auth: GitHostAuth): string {
  const token = auth.token.trim();
  const email = auth.atlassianEmail?.trim();

  if (email) {
    return `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
  }

  // Repository access tokens use Bearer. API tokens without an email in the form
  // can still authenticate for Git; REST may require the Atlassian email instead.
  return `Bearer ${token}`;
}
