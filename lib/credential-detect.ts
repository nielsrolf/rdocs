// Pure credential-format detection, shared by the server (normalizeCredentialInput)
// and the client credentials menu (single input field, no provider dropdown).
// No imports — this must stay safe to bundle client-side.

export type CredentialProvider = "anthropic" | "openrouter" | "litellm" | "github";

export type CredentialKind = "api_key" | "oauth";

export type DetectedCredential = {
  provider: CredentialProvider;
  kind: CredentialKind;
  /** Human label for "Detected: …" UI. */
  label: string;
};

// Order matters: sk-ant-oat is a strict extension of sk-ant-.
const PREFIX_RULES: Array<{ prefixes: string[]; detected: DetectedCredential }> = [
  {
    prefixes: ["sk-ant-oat"],
    detected: { provider: "anthropic", kind: "oauth", label: "Claude subscription token" }
  },
  {
    prefixes: ["sk-ant-"],
    detected: { provider: "anthropic", kind: "api_key", label: "Anthropic API key" }
  },
  {
    prefixes: ["sk-or-"],
    detected: { provider: "openrouter", kind: "api_key", label: "OpenRouter API key" }
  },
  {
    // Classic + fine-grained PATs and app/OAuth tokens.
    prefixes: ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_"],
    detected: { provider: "github", kind: "api_key", label: "GitHub access token" }
  }
];

/**
 * Detect what kind of credential a pasted value is from its prefix. Returns
 * null when the format is not recognizable (e.g. LiteLLM proxy keys, which are
 * arbitrary strings) — the caller must then ask the user.
 */
export function detectCredential(value: string): DetectedCredential | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  for (const rule of PREFIX_RULES) {
    if (rule.prefixes.some((prefix) => trimmed.startsWith(prefix))) {
      return rule.detected;
    }
  }
  return null;
}

/** Our own MCP bearer tokens — pasting one here is always a mix-up. */
export function looksLikeMcpToken(value: string): boolean {
  return value.trim().startsWith("gdai_");
}
