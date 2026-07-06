import fs from "node:fs";
import path from "node:path";

import { agentModelProvider } from "../../agent-core/agent-config";

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

// A host OAuth access token expiring within this window is treated as unusable:
// the run would very likely die with a 401 mid-flight. Injecting it "hopefully"
// is what produced the reported "401 Invalid authentication credentials" failure.
export const OAUTH_EXPIRY_MARGIN_MS = 2 * 60 * 1000;

// Actionable message surfaced when the host session cannot supply a usable token.
export const HOST_SESSION_EXPIRED_MESSAGE =
  "host Claude session expired — run `claude` on the host to refresh it, or set " +
  "ANTHROPIC_API_KEY (or a document OPENROUTER_API_KEY) so the agent has a durable credential.";

// Given the container env already assembled from host + document env, return any
// credential vars to ADD. Empty if a credential is already present or none can
// be found. `now` is injectable for tests.
//
// Freshness gate: this reads the host credentials file fresh at call time (so a
// refresh performed by Claude Code on the host is picked up), and REFUSES to
// inject an OAuth token that is already expired or expires within
// OAUTH_EXPIRY_MARGIN_MS. In that case it returns an actionable `error` and an
// empty `added` so the caller can fail fast instead of shipping a doomed token
// into the sandbox. Callers that retry should call this again — the retry re-reads
// the file and can pick up a token Claude Code refreshed in the meantime.
export function resolveAgentCredentialEnv(
  containerEnv: Record<string, string | undefined>,
  opts: { homeDir?: string | undefined; credentialsPath?: string; now?: number } = {}
): { added: Record<string, string>; warning: string | null; error: string | null } {
  if (hasAnthropicCredential(containerEnv)) {
    return { added: {}, warning: null, error: null };
  }
  const oauth = readHostClaudeOAuth(opts);
  if (!oauth) {
    return {
      added: {},
      warning:
        "no Anthropic credential available for the sandboxed agent (no ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN in env or document env, and no readable ~/.claude OAuth session); the agent will fail to authenticate.",
      error: null
    };
  }
  const now = opts.now ?? Date.now();
  // Only gate when the expiry is known. A token with unknown expiry can't be
  // proven stale, so we let the run proceed (previous behavior).
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now + OAUTH_EXPIRY_MARGIN_MS) {
    const state = oauth.expiresAt <= now ? "is expired" : "expires within two minutes";
    return {
      added: {},
      warning: null,
      error: `host ~/.claude OAuth access token ${state}; ${HOST_SESSION_EXPIRED_MESSAGE}`
    };
  }
  return { added: { CLAUDE_CODE_OAUTH_TOKEN: oauth.token }, warning: null, error: null };
}

// Model-aware wrapper: OpenRouter/LiteLLM jobs authenticate with the
// document's own provider key, so the host's Claude OAuth token must NOT be
// injected into those containers (it would be readable by untrusted agent code
// and is unnecessary). Anthropic jobs keep the resolveAgentCredentialEnv
// behavior.
const PROVIDER_KEY_VARS = {
  openrouter: { label: "OpenRouter", keyVar: "OPENROUTER_API_KEY" },
  litellm: { label: "LiteLLM", keyVar: "LITELLM_API_KEY" }
} as const;

export function resolveContainerCredentialEnv(
  containerEnv: Record<string, string | undefined>,
  agentModel: string | null | undefined,
  opts: { homeDir?: string | undefined; credentialsPath?: string; now?: number } = {}
): { added: Record<string, string>; warning: string | null; error: string | null } {
  const provider = agentModelProvider(agentModel);
  if (provider !== "anthropic") {
    if (provider === "local") {
      // The deployment's llama.cpp server is unauthenticated — nothing to
      // inject, and the host OAuth token must stay out of the container.
      const warning = containerEnv.LOCAL_MODEL_BASE_URL?.trim()
        ? null
        : "Local model selected but LOCAL_MODEL_BASE_URL is missing from the container env; the run will fail inside the sandbox.";
      return { added: {}, warning, error: null };
    }
    const { label, keyVar } = PROVIDER_KEY_VARS[provider];
    const warning = containerEnv[keyVar]?.trim()
      ? null
      : `${label} model selected but ${keyVar} is missing from the container env; the run will fail inside the sandbox.`;
    return { added: {}, warning, error: null };
  }
  return resolveAgentCredentialEnv(containerEnv, opts);
}
