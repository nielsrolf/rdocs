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
//        tinker       the provisioner's TINKER_API_KEY, handed on by name and
//                     used through the credential broker (RDOCS_BROKER_TINKER)
//        modal        the provisioner's MODAL_TOKEN_ID / MODAL_TOKEN_SECRET,
//                     plus the workspace's OWN Modal environment
//                     (MODAL_ENVIRONMENT), which the dashboard creates
//   3. sets COSTS_PROJECT in the workspace env, the name agents tag other
//      shared-key spend with (RunPod pod name prefix) — see the compute-costs skill.
//
// What is and is not enforced. LiteLLM and OpenWeights enforce the limit of
// the minted key themselves, each up to the FULL budget (a limit per provider,
// not a reservation). The combined total is enforced by
// lib/workspace-budget-enforcement.ts: LiteLLM key, broker (Tinker), and for
// Modal by stopping every app in the workspace's environment. A Modal token
// has no limit and is not confined to that environment: an agent that names
// another environment escapes both the count and the stop. Modal's own
// per-environment budgets are a plan feature we do not have.
//
// Only providers the provisioner has credentials for are set up; the result
// says which. Authorization (edit on provisioner and workspace) is the
// caller's job, as in lib/workspace-provisioning.ts.

import {
  costsProjectName,
  COSTS_ADMIN_TOKEN_ENV,
  CostsError,
  deleteCostsModalEnvironment,
  deleteCostsProject,
  ensureCostsModalEnvironment,
  ensureCostsProject,
  getCostsSpend,
  resolveCostsConfig,
  stopCostsModalApps,
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
export const MODAL_ENVIRONMENT_ENV = "MODAL_ENVIRONMENT";
const OPENWEIGHTS_KEY_ENV = "OPENWEIGHTS_API_KEY";
const OPENWEIGHTS_PROVIDER = "openweights";
const MAX_BUDGET_USD = 1_000_000;
// Keys of the provisioner that a budgeted workspace shares (no limit of their own).
const SHARED_KEYS: Record<string, string[]> = {
  tinker: ["TINKER_API_KEY"],
  modal: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
};

type FetchLike = typeof fetch;
/**
 * "minted": the workspace's own key, limited to the budget. "shared": the
 * provisioner's key, no limit of its own. "environment" (Modal): the shared
 * token plus the workspace's own Modal environment, counted and stoppable.
 */
export type BudgetProviders = Record<string, "minted" | "shared" | "environment">;

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
  /**
   * The cost dashboard project to put the workspace's project under. Default:
   * the provisioner's COSTS_PARENT_PROJECT, else top level. Must exist there.
   */
  costsParent?: string | null;
};

export type ProvisionedWorkspaceBudget = {
  costsProject: string;
  costsParent: string | null;
  budgetUsd: number;
  providers: BudgetProviders;
  /** What could not be set up as intended (the budget itself stands). */
  warnings: string[];
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
  const costsParent = input.costsParent?.trim() || env.COSTS_PARENT_PROJECT?.trim() || null;

  const providers: BudgetProviders = {};
  const warnings: string[] = [];
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
    ).catch((error) => {
      // The dashboard answers 404 "no project '<parent>'" for a parent it does not know.
      if (costsParent && error instanceof CostsError && error.message.includes(`no project '${costsParent}'`)) {
        throw new WorkspaceBudgetError(
          `The cost dashboard has no project "${costsParent}" to put this workspace under. Use the name of an existing project (list them in the dashboard), or leave the parent out.`
        );
      }
      throw error;
    });
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

    // Modal: the token has no limit, so the workspace gets its own environment.
    // What runs there is counted for the workspace and can be stopped.
    if (providers.modal) {
      try {
        const modal = await ensureCostsModalEnvironment(
          costs,
          costsProject,
          { tokenId: env.MODAL_TOKEN_ID.trim(), tokenSecret: env.MODAL_TOKEN_SECRET.trim() },
          fetchImpl
        );
        // Only an environment this call created is ours to delete again.
        if (modal.created) undo.push(() => deleteCostsModalEnvironment(costs, costsProject, fetchImpl));
        await upsertDocumentEnv(input.documentId, MODAL_ENVIRONMENT_ENV, modal.environment, false);
        providers.modal = "environment";
      } catch (error) {
        if (!(error instanceof CostsError)) throw error;
        warnings.push(
          `Modal: no environment of its own (${error.message}). The workspace shares the Modal token without a limit; its Modal spend only counts when apps are tagged project=${costsProject}.`
        );
      }
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
      warnings,
      userId: input.userId
    })
  );
  return { costsProject, costsParent, budgetUsd: input.budgetUsd, providers, warnings };
}

const provisionerWhere = (userId: string) => ({
  envVars: { some: { key: COSTS_ADMIN_TOKEN_ENV } },
  OR: [{ ownerId: userId }, { memberships: { some: { userId, permission: "EDIT" } } }]
});

/**
 * The documents a user may hand out budgets from: they can edit it, and its env
 * holds the cost dashboard token. (Group grants are not considered: a budget
 * spends the provisioner's money, so it takes direct edit access.)
 */
export async function listBudgetProvisioners(userId: string): Promise<Array<{ id: string; title: string }>> {
  return db.document.findMany({
    where: provisionerWhere(userId),
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true }
  });
}

export async function canProvisionBudgetFrom(userId: string, provisionerDocumentId: string): Promise<boolean> {
  return (await db.document.count({ where: { id: provisionerDocumentId, ...provisionerWhere(userId) } })) > 0;
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
 * env), the apps in its Modal environment are stopped, the cost project is
 * marked closed (its numbers stay), and the budget no longer applies. Shared
 * keys and the document itself are left alone. The Modal environment stays
 * (its volumes may hold results) unless `deleteModalEnvironment` is set.
 * Returns what could not be revoked.
 */
export async function closeWorkspaceBudget(
  documentId: string,
  fetchImpl: FetchLike = fetch,
  options: { deleteModalEnvironment?: boolean } = {}
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
  if (providers.modal === "environment") {
    await attempt(options.deleteModalEnvironment ? "Modal environment not deleted" : "Modal apps not stopped", async () => {
      const costs = requireCosts(env);
      if (options.deleteModalEnvironment) {
        await deleteCostsModalEnvironment(costs, budget.costsProject, fetchImpl);
        await deleteDocumentEnv(documentId, MODAL_ENVIRONMENT_ENV);
      } else {
        await stopCostsModalApps(costs, budget.costsProject, fetchImpl);
      }
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
