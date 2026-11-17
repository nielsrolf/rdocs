// Workspace budgets: "this workspace may spend $1000 on compute, in total".
//
// One call turns a workspace into a budgeted one. Given a PROVISIONER document
// (one whose env holds the organization's admin credentials) it
//   1. registers a project with that budget in the cost dashboard
//      (lib/costs-client.ts) — the ledger that adds up every provider's bill;
//   2. gives the workspace its own credentials, so that what it spends lands
//      in that project:
//        litellm      a virtual key with max_budget = the budget, tagged with
//                     the project (LITELLM_ADMIN_KEY on the provisioner)
//        openweights  an API token with a lifetime spending limit = the budget
//                     (the provisioner's OPENWEIGHTS_API_KEY, or
//                     OPENWEIGHTS_ADMIN_KEY to keep it from its own runs)
//        tinker       the provisioner's TINKER_API_KEY, handed on by name
//        modal        the provisioner's MODAL_TOKEN_ID / MODAL_TOKEN_SECRET
//   3. sets COSTS_PROJECT in the workspace env, the name agents tag shared-key
//      spend with (Tinker session metadata `project`, Modal tag `project`,
//      RunPod pod name prefix) — see the compute-costs skill.
//
// What is and is not enforced. LiteLLM and OpenWeights enforce the limit of
// the minted key themselves, each up to the FULL budget (a limit per provider,
// not a reservation). Tinker and Modal keys are the provisioner's own and have
// no limit of their own: their spend is only visible in the dashboard, after
// the fact and only when the agent tags it. The combined total is not enforced
// here yet; `getWorkspaceBudget` reports it.
//
// Only providers the provisioner has credentials for are set up; the result
// says which. Authorization (edit on provisioner and workspace) is the
// caller's job, as in lib/workspace-provisioning.ts.

import {
  costsProjectName,
  COSTS_ADMIN_TOKEN_ENV,
  CostsError,
  deleteCostsProject,
  ensureCostsProject,
  getCostsSpend,
  resolveCostsConfig,
  updateCostsProject,
  type CostsConfig,
  type CostsSpend
} from "@/lib/costs-client";
import { db } from "@/lib/db";
import { enforceWorkspaceBudgets } from "@/lib/workspace-budget-enforcement";
import { forgetRunBudgetStates } from "@/lib/workspace-budget-state";
import { copyDocumentEnvKeys, deleteDocumentEnv, loadProvisionerEnv, upsertDocumentEnv } from "@/lib/document-env";
import {
  LITELLM_ADMIN_KEY_ENV,
  LiteLlmProvisioningError,
  provisionLiteLlmKey,
  revokeLiteLlmKey,
  updateLiteLlmKey
} from "@/lib/litellm-provisioning";
import {
  createOpenWeightsToken,
  OpenWeightsProvisioningError,
  resolveOpenWeightsConfig,
  revokeOpenWeightsToken,
  setOpenWeightsTokenLimit
} from "@/lib/openweights-provisioning";

export class WorkspaceBudgetError extends Error {}

export const COSTS_PROJECT_ENV = "COSTS_PROJECT";
const OPENWEIGHTS_KEY_ENV = "OPENWEIGHTS_API_KEY";
const OPENWEIGHTS_PROVIDER = "openweights";
const MAX_BUDGET_USD = 1_000_000;
// Keys of the provisioner that a budgeted workspace shares (no limit of their own).
const SHARED_KEYS: Record<string, string[]> = {
  tinker: ["TINKER_API_KEY"],
  modal: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
};

type FetchLike = typeof fetch;
export type BudgetProviders = Record<string, "minted" | "shared">;

function isBudgetError(error: unknown): error is Error {
  return (
    error instanceof WorkspaceBudgetError ||
    error instanceof CostsError ||
    error instanceof LiteLlmProvisioningError ||
    error instanceof OpenWeightsProvisioningError
  );
}

/** Errors a tool should show to the caller as its message. */
export function isWorkspaceBudgetError(error: unknown): error is Error {
  return isBudgetError(error);
}

