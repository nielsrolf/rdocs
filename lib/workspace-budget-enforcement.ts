// Enforcing workspace budgets (lib/workspace-budget.ts gives them out).
//
// The cost dashboard knows what a workspace has spent across all providers,
// with a delay. Every few minutes this module asks it about every open budget:
//
//   used up  → WorkspaceBudget.exhaustedAt is set. From then on the credential
//              broker answers 402 to every request of the workspace's runs
//              (LLM calls, Tinker — whatever goes through it), no new run
//              starts (assertWorkspaceBudgetAvailable), the workspace's LiteLLM
//              key is blocked at the proxy (it also works outside r-docs), and
//              the runs this process owns are stopped.
//   raised   → the flag is cleared and the key unblocked.
//   meanwhile the LiteLLM key's own limit is kept at "what the other providers
//              have left over": budget minus non-LiteLLM spend. LiteLLM
//              enforces that immediately, so LLM spend cannot run past the
//              total even between two looks at the dashboard.
//
// What this cannot stop: spend that does not go through the broker and is not
// a minted key — a shared Modal token, a Tinker key used without the broker,
// jobs already submitted to OpenWeights (its own token limit covers those).
// And because the dashboard lags (Tinker about an hour), a budget is overshot
// by whatever is spent in that time.

import { getCostsSpend, resolveCostsConfig, type CostsSpend } from "@/lib/costs-client";
import { cancelAiRun } from "@/lib/agent-runner/run-registry";
import { db } from "@/lib/db";
import { loadProvisionerEnv } from "@/lib/document-env";
import { updateLiteLlmKey } from "@/lib/litellm-provisioning";
import { forgetRunBudgetStates } from "@/lib/workspace-budget-state";

type FetchLike = typeof fetch;

export type BudgetEnforcementResult = {
  checked: number;
  exhausted: string[];
  restored: string[];
  errors: string[];
};

const LITELLM_PROVIDER = "litellm";

function providersOf(raw: string): Record<string, string> {
  try {
    return (JSON.parse(raw) as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

/** What the LiteLLM key may still spend in total: the budget minus what other providers used. */
export function liteLlmAllowance(budgetUsd: number, spend: Pick<CostsSpend, "spent_usd" | "by_provider">): number {
  const litellm = spend.by_provider.find((entry) => entry.provider === LITELLM_PROVIDER)?.usd ?? 0;
  const others = Math.max(0, spend.spent_usd - litellm);
  return Math.max(0, Math.round((budgetUsd - others) * 100) / 100);
}

async function setLiteLlmKey(
  budget: { documentId: string; provisionerDocumentId: string },
  change: { maxBudgetUsd?: number; blocked?: boolean },
  fetchImpl: FetchLike
) {
  await updateLiteLlmKey(
    { provisionerDocumentId: budget.provisionerDocumentId, targetDocumentId: budget.documentId, ...change },
    fetchImpl
  );
}

async function stopRuns(documentId: string, message: string) {
  const runs = await db.aiRun.findMany({ where: { documentId, status: "RUNNING" }, select: { id: true } });
  for (const run of runs) {
    await db.aiRunEvent.create({ data: { aiRunId: run.id, role: "error", message } }).catch(() => null);
    cancelAiRun(run.id); // false for a run another process owns: the broker's 402 stops its spending
  }
  return runs.length;
}

/** One pass over every open budget. Never throws: a budget that cannot be checked is reported in `errors`. */
export async function enforceWorkspaceBudgets(fetchImpl: FetchLike = fetch): Promise<BudgetEnforcementResult> {
  const result: BudgetEnforcementResult = { checked: 0, exhausted: [], restored: [], errors: [] };
  const budgets = await db.workspaceBudget.findMany({ where: { closedAt: null } });
  const envs = new Map<string, Record<string, string>>();
  for (const budget of budgets) {
    try {
      let env = envs.get(budget.provisionerDocumentId);
      if (!env) envs.set(budget.provisionerDocumentId, (env = await loadProvisionerEnv(budget.provisionerDocumentId)));
      const costs = resolveCostsConfig(env);
      if (!costs) throw new Error("the provisioner no longer has COSTS_ADMIN_TOKEN");
      const spend = await getCostsSpend(costs, budget.costsProject, fetchImpl);
      result.checked++;
      const usedUp = spend.remaining_usd !== null && spend.remaining_usd <= 0;
      const hasLiteLlmKey = providersOf(budget.providers).litellm === "minted";

      if (usedUp && !budget.exhaustedAt) {
        await db.workspaceBudget.update({ where: { id: budget.id }, data: { exhaustedAt: new Date() } });
        forgetRunBudgetStates();
        const stopped = await stopRuns(
          budget.documentId,
          `Stopped: this workspace's compute budget is used up ($${spend.spent_usd} spent, budget $${budget.budgetUsd}).`
        );
        if (hasLiteLlmKey) await setLiteLlmKey(budget, { blocked: true }, fetchImpl);
        result.exhausted.push(budget.costsProject);
        console.warn(
          "[workspace-budget] used up",
          JSON.stringify({
            documentId: budget.documentId,
            costsProject: budget.costsProject,
            budgetUsd: budget.budgetUsd,
            spentUsd: spend.spent_usd,
            byProvider: spend.by_provider,
            limits: spend.limits,
            stoppedRuns: stopped
          })
        );
        continue;
      }
      if (!usedUp && budget.exhaustedAt) {
        await db.workspaceBudget.update({ where: { id: budget.id }, data: { exhaustedAt: null } });
        forgetRunBudgetStates();
        if (hasLiteLlmKey) await setLiteLlmKey(budget, { blocked: false }, fetchImpl);
        result.restored.push(budget.costsProject);
        console.log("[workspace-budget] available again", JSON.stringify({ documentId: budget.documentId, costsProject: budget.costsProject }));
      }
      if (!usedUp && hasLiteLlmKey) {
        const allowance = liteLlmAllowance(budget.budgetUsd, spend);
        const record = await db.provisionedCredential.findFirst({
          where: { provider: LITELLM_PROVIDER, targetDocumentId: budget.documentId, revokedAt: null },
          orderBy: { createdAt: "desc" },
          select: { maxBudgetUsd: true }
        });
        if (record && Math.abs((record.maxBudgetUsd ?? -1) - allowance) >= 0.01) {
          await setLiteLlmKey(budget, { maxBudgetUsd: allowance }, fetchImpl);
        }
      }
    } catch (error) {
      result.errors.push(`${budget.costsProject}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (result.errors.length > 0) console.warn("[workspace-budget] enforcement errors", JSON.stringify(result.errors));
  return result;
}

let loop: NodeJS.Timeout | null = null;

/** Started and stopped with the scheduler loop (lib/scheduler.ts), so a draining process stops enforcing. */
export function startBudgetEnforcementLoop(intervalMs = Number(process.env.WORKSPACE_BUDGET_CHECK_SECONDS ?? 300) * 1000) {
  if (loop || !(intervalMs > 0)) return;
  let running = false;
  loop = setInterval(() => {
    if (running) return;
    running = true;
    enforceWorkspaceBudgets()
      .catch((error) => console.error("[workspace-budget] enforcement failed", { error: String(error) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  loop.unref?.();
  console.log("[workspace-budget] enforcement loop started", { intervalMs });
}

export function stopBudgetEnforcementLoop() {
  if (!loop) return;
  clearInterval(loop);
  loop = null;
}
