import fs from "node:fs";
import path from "node:path";

// Resolving the Anthropic credential the sandboxed agent uses. The sandbox
// scrubs the host env and excludes the host filesystem, so a credential must be
// passed in explicitly. Precedence (highest first):
//   1. a credential already in the container env — an ANTHROPIC_API_KEY or
//      CLAUDE_CODE_OAUTH_TOKEN supplied by the host env OR the document's own env
//      (this is the channel the future per-user credential feature will use —
//      see TODO.md "Per-user agent credentials").
//   2. the host's Claude Code OAuth session (~/.claude/.credentials.json): inject
//      its short-lived accessToken as CLAUDE_CODE_OAUTH_TOKEN. This is the
//      stopgap so existing logins keep working; it exposes only the access token
//      (never the refresh token) to the agent — strictly less than the
//      in-process path, where the agent could read the whole credentials file.

export function hasAnthropicCredential(env: Record<string, string | undefined>): boolean {
  return Boolean(
    (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim()) ||
      (env.CLAUDE_CODE_OAUTH_TOKEN && env.CLAUDE_CODE_OAUTH_TOKEN.trim())
  );
}

export type HostClaudeOAuth = {
  token: string;
  /** Epoch ms when the access token expires, if known. */
  expiresAt: number | null;
};

// Read the access token from a Claude Code OAuth credentials file. Returns null
// if the file is missing/unreadable/not an OAuth session.
export function readHostClaudeOAuth(opts: {
  homeDir?: string | undefined;
  credentialsPath?: string;
}): HostClaudeOAuth | null {
  const credentialsPath =
    opts.credentialsPath ??
    (opts.homeDir ? path.join(opts.homeDir, ".claude", ".credentials.json") : undefined);
  if (!credentialsPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || !token) return null;
    const expiresAt =
      typeof parsed.claudeAiOauth?.expiresAt === "number" ? parsed.claudeAiOauth.expiresAt : null;
    return { token, expiresAt };
  } catch {
    return null;
  }
}

// Given the container env already assembled from host + document env, return any
// credential vars to ADD. Empty if a credential is already present or none can
// be found. `now` is injectable for tests.
export function resolveAgentCredentialEnv(
  containerEnv: Record<string, string | undefined>,
  opts: { homeDir?: string | undefined; credentialsPath?: string; now?: number } = {}
): { added: Record<string, string>; warning: string | null } {
  if (hasAnthropicCredential(containerEnv)) {
    return { added: {}, warning: null };
  }
  const oauth = readHostClaudeOAuth(opts);
  if (!oauth) {
    return {
      added: {},
      warning:
        "no Anthropic credential available for the sandboxed agent (no ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN in env or document env, and no readable ~/.claude OAuth session); the agent will fail to authenticate."
    };
  }
  const now = opts.now ?? Date.now();
  const warning =
    oauth.expiresAt && oauth.expiresAt < now
      ? "host ~/.claude OAuth access token appears expired; the agent may fail to authenticate until you refresh it (run `claude`)."
      : null;
  return { added: { CLAUDE_CODE_OAUTH_TOKEN: oauth.token }, warning };
}