function checkBudget(budgetUsd: number, provisionerEnv: Record<string, string>) {
  if (!(Number.isFinite(budgetUsd) && budgetUsd > 0 && budgetUsd <= MAX_BUDGET_USD)) {
    throw new WorkspaceBudgetError("budget_usd must be a positive number.");
  }
  const capRaw = provisionerEnv.WORKSPACE_MAX_BUDGET_USD?.trim();
  if (!capRaw) return;
  const cap = Number(capRaw);
  if (!(Number.isFinite(cap) && cap >= 0)) {
    throw new WorkspaceBudgetError("WORKSPACE_MAX_BUDGET_USD on the provisioner is not a number.");
  }
  if (budgetUsd > cap) {
    throw new WorkspaceBudgetError(
      `budget_usd ${budgetUsd} exceeds this provisioner's cap of ${cap} per workspace (WORKSPACE_MAX_BUDGET_USD).`
    );
  }
}

function requireCosts(provisionerEnv: Record<string, string>): CostsConfig {
  const costs = resolveCostsConfig(provisionerEnv);
  if (!costs) {
    throw new WorkspaceBudgetError(
      `This document cannot give out budgets: its owner has to set ${COSTS_ADMIN_TOKEN_ENV} (an API token of the cost dashboard) in its environment.`
    );
  }
  return costs;
}

