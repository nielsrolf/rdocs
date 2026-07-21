// Builds the environment handed to the Claude Agent SDK (and therefore to every
// Bash/tool subprocess the agent spawns). The agent must NOT inherit the host
// environment wholesale — arbitrary host secrets (FOO=bar, unrelated API keys)
// would otherwise be readable from inside an untrusted document's agent run.
//
// Instead we start from an allow-list of host variables the agent genuinely
// needs to function (toolchain + Claude/GitHub auth) and layer the document's
// own configured secrets on top. Everything else from the host is dropped.

// Exact host variable names copied through when present.
const ALLOWLIST_EXACT = new Set([
  // Toolchain / OS basics needed to locate and run binaries.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "PWD",
  // XDG base dirs — Claude Code / git may resolve config & cache through these.
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  // TLS trust stores (so fetches/clones don't fail on custom CAs).
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  // App-specific bits the agent relies on.
  "PYTHON_BIN",
  // GITHUB_TOKEN / GH_TOKEN are deliberately NOT allowlisted: the host token is
  // the shared bot account, and copying it into every (untrusted) agent run
  // would let any user act on every repo the bot can see. GitHub auth arrives
  // via the per-document resolution (doc env → user PAT → allowlisted host)
  // injected into the document env by loadAgentEnvForDocument.
  // Host-provided default endpoint for the LiteLLM provider. Only the URL —
  // LITELLM_API_KEY is deliberately NOT allowlisted (like OPENROUTER_API_KEY,
  // it must come from the document env so a host key is never silently billed
  // for every document's runs).
  "LITELLM_BASE_URL",
  // The deployment's free local model (llama.cpp, Anthropic-compatible). URL +
  // name are configuration, not credentials — safe to pass through.
  "LOCAL_MODEL_BASE_URL",
  "LOCAL_MODEL_NAME"
]);

// Host variables whose names start with one of these prefixes are copied
// through (covers ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_AGENT_*
// auth + config the SDK and CLI read).
const ALLOWLIST_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "AWS_BEDROCK_", "GOOGLE_VERTEX_"];

// Names that match a prefix above but must NOT propagate: these are the IPC /
// session control vars a PARENT Claude Code process sets for itself. Inheriting
// them makes the agent's own bundled `claude` CLI try to attach to a
// non-existent parent session (SSE port, session id) and exit 1. The auth token
// (CLAUDE_CODE_OAUTH_TOKEN) and our own CLAUDE_AGENT_* config are deliberately
// not in this list.
const DENYLIST_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_TMPDIR"
]);

function isAllowlisted(name: string): boolean {
  if (DENYLIST_EXACT.has(name)) return false;
  if (ALLOWLIST_EXACT.has(name)) return true;
  return ALLOWLIST_PREFIXES.some((prefix) => name.startsWith(prefix));
}

import type { AgentModelProvider } from "./agent-config";

export type DocumentEnv = Record<string, string>;

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/**
 * Rewrite an already-built agent env for the selected provider. No-op for
 * "anthropic". For "openrouter" and "litellm" the Claude Agent SDK is pointed
 * at the provider's Anthropic-compatible endpoint:
 *   - requires the provider key (OPENROUTER_API_KEY / LITELLM_API_KEY, from
 *     the document env) — throws a clear error when missing rather than
 *     silently running on the host's Anthropic credential and billing the
 *     wrong account; litellm additionally requires LITELLM_BASE_URL (document
 *     env, or the host default passed through the allowlist);
 *   - sets ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (sent as a Bearer token);
 *   - clears ANTHROPIC_API_KEY and removes CLAUDE_CODE_OAUTH_TOKEN so no
 *     host Anthropic credential can win the SDK's auth precedence.
 * Runs after buildAgentEnv in both runner modes (agent-core executes inside
 * the container too), so this is the single translation point.
 */
