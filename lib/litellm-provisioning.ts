// Budgeted LiteLLM virtual keys minted by a PROVISIONER document.
//
// A provisioner is any document whose env holds LITELLM_ADMIN_KEY (a LiteLLM
// key allowed to call /key/generate — ideally a team-admin key, not the proxy
// master key). That secret is withheld from every agent run (loadDocumentEnv
// drops it); only this module reads it, server-side, via loadProvisionerEnv.
// So "who may mint keys" == "who has edit access to the provisioner document",
// and an agent can mint, budget and revoke keys without ever seeing the admin
// key or the minted key: the new key goes straight into the target document's
// env, and a ProvisionedCredential row records it.
//
// Optional provisioner env (plain config, visible to runs):
//   LITELLM_ADMIN_BASE_URL            proxy URL as seen from THIS server
//                                     (default: server LITELLM_BASE_URL with
//                                     host.docker.internal → 127.0.0.1)
//   LITELLM_PROVISION_MAX_BUDGET_USD  hard cap on any key's max_budget
//   LITELLM_PROVISION_TEAM_ID         team every minted key is attached to

import crypto from "node:crypto";

import { db } from "@/lib/db";
import { deleteDocumentEnv, loadProvisionerEnv, upsertDocumentEnv } from "@/lib/document-env";

export class LiteLlmProvisioningError extends Error {}

export const LITELLM_ADMIN_KEY_ENV = "LITELLM_ADMIN_KEY";
const PROVIDER = "litellm";
const REQUEST_TIMEOUT_MS = 15_000;
const BUDGET_DURATION_RE = /^\d{1,4}(s|m|h|d|mo)$/;

type FetchLike = typeof fetch;

type ProvisionerConfig = {
  adminKey: string;
  baseUrl: string;
  maxBudgetCapUsd: number | null;
  teamId: string | null;
};

export function resolveLiteLlmAdminBaseUrl(provisionerEnv: Record<string, string>): string | null {
  const explicit = provisionerEnv.LITELLM_ADMIN_BASE_URL?.trim() || process.env.LITELLM_ADMIN_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const fallback = process.env.LITELLM_BASE_URL?.trim();
  if (!fallback) return null;
  // The server-wide LITELLM_BASE_URL is written for agent CONTAINERS; a host
  // process cannot resolve host.docker.internal on native Linux.
  return fallback.replace("://host.docker.internal", "://127.0.0.1").replace(/\/$/, "");
}

async function loadProvisionerConfig(provisionerDocumentId: string): Promise<ProvisionerConfig> {
  const env = await loadProvisionerEnv(provisionerDocumentId);
  const adminKey = env[LITELLM_ADMIN_KEY_ENV]?.trim();
  if (!adminKey) {
    throw new LiteLlmProvisioningError(
      `This document is not a LiteLLM provisioner: its owner has to set ${LITELLM_ADMIN_KEY_ENV} in its environment.`
    );
  }
  const baseUrl = resolveLiteLlmAdminBaseUrl(env);
  if (!baseUrl) {
    throw new LiteLlmProvisioningError("No LiteLLM URL: set LITELLM_ADMIN_BASE_URL on the provisioner document.");
  }
  const capRaw = env.LITELLM_PROVISION_MAX_BUDGET_USD?.trim();
  const cap = capRaw ? Number(capRaw) : null;
  if (cap !== null && !(Number.isFinite(cap) && cap >= 0)) {
    throw new LiteLlmProvisioningError("LITELLM_PROVISION_MAX_BUDGET_USD on the provisioner is not a number.");
  }
  return { adminKey, baseUrl, maxBudgetCapUsd: cap, teamId: env.LITELLM_PROVISION_TEAM_ID?.trim() || null };
}

function scrubSecrets(text: string) {
  return text.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-…").slice(0, 400);
}

async function liteLlmAdminRequest<T>(
  config: ProvisionerConfig,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  fetchImpl: FetchLike
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.adminKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new LiteLlmProvisioningError(
      `LiteLLM ${method} ${path.split("?")[0]} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new LiteLlmProvisioningError(
      `LiteLLM ${method} ${path.split("?")[0]} returned ${response.status}: ${scrubSecrets(text)}`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LiteLlmProvisioningError(`LiteLLM ${method} ${path.split("?")[0]} returned non-JSON.`);
  }
}

function checkBudget(config: ProvisionerConfig, maxBudgetUsd: number) {
  if (!(Number.isFinite(maxBudgetUsd) && maxBudgetUsd >= 0)) {
    throw new LiteLlmProvisioningError("max_budget_usd must be a non-negative number.");
  }
  if (config.maxBudgetCapUsd !== null && maxBudgetUsd > config.maxBudgetCapUsd) {
    throw new LiteLlmProvisioningError(
      `max_budget_usd ${maxBudgetUsd} exceeds this provisioner's cap of ${config.maxBudgetCapUsd} (LITELLM_PROVISION_MAX_BUDGET_USD).`
    );
  }
}

function checkBudgetDuration(budgetDuration: string | null | undefined) {
  if (budgetDuration && !BUDGET_DURATION_RE.test(budgetDuration)) {
    throw new LiteLlmProvisioningError(`budget_duration "${budgetDuration}" must look like 30d, 7d, 24h or 1mo.`);
  }
}