function parseProviders(raw: string): BudgetProviders {
  try {
    const parsed = JSON.parse(raw) as BudgetProviders;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export type ProvisionWorkspaceBudgetInput = {
  provisionerDocumentId: string;
  documentId: string;
  userId: string;
  budgetUsd: number;
  /** Used for the cost project's name and description. */
  title: string;
  documentUrl?: string;
};

export type ProvisionedWorkspaceBudget = {
  costsProject: string;
  costsParent: string | null;
  budgetUsd: number;
  providers: BudgetProviders;
};

/**
 * Give a workspace a budget and the credentials that go with it. A workspace
 * has at most one budget; change it with `updateWorkspaceBudget`. On failure
 * everything created so far is taken back, so nothing is left half set up.
 */
export async function provisionWorkspaceBudget(
  input: ProvisionWorkspaceBudgetInput,
  fetchImpl: FetchLike = fetch
): Promise<ProvisionedWorkspaceBudget> {
  const existing = await db.workspaceBudget.findUnique({ where: { documentId: input.documentId } });
  if (existing && !existing.closedAt) {
    throw new WorkspaceBudgetError(
      `That workspace already has a budget of $${existing.budgetUsd} (cost project "${existing.costsProject}"). Change it with set_workspace_budget.`
    );
  }
  const env = await loadProvisionerEnv(input.provisionerDocumentId);
  checkBudget(input.budgetUsd, env);
  const costs = requireCosts(env);
  const openweights = resolveOpenWeightsConfig(env); // throws on a half-configured provisioner, before anything is created
  const costsProject = existing?.costsProject ?? costsProjectName(input.title, input.documentId);
  const costsParent = env.COSTS_PARENT_PROJECT?.trim() || null;

  const providers: BudgetProviders = {};
  const undo: Array<() => Promise<unknown>> = [];
  try {
    await ensureCostsProject(
      costs,
      {
        name: costsProject,
        parent: costsParent,
        budgetUsd: input.budgetUsd,
        externalRef: `rdocs:${input.documentId}`,
        description: `r-docs workspace: ${input.title}`.slice(0, 200) + (input.documentUrl ? ` (${input.documentUrl})` : "")
      },
      fetchImpl
    );
    if (!existing) undo.push(() => deleteCostsProject(costs, costsProject, fetchImpl));

    if (env[LITELLM_ADMIN_KEY_ENV]?.trim()) {
      await provisionLiteLlmKey(
        {
          provisionerDocumentId: input.provisionerDocumentId,
          targetDocumentId: input.documentId,
          userId: input.userId,
          maxBudgetUsd: input.budgetUsd,
          replace: true,
          costsProject
        },
        fetchImpl
      );
      providers.litellm = "minted";
      undo.push(() =>
        revokeLiteLlmKey({ provisionerDocumentId: input.provisionerDocumentId, targetDocumentId: input.documentId }, fetchImpl)
      );
    }

    if (openweights) {
      // Named after the cost project: the dashboard gives a token's share of the
      // organization's spend to the project of that name.
      const name = costsProject;
      const minted = await createOpenWeightsToken(openweights, { name, spendingLimitUsd: input.budgetUsd }, fetchImpl);
      undo.push(() => revokeOpenWeightsToken(openweights, minted.tokenId, fetchImpl));
      await upsertDocumentEnv(input.documentId, OPENWEIGHTS_KEY_ENV, minted.token, true);
      undo.push(() => deleteDocumentEnv(input.documentId, OPENWEIGHTS_KEY_ENV));
      const record = await db.provisionedCredential.create({
        data: {
          provider: OPENWEIGHTS_PROVIDER,
          provisionerDocumentId: input.provisionerDocumentId,
          targetDocumentId: input.documentId,
          envKey: OPENWEIGHTS_KEY_ENV,
          keyAlias: name,
          externalId: minted.tokenId,
          maxBudgetUsd: input.budgetUsd,
          createdById: input.userId
        }
      });
      undo.push(() => db.provisionedCredential.update({ where: { id: record.id }, data: { revokedAt: new Date() } }));
      providers.openweights = "minted";
    }

    for (const [provider, keys] of Object.entries(SHARED_KEYS)) {
      if (!keys.every((key) => env[key]?.trim())) continue;
      await copyDocumentEnvKeys(input.provisionerDocumentId, input.documentId, keys);
      providers[provider] = "shared";
    }

    // Tinker goes through the credential broker here: the workspace's runs get a
    // per-run virtual key, their sessions are tagged with the cost project, and
    // the broker stops forwarding once the budget is used up.
    if (providers.tinker) await upsertDocumentEnv(input.documentId, "RDOCS_BROKER_TINKER", "1", false);
    await upsertDocumentEnv(input.documentId, COSTS_PROJECT_ENV, costsProject, false);
    const data = {
      provisionerDocumentId: input.provisionerDocumentId,
      costsProject,
      budgetUsd: input.budgetUsd,
      providers: JSON.stringify(providers),
      createdById: input.userId,
      closedAt: null
    };
    await db.workspaceBudget.upsert({
      where: { documentId: input.documentId },
      create: { documentId: input.documentId, ...data },
      update: data
    });
  } catch (error) {
    for (const step of undo.reverse()) {
      await step().catch((undoError) =>
        console.warn("[workspace-budget] could not undo a provisioning step", {
          documentId: input.documentId,
          error: undoError instanceof Error ? undoError.message : String(undoError)
        })
      );
    }
    throw error;
  }

  console.log(
    "[workspace-budget] provisioned",
    JSON.stringify({
      documentId: input.documentId,
      provisionerDocumentId: input.provisionerDocumentId,
      costsProject,
      costsParent,
      budgetUsd: input.budgetUsd,
      providers,
      userId: input.userId
    })
  );
  return { costsProject, costsParent, budgetUsd: input.budgetUsd, providers };
}

async function requireBudget(documentId: string) {
  const budget = await db.workspaceBudget.findUnique({ where: { documentId } });
  if (!budget) throw new WorkspaceBudgetError("That workspace has no budget.");
  return budget;
}

/**
 * Change a workspace's budget: in the dashboard, and on the limits of the keys
 * that were minted for it. Returns what could not be changed (`warnings`): the
 * dashboard budget is the reference, a provider that refuses keeps its old limit.
 */
export async function updateWorkspaceBudget(
  input: { documentId: string; budgetUsd: number },
  fetchImpl: FetchLike = fetch
): Promise<{ costsProject: string; budgetUsd: number; warnings: string[] }> {
  const budget = await requireBudget(input.documentId);
  const env = await loadProvisionerEnv(budget.provisionerDocumentId);
  checkBudget(input.budgetUsd, env);
  await updateCostsProject(requireCosts(env), budget.costsProject, { budgetUsd: input.budgetUsd, closed: false }, fetchImpl);
  await db.workspaceBudget.update({
    where: { id: budget.id },
    data: { budgetUsd: input.budgetUsd, closedAt: null }
  });

  const providers = parseProviders(budget.providers);
  const warnings: string[] = [];
  if (providers.litellm === "minted") {
    await updateLiteLlmKey(
      {
        provisionerDocumentId: budget.provisionerDocumentId,
        targetDocumentId: input.documentId,
        maxBudgetUsd: input.budgetUsd
      },
      fetchImpl
    ).catch((error) => {
      if (!isBudgetError(error)) throw error;
      warnings.push(`LiteLLM key limit not changed: ${error.message}`);
    });
  }
  if (providers.openweights === "minted") {
    const record = await db.provisionedCredential.findFirst({
      where: { provider: OPENWEIGHTS_PROVIDER, targetDocumentId: input.documentId, revokedAt: null },
      orderBy: { createdAt: "desc" }
    });
    try {
      const config = resolveOpenWeightsConfig(env);
      if (!config || !record?.externalId) throw new WorkspaceBudgetError("the provisioner no longer has an OpenWeights key.");
      await setOpenWeightsTokenLimit(config, { tokenId: record.externalId, spendingLimitUsd: input.budgetUsd }, fetchImpl);
      await db.provisionedCredential.update({ where: { id: record.id }, data: { maxBudgetUsd: input.budgetUsd } });
    } catch (error) {
      if (!isBudgetError(error)) throw error;
      warnings.push(`OpenWeights token limit not changed: ${error.message}`);
    }
  }
  // Whether the new budget is enough is decided against the dashboard right away,
  // not at the next periodic check (this also unblocks a key that was blocked).
  await enforceWorkspaceBudgets(fetchImpl);
  console.log(
    "[workspace-budget] updated",
    JSON.stringify({ documentId: input.documentId, costsProject: budget.costsProject, budgetUsd: input.budgetUsd, warnings })
  );
  return { costsProject: budget.costsProject, budgetUsd: input.budgetUsd, warnings };
}

/**
 * End a workspace's budget: the keys minted for it are revoked (and leave its
 * env), the cost project is marked closed (its numbers stay), and the budget
 * no longer applies. Shared keys and the document itself are left alone.
 * Returns what could not be revoked.
 */
export async function closeWorkspaceBudget(
  documentId: string,
  fetchImpl: FetchLike = fetch
): Promise<{ costsProject: string; warnings: string[] }> {
  const budget = await requireBudget(documentId);
  const env = await loadProvisionerEnv(budget.provisionerDocumentId);
  const providers = parseProviders(budget.providers);
  const warnings: string[] = [];
  const attempt = async (what: string, step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      if (!isBudgetError(error)) throw error;
      warnings.push(`${what}: ${error.message}`);
    }
  };
  if (providers.litellm === "minted") {
    await attempt("LiteLLM key not revoked", () =>
      revokeLiteLlmKey({ provisionerDocumentId: budget.provisionerDocumentId, targetDocumentId: documentId }, fetchImpl)
    );
  }
  if (providers.openweights === "minted") {
    await attempt("OpenWeights token not revoked", async () => {
      const record = await db.provisionedCredential.findFirst({
        where: { provider: OPENWEIGHTS_PROVIDER, targetDocumentId: documentId, revokedAt: null },
        orderBy: { createdAt: "desc" }
      });
      const config = resolveOpenWeightsConfig(env);
      if (!record?.externalId) return;
      if (!config) throw new WorkspaceBudgetError("the provisioner no longer has an OpenWeights key.");
      await revokeOpenWeightsToken(config, record.externalId, fetchImpl);
      await deleteDocumentEnv(documentId, OPENWEIGHTS_KEY_ENV);
      await db.provisionedCredential.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    });
  }
  await attempt("cost project not closed", () =>
    updateCostsProject(requireCosts(env), budget.costsProject, { closed: true }, fetchImpl)
  );
  await db.workspaceBudget.update({ where: { id: budget.id }, data: { closedAt: new Date(), exhaustedAt: null } });
  forgetRunBudgetStates();
  console.log("[workspace-budget] closed", JSON.stringify({ documentId, costsProject: budget.costsProject, warnings }));
  return { costsProject: budget.costsProject, warnings };
}

export type WorkspaceBudgetStatus = {
  costsProject: string;
  provisionerDocumentId: string;
  budgetUsd: number;
  providers: BudgetProviders;
  closedAt: string | null;
  /** Null when the dashboard could not be reached; `spendError` says why. */
  spend: CostsSpend | null;
  spendError: string | null;
};

/** The budget and what the cost dashboard says was spent, per provider. */
export async function getWorkspaceBudget(
  documentId: string,
  fetchImpl: FetchLike = fetch
): Promise<WorkspaceBudgetStatus | null> {
  const budget = await db.workspaceBudget.findUnique({ where: { documentId } });
  if (!budget) return null;
  let spend: CostsSpend | null = null;
  let spendError: string | null = null;
  try {
    spend = await getCostsSpend(requireCosts(await loadProvisionerEnv(budget.provisionerDocumentId)), budget.costsProject, fetchImpl);
  } catch (error) {
    if (!isBudgetError(error)) throw error;
    spendError = error.message;
  }
  return {
    costsProject: budget.costsProject,
    provisionerDocumentId: budget.provisionerDocumentId,
    budgetUsd: budget.budgetUsd,
    providers: parseProviders(budget.providers),
    closedAt: budget.closedAt?.toISOString() ?? null,
    spend,
    spendError
  };
}