export function applyProviderEnv(
  env: Record<string, string>,
  provider: AgentModelProvider
): Record<string, string> {
  if (provider !== "openrouter" && provider !== "litellm" && provider !== "local") return env;

  let baseUrl: string;
  let key: string | undefined;
  if (provider === "local") {
    // The deployment's own llama.cpp server: Anthropic-compatible and unauthenticated,
    // so the only requirement is the base URL (host env, passed through the allowlist;
    // a document env override wins like every other doc var).
    const rawBase = env.LOCAL_MODEL_BASE_URL?.trim();
    if (!rawBase) {
      throw new Error(
        "Local model selected but LOCAL_MODEL_BASE_URL is not configured on this server."
      );
    }
    baseUrl = rawBase.replace(/\/+$/, "");
    // The SDK requires a non-empty token; llama.cpp ignores it.
    key = "local-no-key";
  } else if (provider === "openrouter") {
    baseUrl = OPENROUTER_BASE_URL;
    key = env.OPENROUTER_API_KEY?.trim();
    if (!key) {
      throw new Error(
        "OpenRouter model selected but OPENROUTER_API_KEY is not set. Add it via the Env menu, or connect an OpenRouter key in the AI credentials menu."
      );
    }
  } else {
    key = env.LITELLM_API_KEY?.trim();
    if (!key) {
      throw new Error(
        "LiteLLM model selected but LITELLM_API_KEY is not set. Add it via the Env menu, or connect a LiteLLM key in the AI credentials menu."
      );
    }
    const rawBase = env.LITELLM_BASE_URL?.trim();
    if (!rawBase) {
      throw new Error(
        "LiteLLM model selected but LITELLM_BASE_URL is not set. Add it via the Env menu (e.g. https://litellm.example.com) or configure a host default."
      );
    }
    baseUrl = rawBase.replace(/\/+$/, "");
  }

  const result = { ...env };
  result.ANTHROPIC_BASE_URL = baseUrl;
  result.ANTHROPIC_AUTH_TOKEN = key;
  // Empty string is treated as unset by the CLI (verified); keeping the key
  // present-but-empty guarantees a host ANTHROPIC_API_KEY cannot leak through.
  result.ANTHROPIC_API_KEY = "";
  delete result.CLAUDE_CODE_OAUTH_TOKEN;
  return result;
}

/**
 * Produce the agent's environment: allow-listed host vars + the document's own
 * variables (which override on key collision). Non-allow-listed host vars are
 * dropped, so e.g. a host `FOO=bar` never reaches the agent.
 */
export function buildAgentEnv(
  hostEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  documentEnv: DocumentEnv = {}
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (isAllowlisted(key)) {
      result[key] = value;
    }
  }
  // Document-configured variables take precedence over host defaults.
  for (const [key, value] of Object.entries(documentEnv)) {
    result[key] = value;
  }
  return result;
}

// Host-provided configuration (not credentials) worth disclosing to the agent
// alongside the document env keys, because it changes which services are
// reachable (e.g. a LiteLLM proxy endpoint).
const PROMPT_ENV_HOST_KEYS = ["LITELLM_BASE_URL", "LOCAL_MODEL_BASE_URL", "LOCAL_MODEL_NAME"];

/**
 * Env var NAMES (never values) to disclose in the agent's system prompt so it
 * knows which API keys/services are available in its run environment — e.g.
 * whether to call OpenAI directly (OPENAI_API_KEY) or go through a LiteLLM
 * proxy (LITELLM_API_KEY + LITELLM_BASE_URL). Discloses only the
 * document-configured env (incl. per-run injected credentials like
 * GITHUB_TOKEN) plus a few host config keys — never the host allowlist noise
 * or harness-internal vars. Keys that ended up empty in the final env (e.g.
 * ANTHROPIC_API_KEY cleared by applyProviderEnv) are dropped.
 */
export function agentEnvKeysForPrompt(
  documentEnv: DocumentEnv,
  finalEnv: Record<string, string>
): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(documentEnv)) keys.add(key);
  for (const key of PROMPT_ENV_HOST_KEYS) keys.add(key);
  return [...keys].filter((key) => Boolean(finalEnv[key]?.trim())).sort();
}

/**
 * Mask a secret for display: keep a few leading/trailing characters and replace
 * the middle with a fixed run of asterisks. Short secrets are fully masked so we
 * never reveal a meaningful fraction of them.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(Math.max(3, value.length));
  }
  const head = value.slice(0, 3);
  const tail = value.slice(-3);
  return `${head}*****${tail}`;
}

// Loosely validate an env var name (POSIX-ish): letters, digits, underscores,
// not starting with a digit. Keeps the agent env predictable and shell-safe.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key);
}
