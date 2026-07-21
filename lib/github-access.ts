const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 8_000;

type FetchLike = typeof fetch;

export type RepoAccessResult = {
  /** True when the given token (or anonymous access) can read the repository. */
  ok: boolean;
  /** Login of the GitHub account the token authenticates as, when known. */
  login: string | null;
  /** True when the token has push access (private repos need this for branch pushes). */
  canPush: boolean;
  /** True when a pending collaborator invitation was accepted during this check. */
  acceptedInvitation: boolean;
  reason: "ok" | "not-github" | "no-access" | "check-failed";
};

export function getGithubRepoFullName(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const httpsMatch = repoUrl.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  const sshMatch = repoUrl.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  const match = httpsMatch ?? sshMatch;
  return match ? `${match[1]}/${match[2]}` : null;
}

function githubHeaders(token: string | null | undefined) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "r-docs"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export type GithubIdentity = { login: string; id: number };

const identityCache = new Map<string, GithubIdentity>();

export function resetGithubAccessCacheForTests() {
  identityCache.clear();
}

/** The GitHub account behind a token. Cached per token after the first successful lookup. */
export async function resolveGithubIdentity(
  token: string | null | undefined,
  fetchImpl: FetchLike = fetch
): Promise<GithubIdentity | null> {
  if (!token) return null;
  const cached = identityCache.get(token);
  if (cached) return cached;
  try {
    const res = await fetchImpl(`${GITHUB_API}/user`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { login?: string; id?: number };
    if (!body.login || typeof body.id !== "number") return null;
    const identity = { login: body.login, id: body.id };
    identityCache.set(token, identity);
    return identity;
  } catch {
    return null;
  }
}

/**
 * Accept a pending collaborator invitation for exactly this repository, if the
 * token's account has one. Only the invitation matching the repo a user is
 * linking is accepted — never a blanket accept-all, so an unsolicited invite
 * does nothing until a document actually links that repo.
 */
export async function acceptPendingRepoInvitation(
  repoFullName: string,
  token: string | null | undefined,
  fetchImpl: FetchLike = fetch
): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetchImpl(`${GITHUB_API}/user/repository_invitations?per_page=100`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) return false;
    const invitations = (await res.json()) as Array<{
      id?: number;
      repository?: { full_name?: string };
    }>;
    const match = invitations.find(
      (inv) => inv?.repository?.full_name?.toLowerCase() === repoFullName.toLowerCase()
    );
    if (!match?.id) return false;
    const accept = await fetchImpl(`${GITHUB_API}/user/repository_invitations/${match.id}`, {
      method: "PATCH",
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    return accept.status === 204;
  } catch {
    return false;
  }
}

async function fetchRepoAccess(
  repoFullName: string,
  token: string | null | undefined,
  fetchImpl: FetchLike
) {
  const res = await fetchImpl(`${GITHUB_API}/repos/${repoFullName}`, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (res.ok) {
    const body = (await res.json()) as { permissions?: { push?: boolean } };
    return { accessible: true, canPush: Boolean(body.permissions?.push) };
  }
  return { accessible: false, canPush: false };
}

/**
 * Check whether `token` (or anonymous access, when null) can read `repoUrl`.
 * On a miss, accept a pending collaborator invitation for that repo (if any)
 * and re-check, so "invite the account → press Save again" works without
 * manual intervention.
 */
export async function checkRepoAccess(
  repoUrl: string,
  token: string | null | undefined,
  fetchImpl: FetchLike = fetch
): Promise<RepoAccessResult> {
  const repoFullName = getGithubRepoFullName(repoUrl);
  if (!repoFullName) {
    return { ok: true, login: null, canPush: false, acceptedInvitation: false, reason: "not-github" };
  }

  const identity = await resolveGithubIdentity(token, fetchImpl);
  const login = identity?.login ?? null;

  try {
    let access = await fetchRepoAccess(repoFullName, token, fetchImpl);
    let acceptedInvitation = false;

    if (!access.accessible && token) {
      acceptedInvitation = await acceptPendingRepoInvitation(repoFullName, token, fetchImpl);
      if (acceptedInvitation) {
        access = await fetchRepoAccess(repoFullName, token, fetchImpl);
      }
    }

    return {
      ok: access.accessible,
      login,
      canPush: access.canPush,
      acceptedInvitation,
      reason: access.accessible ? "ok" : "no-access"
    };
  } catch {
    // Network trouble reaching the GitHub API — don't block linking on it.
    return { ok: true, login, canPush: false, acceptedInvitation: false, reason: "check-failed" };
  }
}
