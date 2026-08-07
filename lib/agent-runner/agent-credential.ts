import { agentHarnessForModel, agentModelProvider } from "../../agent-core/agent-config";

// Credentials entering this module have already been resolved from the
// document environment or a stored user credential. Host login files and host
// credential environment variables are intentionally never consulted.

export function hasAnthropicCredential(env: Record<string, string | undefined>): boolean {
  return Boolean(
    (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim()) ||
      (env.CLAUDE_CODE_OAUTH_TOKEN && env.CLAUDE_CODE_OAUTH_TOKEN.trim())
  );
}

export const CONNECT_ANTHROPIC_CREDENTIAL_MESSAGE =
  "Connect an Anthropic credential in settings to run this model.";
export const CONNECT_OPENAI_CREDENTIAL_MESSAGE =
  "Connect an OpenAI credential under AI settings to run this Codex model.";

export function resolveAgentCredentialEnv(
  containerEnv: Record<string, string | undefined>,
  _opts: { homeDir?: string | undefined; credentialsPath?: string; now?: number } = {}
): { added: Record<string, string>; warning: string | null; error: string | null } {
  if (hasAnthropicCredential(containerEnv)) {
    return { added: {}, warning: null, error: null };
  }
  return { added: {}, warning: null, error: CONNECT_ANTHROPIC_CREDENTIAL_MESSAGE };
}

const PROVIDER_KEY_VARS = {
  openai: { label: "OpenAI", keyVar: "OPENAI_API_KEY" },
  openrouter: { label: "OpenRouter", keyVar: "OPENROUTER_API_KEY" },
  litellm: { label: "LiteLLM", keyVar: "LITELLM_API_KEY" }
} as const;

export function resolveContainerCredentialEnv(
  containerEnv: Record<string, string | undefined>,
  agentModel: string | null | undefined,
  opts: { homeDir?: string | undefined; credentialsPath?: string; now?: number } = {}
): { added: Record<string, string>; warning: string | null; error: string | null } {
  const provider = agentModelProvider(agentModel);
  if (agentHarnessForModel(agentModel) === "codex" && provider === "openai") {
    return containerEnv.OPENAI_API_KEY?.trim()
      ? { added: {}, warning: null, error: null }
      : { added: {}, warning: null, error: CONNECT_OPENAI_CREDENTIAL_MESSAGE };
  }
  if (provider !== "anthropic") {
    if (provider === "local") {
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
