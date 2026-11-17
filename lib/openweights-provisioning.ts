// OpenWeights API tokens with a lifetime spending limit, minted for a workspace
// by a PROVISIONER document (see lib/workspace-budget.ts).
//
// OpenWeights (>= 0.15) keeps a spending limit per API token: once the work
// submitted with that token has cost the limit, it stops admitting jobs and
// cancels running ones. So one token per workspace gives each workspace its
// own hard-ish cap inside a shared organization (a limit, not a reservation:
// it is checked against accrued spend).
//
// The minting key is an ORDINARY OpenWeights API key of the organization that
// pays; OpenWeights has no separate admin keys. The provisioner holds it either
// as OPENWEIGHTS_API_KEY (its own agent runs can then use OpenWeights too,
// without a limit) or as OPENWEIGHTS_ADMIN_KEY, which only changes who sees
// it: that name is a provisioner admin secret and never reaches an agent run,
// so a provisioner whose agents should not have an unlimited key uses it.
// OPENWEIGHTS_ADMIN_KEY wins when both are set. This module speaks
// to OpenWeights' Supabase REST API the way the `ow token` CLI does:
//   rpc/exchange_api_token_for_jwt   API key -> JWT
//   rpc/get_organization_from_token  -> organization id
//   rpc/create_api_token_with_limit  -> [{ token_id, token }]
//   rpc/set_spending_limit, rpc/revoke_api_token
//
// Config (provisioner env, else server env): OPENWEIGHTS_SUPABASE_URL and
// OPENWEIGHTS_SUPABASE_ANON_KEY, the public project URL and anon key that the
// openweights package ships as its defaults.

export class OpenWeightsProvisioningError extends Error {}

export const OPENWEIGHTS_ADMIN_KEY_ENV = "OPENWEIGHTS_ADMIN_KEY";
const REQUEST_TIMEOUT_MS = 20_000;

type FetchLike = typeof fetch;

export type OpenWeightsConfig = { adminKey: string; supabaseUrl: string; anonKey: string };

export function resolveOpenWeightsConfig(
  provisionerEnv: Record<string, string>,
  hostEnv: Record<string, string | undefined> = process.env
): OpenWeightsConfig | null {
  const adminKey = provisionerEnv[OPENWEIGHTS_ADMIN_KEY_ENV]?.trim() || provisionerEnv.OPENWEIGHTS_API_KEY?.trim();
  if (!adminKey) return null;
  const supabaseUrl = provisionerEnv.OPENWEIGHTS_SUPABASE_URL?.trim() || hostEnv.OPENWEIGHTS_SUPABASE_URL?.trim();
  const anonKey = provisionerEnv.OPENWEIGHTS_SUPABASE_ANON_KEY?.trim() || hostEnv.OPENWEIGHTS_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !anonKey) {
    throw new OpenWeightsProvisioningError(
      "An OpenWeights key is set, but OPENWEIGHTS_SUPABASE_URL / OPENWEIGHTS_SUPABASE_ANON_KEY are not (provisioner env or server env)."
    );
  }
  return { adminKey, supabaseUrl: supabaseUrl.replace(/\/+$/, ""), anonKey };
}

function scrub(text: string) {
  return text.replace(/(ow_|eyJ)[A-Za-z0-9._-]{6,}/g, "$1…").slice(0, 300);
}

async function rpc<T>(
  config: OpenWeightsConfig,
  bearer: string,
  name: string,
  body: unknown,
  fetchImpl: FetchLike
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: config.anonKey, authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new OpenWeightsProvisioningError(
      `OpenWeights ${name} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new OpenWeightsProvisioningError(`OpenWeights ${name} returned ${response.status}: ${scrub(text)}`);
  }
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OpenWeightsProvisioningError(`OpenWeights ${name} returned non-JSON.`);
  }
}

async function session(config: OpenWeightsConfig, fetchImpl: FetchLike) {
  const jwt = await rpc<string>(config, config.anonKey, "exchange_api_token_for_jwt", { api_token: config.adminKey }, fetchImpl);
  if (typeof jwt !== "string" || !jwt) {
    throw new OpenWeightsProvisioningError("OpenWeights did not accept the provisioner's API key.");
  }
  const orgId = await rpc<string>(config, jwt, "get_organization_from_token", {}, fetchImpl);
  if (typeof orgId !== "string" || !orgId) {
    throw new OpenWeightsProvisioningError("OpenWeights returned no organization for the provisioner's API key.");
  }
  return { jwt, orgId };
}

function limitString(usd: number) {
  if (!(Number.isFinite(usd) && usd >= 0)) {
    throw new OpenWeightsProvisioningError("The OpenWeights spending limit must be a non-negative number.");
  }
  return String(usd);
}

/** Mint a token with a lifetime limit. The token is returned ONCE; store it at once. */
export async function createOpenWeightsToken(
  config: OpenWeightsConfig,
  input: { name: string; spendingLimitUsd: number },
  fetchImpl: FetchLike = fetch
): Promise<{ tokenId: string; token: string }> {
  const limit = limitString(input.spendingLimitUsd);
  const { jwt, orgId } = await session(config, fetchImpl);
  const rows = await rpc<Array<{ token_id?: string; token?: string }>>(
    config,
    jwt,
    "create_api_token_with_limit",
    { org_id: orgId, token_name: input.name, expires_at: null, spending_limit_usd: limit },
    fetchImpl
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.token || !row.token_id) {
    throw new OpenWeightsProvisioningError("OpenWeights create_api_token_with_limit returned no token.");
  }
  return { tokenId: row.token_id, token: row.token };
}

export async function setOpenWeightsTokenLimit(
  config: OpenWeightsConfig,
  input: { tokenId: string; spendingLimitUsd: number },
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const limit = limitString(input.spendingLimitUsd);
  const { jwt, orgId } = await session(config, fetchImpl);
  await rpc(config, jwt, "set_spending_limit", { org_id: orgId, key_id: input.tokenId, amount_usd: limit }, fetchImpl);
}

export async function revokeOpenWeightsToken(
  config: OpenWeightsConfig,
  tokenId: string,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const { jwt } = await session(config, fetchImpl);
  await rpc(config, jwt, "revoke_api_token", { token_id: tokenId }, fetchImpl);
}
