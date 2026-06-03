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
  "GITHUB_TOKEN",
  "GH_TOKEN"
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

export type DocumentEnv = Record<string, string>;

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
