// Per-run credential selection, chosen by whoever kicks off the run.
//
// By default a run inherits everything its document and user have configured:
// document env vars, the user's provider keys, GitHub PAT, Hugging Face token
// and MCP servers. That is right for your own work, and wrong for a task whose
// instructions were written by a third party (a prompt-injected agent can use
// whatever is in its sandbox). A policy turns that into an explicit choice:
//
//   allowEnv         names of normally-resolved env vars this run keeps
//   env              extra variables for this run only (never persisted)
//   allowMcpServers  names of document/workspace/user MCP servers it keeps
//
// Nothing else reaches the run. The policy is not stored: a follow-up run
// (previousRunId) must send it again, like per-run MCP servers.

import { z } from "zod";

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Invalid environment variable name.");

export const runCredentialPolicySchema = z.object({
  allowEnv: z.array(envName).max(100).default([]),
  env: z.record(envName, z.string().max(20_000)).default({}),
  allowMcpServers: z.array(z.string().min(1).max(64)).max(20).default([])
});

export type RunCredentialPolicy = z.infer<typeof runCredentialPolicySchema>;

// Endpoint/model routing settings, not secrets. Dropping them would silently
// point a kept key at the wrong host.
function isRoutingSetting(name: string) {
  return name.endsWith("_BASE_URL") || name === "LOCAL_MODEL_NAME";
}

export function applyRunCredentialPolicy(
  env: Record<string, string>,
  policy: RunCredentialPolicy
): { env: Record<string, string>; kept: string[]; dropped: string[] } {
  const allow = new Set(policy.allowEnv);
  const next: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (allow.has(name) || isRoutingSetting(name)) next[name] = value;
    else dropped.push(name);
  }
  // Per-run values win: they are the most specific thing the caller said.
  for (const [name, value] of Object.entries(policy.env)) next[name] = value;
  return { env: next, kept: Object.keys(next).sort(), dropped: dropped.sort() };
}

export function policyAllowsGithub(policy: RunCredentialPolicy | null | undefined) {
  if (!policy) return true;
  return ["GITHUB_TOKEN", "GH_TOKEN"].some((name) => policy.allowEnv.includes(name) || name in policy.env);
}

/** Timeline line: names only, never values. */
export function describeRunCredentialPolicy(envNames: string[], inheritedMcpServers: string[]) {
  const list = (names: string[]) => (names.length ? names.join(", ") : "none");
  return (
    `Restricted credentials for this run: only these environment variables reach the agent: ${list(envNames)}. ` +
    `Inherited MCP servers: ${list(inheritedMcpServers)}. Everything else configured on the document or account is withheld.`
  );
}

// --- Channel ceiling --------------------------------------------------------
//
// A per-run policy is chosen by the caller, so it protects the user only when
// the caller is trusted. For a channel handed to an external service the user
// instead fixes a CEILING when they set the channel up (the /agent-setup
// consent page): the names below are the most any run of that channel can get.
// It is stored on AgentApiChannel.credentialPolicy and applied to every run,
// whether or not the caller sends `credentials`.

export const channelCredentialCeilingSchema = z.object({
  allowEnv: z.array(envName).max(100).default([]),
  allowMcpServers: z.array(z.string().min(1).max(64)).max(20).default([])
});

export type ChannelCredentialCeiling = z.infer<typeof channelCredentialCeilingSchema>;

export function parseChannelCredentialCeiling(stored: string | null | undefined): ChannelCredentialCeiling | null {
  if (!stored) return null;
  try {
    const parsed = channelCredentialCeilingSchema.safeParse(JSON.parse(stored));
    // A ceiling we cannot read must not turn into "unrestricted".
    return parsed.success ? parsed.data : { allowEnv: [], allowMcpServers: [] };
  } catch {
    return { allowEnv: [], allowMcpServers: [] };
  }
}

/**
 * The policy a channel run actually gets. Without a ceiling this is the
 * caller's policy unchanged (possibly none). With one, the run is always
 * restricted: a caller list narrows the ceiling (an empty or missing list
 * means "everything the ceiling allows"), and per-run `env` values pass
 * through, since those are the caller's own values, not the user's secrets.
 */
export function effectiveChannelRunPolicy(
  ceiling: ChannelCredentialCeiling | null,
  requested: RunCredentialPolicy | null | undefined
): RunCredentialPolicy | null {
  if (!ceiling) return requested ?? null;
  const narrow = (allowed: string[], asked: string[] | undefined) =>
    asked && asked.length ? allowed.filter((name) => asked.includes(name)) : [...allowed];
  return {
    allowEnv: narrow(ceiling.allowEnv, requested?.allowEnv),
    env: { ...(requested?.env ?? {}) },
    allowMcpServers: narrow(ceiling.allowMcpServers, requested?.allowMcpServers)
  };
}

/**
 * What the consent page offers: one entry per credential the user connected,
 * with the env var names it becomes inside a run. `model` marks credentials
 * that can authenticate the agent's own model (pre-ticked); the rest are tool
 * credentials the user opts into.
 */
export type RunCredentialChoice = { id: string; label: string; envNames: string[]; model: boolean };

export function runCredentialChoices(
  connected: Array<{ provider: string; kind: string }>
): RunCredentialChoice[] {
  const choices: RunCredentialChoice[] = [];
  for (const { provider, kind } of connected) {
    if (provider === "anthropic") {
      choices.push(kind === "oauth"
        ? { id: provider, label: "Claude subscription token", envNames: ["CLAUDE_CODE_OAUTH_TOKEN"], model: true }
        : { id: provider, label: "Anthropic API key", envNames: ["ANTHROPIC_API_KEY"], model: true });
    } else if (provider === "openai") {
      choices.push({ id: provider, label: "OpenAI API key", envNames: ["OPENAI_API_KEY"], model: true });
    } else if (provider === "openai-chatgpt") {
      choices.push({ id: provider, label: "ChatGPT (Codex) sign-in", envNames: ["CODEX_CHATGPT_AUTH_JSON"], model: true });
    } else if (provider === "openrouter") {
      choices.push({ id: provider, label: "OpenRouter API key", envNames: ["OPENROUTER_API_KEY"], model: true });
    } else if (provider === "litellm") {
      choices.push({ id: provider, label: "LiteLLM key", envNames: ["LITELLM_API_KEY"], model: true });
    } else if (provider === "huggingface") {
      choices.push({ id: provider, label: "Hugging Face token", envNames: ["HF_TOKEN"], model: false });
    } else if (provider === "github") {
      choices.push({ id: provider, label: "GitHub token", envNames: ["GITHUB_TOKEN", "GH_TOKEN"], model: false });
    }
  }
  return choices;
}
