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