async function activeRecord(targetDocumentId: string, envKey: string) {
  return db.provisionedCredential.findFirst({
    where: { provider: PROVIDER, targetDocumentId, envKey, revokedAt: null },
    orderBy: { createdAt: "desc" }
  });
}

async function plaintextKey(targetDocumentId: string, envKey: string) {
  const env = await loadProvisionerEnv(targetDocumentId);
  return env[envKey]?.trim() || null;
}

export type ProvisionLiteLlmKeyInput = {
  provisionerDocumentId: string;
  targetDocumentId: string;
  userId: string;
  maxBudgetUsd: number;
  budgetDuration?: string | null;
  models?: string[] | null;
  envKey?: string;
  replace?: boolean;
};

export async function provisionLiteLlmKey(input: ProvisionLiteLlmKeyInput, fetchImpl: FetchLike = fetch) {
  const envKey = input.envKey ?? "LITELLM_API_KEY";
  const config = await loadProvisionerConfig(input.provisionerDocumentId);
  checkBudget(config, input.maxBudgetUsd);
  checkBudgetDuration(input.budgetDuration);

  const previous = await activeRecord(input.targetDocumentId, envKey);
  const existingValue = await plaintextKey(input.targetDocumentId, envKey);
  if ((previous || existingValue) && !input.replace) {
    throw new LiteLlmProvisioningError(
      `${envKey} is already set on that document${previous ? " (a key provisioned earlier)" : ""}. ` +
        "Pass replace=true to mint a new key; a previously provisioned key is then deleted at LiteLLM."
    );
  }

  const keyAlias = `rdocs-${input.targetDocumentId}-${envKey.toLowerCase()}-${crypto.randomBytes(3).toString("hex")}`;
  const generated = await liteLlmAdminRequest<{ key?: string }>(
    config,
    "POST",
    "/key/generate",
    {
      key_alias: keyAlias,
      max_budget: input.maxBudgetUsd,
      ...(input.budgetDuration ? { budget_duration: input.budgetDuration } : {}),
      ...(input.models?.length ? { models: input.models } : {}),
      ...(config.teamId ? { team_id: config.teamId } : {}),
      metadata: {
        rdocs_provisioner_document_id: input.provisionerDocumentId,
        rdocs_target_document_id: input.targetDocumentId,
        rdocs_user_id: input.userId
      }
    },
    fetchImpl
  );
  if (!generated.key) throw new LiteLlmProvisioningError("LiteLLM /key/generate returned no key.");

  await upsertDocumentEnv(input.targetDocumentId, envKey, generated.key, true);
  const record = await db.provisionedCredential.create({
    data: {
      provider: PROVIDER,
      provisionerDocumentId: input.provisionerDocumentId,
      targetDocumentId: input.targetDocumentId,
      envKey,
      keyAlias,
      maxBudgetUsd: input.maxBudgetUsd,
      budgetDuration: input.budgetDuration ?? null,
      models: input.models?.length ? JSON.stringify(input.models) : null,
      createdById: input.userId
    }
  });

  // The replaced key stops working only after the new one is in place.
  if (previous && existingValue) {
    await liteLlmAdminRequest(config, "POST", "/key/delete", { keys: [existingValue] }, fetchImpl).catch((error) => {
      console.warn("[litellm-provisioning] could not delete replaced key", {
        keyAlias: previous.keyAlias,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  if (previous) {
    await db.provisionedCredential.update({ where: { id: previous.id }, data: { revokedAt: new Date() } });
  }

  console.log(
    "[litellm-provisioning] minted key",
    JSON.stringify({
      recordId: record.id,
      keyAlias,
      provisionerDocumentId: input.provisionerDocumentId,
      targetDocumentId: input.targetDocumentId,
      maxBudgetUsd: input.maxBudgetUsd,
      budgetDuration: input.budgetDuration ?? null,
      userId: input.userId
    })
  );
  return {
    id: record.id,
    envKey,
    keyAlias,
    maxBudgetUsd: input.maxBudgetUsd,
    budgetDuration: input.budgetDuration ?? null,
    models: input.models ?? null,
    teamId: config.teamId
  };
}

async function requireRecordForProvisioner(provisionerDocumentId: string, targetDocumentId: string, envKey: string) {
  const record = await activeRecord(targetDocumentId, envKey);
  if (!record || record.provisionerDocumentId !== provisionerDocumentId) {
    throw new LiteLlmProvisioningError(
      `No active key provisioned by this provisioner is stored as ${envKey} on that document.`
    );
  }
  return record;
}

export type UpdateLiteLlmKeyInput = {
  provisionerDocumentId: string;
  targetDocumentId: string;
  envKey?: string;
  maxBudgetUsd?: number;
  budgetDuration?: string | null;
  models?: string[] | null;
  blocked?: boolean;
};

export async function updateLiteLlmKey(input: UpdateLiteLlmKeyInput, fetchImpl: FetchLike = fetch) {
  const envKey = input.envKey ?? "LITELLM_API_KEY";
  const config = await loadProvisionerConfig(input.provisionerDocumentId);
  const record = await requireRecordForProvisioner(input.provisionerDocumentId, input.targetDocumentId, envKey);
  const key = await plaintextKey(input.targetDocumentId, envKey);
  if (!key) throw new LiteLlmProvisioningError(`${envKey} was removed from that document; revoke and re-provision.`);
  if (input.maxBudgetUsd !== undefined) checkBudget(config, input.maxBudgetUsd);
  checkBudgetDuration(input.budgetDuration);

  const update: Record<string, unknown> = {};
  if (input.maxBudgetUsd !== undefined) update.max_budget = input.maxBudgetUsd;
  if (input.budgetDuration !== undefined) update.budget_duration = input.budgetDuration;
  if (input.models !== undefined) update.models = input.models ?? [];
  if (Object.keys(update).length > 0) {
    await liteLlmAdminRequest(config, "POST", "/key/update", { key, ...update }, fetchImpl);
  }
  if (input.blocked !== undefined) {
    await liteLlmAdminRequest(config, "POST", input.blocked ? "/key/block" : "/key/unblock", { key }, fetchImpl);
  }
  await db.provisionedCredential.update({
    where: { id: record.id },
    data: {
      ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
      ...(input.budgetDuration !== undefined ? { budgetDuration: input.budgetDuration } : {}),
      ...(input.models !== undefined ? { models: input.models?.length ? JSON.stringify(input.models) : null } : {})
    }
  });
  console.log("[litellm-provisioning] updated key", JSON.stringify({ recordId: record.id, ...update, blocked: input.blocked }));
  return { id: record.id, keyAlias: record.keyAlias, updated: { ...update, ...(input.blocked !== undefined ? { blocked: input.blocked } : {}) } };
}

export async function revokeLiteLlmKey(
  input: { provisionerDocumentId: string; targetDocumentId: string; envKey?: string },
  fetchImpl: FetchLike = fetch
) {
  const envKey = input.envKey ?? "LITELLM_API_KEY";
  const config = await loadProvisionerConfig(input.provisionerDocumentId);
  const record = await requireRecordForProvisioner(input.provisionerDocumentId, input.targetDocumentId, envKey);
  const key = await plaintextKey(input.targetDocumentId, envKey);
  await liteLlmAdminRequest(
    config,
    "POST",
    "/key/delete",
    key ? { keys: [key] } : { key_aliases: [record.keyAlias] },
    fetchImpl
  );
  await deleteDocumentEnv(input.targetDocumentId, envKey);
  await db.provisionedCredential.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  console.log("[litellm-provisioning] revoked key", JSON.stringify({ recordId: record.id, keyAlias: record.keyAlias }));
  return { id: record.id, keyAlias: record.keyAlias, revoked: true };
}

type KeyInfoResponse = {
  info?: {
    spend?: number;
    max_budget?: number | null;
    budget_duration?: string | null;
    budget_reset_at?: string | null;
    models?: string[];
    blocked?: boolean | null;
  };
};

export async function listLiteLlmKeys(
  input: { provisionerDocumentId: string; targetDocumentId?: string; includeRevoked?: boolean },
  fetchImpl: FetchLike = fetch
) {
  const config = await loadProvisionerConfig(input.provisionerDocumentId);
  const records = await db.provisionedCredential.findMany({
    where: {
      provider: PROVIDER,
      provisionerDocumentId: input.provisionerDocumentId,
      ...(input.targetDocumentId ? { targetDocumentId: input.targetDocumentId } : {}),
      ...(input.includeRevoked ? {} : { revokedAt: null })
    },
    orderBy: { createdAt: "asc" },
    take: 100
  });
  const titles = new Map(
    (
      await db.document.findMany({
        where: { id: { in: [...new Set(records.map((record) => record.targetDocumentId))] } },
        select: { id: true, title: true }
      })
    ).map((doc) => [doc.id, doc.title])
  );
  return Promise.all(
    records.map(async (record) => {
      const base = {
        id: record.id,
        document: record.targetDocumentId,
        document_title: titles.get(record.targetDocumentId) ?? null,
        env_key: record.envKey,
        key_alias: record.keyAlias,
        created_at: record.createdAt.toISOString(),
        revoked_at: record.revokedAt?.toISOString() ?? null
      };
      if (record.revokedAt) return base;
      const key = await plaintextKey(record.targetDocumentId, record.envKey);
      if (!key) return { ...base, status_error: `${record.envKey} was removed from the document.` };
      try {
        const info = await liteLlmAdminRequest<KeyInfoResponse>(
          config,
          "GET",
          `/key/info?key=${encodeURIComponent(key)}`,
          undefined,
          fetchImpl
        );
        return {
          ...base,
          spend_usd: info.info?.spend ?? null,
          max_budget_usd: info.info?.max_budget ?? null,
          budget_duration: info.info?.budget_duration ?? null,
          budget_reset_at: info.info?.budget_reset_at ?? null,
          models: info.info?.models ?? [],
          blocked: Boolean(info.info?.blocked)
        };
      } catch (error) {
        return { ...base, status_error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
}
