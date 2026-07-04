import { db } from "@/lib/db";

// A RUNNING run is considered abandoned (server restart/crash) only after this
// much *silence*: no AiRunEvent for this long, and startedAt at least this old.
// Every agent progress tick writes an AiRunEvent, so healthy runs heartbeat
// continuously no matter how long they take. The largest legitimate silent
// window is a blocking tool wait (TaskOutput/Bash cap at 10 min), so the
// threshold must stay comfortably above that.
export const STALE_AI_RUN_MS = 15 * 60 * 1000;

export type AbandonedRunResult = {
  failedIds: Set<string>;
  error: string;
  finishedAt: Date;
};

// Marks abandoned RUNNING runs as FAILED. Returns the affected ids so callers
// can patch already-fetched copies, or null when nothing was reaped.
export async function failAbandonedAiRuns(
  runs: Array<{ id: string; status: string; startedAt: Date }>,
  now = Date.now()
): Promise<AbandonedRunResult | null> {
  // Runs younger than the threshold cannot have been silent longer than it, so
  // this pre-filter also avoids the event lookup on every poll of a fresh run.
  const candidates = runs.filter(
    (run) => run.status === "RUNNING" && now - run.startedAt.getTime() > STALE_AI_RUN_MS
  );
  if (candidates.length === 0) {
    return null;
  }
  const lastEvents = await db.aiRunEvent.groupBy({
    by: ["aiRunId"],
    where: { aiRunId: { in: candidates.map((run) => run.id) } },
    _max: { createdAt: true }
  });
  const lastEventAt = new Map(lastEvents.map((e) => [e.aiRunId, e._max.createdAt?.getTime() ?? 0]));
  const abandonedIds = candidates
    .filter((run) => {
      const lastActivity = Math.max(run.startedAt.getTime(), lastEventAt.get(run.id) ?? 0);
      return now - lastActivity > STALE_AI_RUN_MS;
    })
    .map((run) => run.id);
  if (abandonedIds.length === 0) {
    return null;
  }
  const finishedAt = new Date();
  const error = "Run abandoned (server restart or crash).";
  await db.aiRun.updateMany({
    where: { id: { in: abandonedIds }, status: "RUNNING" },
    data: { status: "FAILED", error, finishedAt }
  });
  return { failedIds: new Set(abandonedIds), error, finishedAt };
}

export async function recordAiRunEvent(input: {
  aiRunId: string;
  role: "system" | "user" | "agent" | "tool" | "tool_result" | "error";
  message: string;
}) {
  const message = input.message.trim();
  if (!message) {
    return;
  }

  await db.aiRunEvent.create({
    data: {
      aiRunId: input.aiRunId,
      role: input.role,
      message
    }
  });
}

export function serializeAiRun(run: {
  id: string;
  triggerType: string;
  triggerId: string | null;
  selectionId?: string | null;
  parentRunId?: string | null;
  instruction: string;
  status: string;
  progress: string | null;
  model?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  commitSha?: string | null;
  commitUrl?: string | null;
  error?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
  appliedAt?: Date | null;
  events?: Array<{
    id: string;
    role: string;
    message: string;
    createdAt: Date;
  }>;
}) {
  return {
    ...run,
    selectionId: run.selectionId ?? null,
    parentRunId: run.parentRunId ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    appliedAt: run.appliedAt ?? null,
    events: run.events ?? []
  };
}
