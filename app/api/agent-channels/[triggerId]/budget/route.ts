import { NextResponse } from "next/server";

import { resolveAgentApiChannel } from "@/lib/agent-api-channels";
import { getWorkspaceBudget, isWorkspaceBudgetError } from "@/lib/workspace-budget";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// The compute budget of the channel's workspace and what it has spent so far,
// per provider, as the cost dashboard reports it (with the dashboard's delay).
// `budget: null` = the workspace has no budget. For the integration that
// started the run, so it can show "spent $43 on tinker, $18 on litellm".
export async function GET(request: Request, { params }: { params: Promise<{ triggerId: string }> }) {
  const { triggerId } = await params;
  const channel = await resolveAgentApiChannel(triggerId, request.headers.get("authorization"));
  if (!channel) return NextResponse.json({ error: "Invalid or revoked agent API channel." }, { status: 401 });
  try {
    const budget = await getWorkspaceBudget(channel.documentId);
    if (!budget) return NextResponse.json({ budget: null });
    const row = await db.workspaceBudget.findUnique({ where: { documentId: channel.documentId }, select: { exhaustedAt: true } });
    const spend = budget.spend;
    return NextResponse.json({
      budget: {
        budget_usd: budget.budgetUsd,
        cost_project: budget.costsProject,
        providers: budget.providers,
        closed_at: budget.closedAt,
        // true while the workspace is stopped because the budget is used up
        exhausted: Boolean(row?.exhaustedAt),
        ...(spend
          ? {
              spent_usd: spend.spent_usd,
              estimated_usd: spend.estimated_usd,
              remaining_usd: spend.remaining_usd,
              by_provider: spend.by_provider,
              synced_at: spend.synced_at
            }
          : { spend_error: budget.spendError })
      }
    });
  } catch (error) {
    if (!isWorkspaceBudgetError(error)) throw error;
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
}
