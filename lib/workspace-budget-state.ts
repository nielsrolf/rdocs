// What a run needs to know about its workspace's budget, on the credential
// broker's hot path: the cost project to tag spend with, and whether the
// budget is used up. Kept apart from lib/workspace-budget.ts (which pulls in
// every provisioning client) and cached briefly, because a Tinker training run
// asks this thousands of times.

import { db } from "@/lib/db";

export type RunBudgetState = { costsProject: string | null; exhausted: boolean };

const TTL_MS = 20_000;
const MAX_ENTRIES = 2_000;
const CACHE_KEY = Symbol.for("gdocs.runBudgetStateCache");
type Entry = { state: RunBudgetState; at: number };

function cache(): Map<string, Entry> {
  const store = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;
  return (store[CACHE_KEY] ??= new Map());
}

/** Drop cached answers, e.g. after a budget was marked exhausted or raised. */
export function forgetRunBudgetStates(): void {
  cache().clear();
}

export class WorkspaceBudgetExhaustedError extends Error {}

/** Refuse to start a run in a workspace whose budget is used up. */
export async function assertWorkspaceBudgetAvailable(documentId: string): Promise<void> {
  const budget = await db.workspaceBudget.findUnique({
    where: { documentId },
    select: { budgetUsd: true, exhaustedAt: true, closedAt: true }
  });
  if (budget?.exhaustedAt && !budget.closedAt) {
    throw new WorkspaceBudgetExhaustedError(
      `This workspace's compute budget ($${budget.budgetUsd}) is used up, so no agent can run here. ` +
        "The budget can be raised from the workspace that gave it (set_workspace_budget)."
    );
  }
}

export async function runBudgetState(aiRunId: string, now = Date.now()): Promise<RunBudgetState> {
  const entries = cache();
  const hit = entries.get(aiRunId);
  if (hit && now - hit.at < TTL_MS) return hit.state;
  const run = await db.aiRun.findUnique({ where: { id: aiRunId }, select: { documentId: true } });
  const budget = run
    ? await db.workspaceBudget.findUnique({
        where: { documentId: run.documentId },
        select: { costsProject: true, exhaustedAt: true, closedAt: true }
      })
    : null;
  const state: RunBudgetState =
    budget && !budget.closedAt
      ? { costsProject: budget.costsProject, exhausted: Boolean(budget.exhaustedAt) }
      : { costsProject: null, exhausted: false };
  if (entries.size >= MAX_ENTRIES) entries.clear();
  entries.set(aiRunId, { state, at: now });
  return state;
}
