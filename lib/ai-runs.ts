import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

// A RUNNING run is considered abandoned (server restart/crash) only after this
// much *silence*: no AiRunEvent, no runner heartbeat, and startedAt at least
// this old. Agent activity alone is NOT a reliable liveness signal — an agent
// blocked on a long tool wait (Monitor calls wait up to an hour) emits no
// events at all — so the runner also ticks AiRun.heartbeatAt on a timer for as
// long as the owning process is alive (startAiRunHeartbeat). Silence past the
// threshold therefore means the process died, not that the agent is slow.
export const STALE_AI_RUN_MS = 15 * 60 * 1000;

// How often an in-process runner refreshes AiRun.heartbeatAt. Must be well
// under STALE_AI_RUN_MS so a couple of missed ticks (event-loop stalls, slow
// SQLite writes) never look like a dead server.
export const AI_RUN_HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Keeps AiRun.heartbeatAt fresh while the owning process runs the agent. Call
// at the start of the background run function and invoke the returned stop()
// in its finally — a leaked interval would keep a zombie row unreapable
// forever. Writes are best-effort and scoped to status RUNNING so a tick can
// never resurrect a finished run.
export function startAiRunHeartbeat(aiRunId: string): () => void {
  const tick = () => {
    db.aiRun
      .updateMany({ where: { id: aiRunId, status: "RUNNING" }, data: { heartbeatAt: new Date() } })
      .catch(() => null);
  };
  tick();
  const timer = setInterval(tick, AI_RUN_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

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
  const [lastEvents, heartbeats] = await Promise.all([
    db.aiRunEvent.groupBy({
      by: ["aiRunId"],
      where: { aiRunId: { in: candidates.map((run) => run.id) } },
      _max: { createdAt: true }
    }),
    // Fetched here (not taken from the caller's rows) so a heartbeat written
    // after the caller's query still counts.
    db.aiRun.findMany({
      where: { id: { in: candidates.map((run) => run.id) } },
      select: { id: true, heartbeatAt: true }
    })
  ]);
  const lastEventAt = new Map(lastEvents.map((e) => [e.aiRunId, e._max.createdAt?.getTime() ?? 0]));
  const heartbeatAt = new Map(heartbeats.map((r) => [r.id, r.heartbeatAt?.getTime() ?? 0]));
  const abandonedIds = candidates
    .filter((run) => {
      const lastActivity = Math.max(
        run.startedAt.getTime(),
        lastEventAt.get(run.id) ?? 0,
        heartbeatAt.get(run.id) ?? 0
      );
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

// The single terminal-success write for agent runs. All three agent routes
// (ai-edit, agents conversation, comment ask-ai) go through this. `error` is
// force-cleared: the reaper may have falsely marked a quiet-but-alive run as
// abandoned mid-flight, and a run that reaches success must not carry that
// stale error text alongside its SUCCEEDED status.
export async function markAiRunSucceeded(
  aiRunId: string,
  data: Omit<Prisma.AiRunUpdateInput, "status" | "finishedAt" | "error">
) {
  return db.aiRun.update({
    where: { id: aiRunId },
    data: {
      ...data,
      status: "SUCCEEDED",
      error: null,
      finishedAt: new Date()
    }
  });
}

const CONVERSATION_HISTORY_ROLES = new Set(["user", "agent"]);
const MAX_CONVERSATION_TURNS = 24;

// Walk the parentRunId chain backwards from `previousRunId` and flatten the
// user/agent events of the whole session into prompt-ready history. Used by
// conversation follow-ups AND by edit-session continuations (a follow-up into a
// failed/cancelled SELECTION_EDIT run), so the next agent knows what the
// previous attempt already did.
export async function buildConversationHistory(documentId: string, previousRunId: string | null) {
  if (!previousRunId) {
    return { history: [] as Array<{ role: string; message: string }>, rootRunId: null as string | null };
  }
  const chain: Array<{ id: string; parentRunId: string | null }> = [];
  let cursorId: string | null = previousRunId;
  const visited = new Set<string>();
  while (cursorId && !visited.has(cursorId) && chain.length < MAX_CONVERSATION_TURNS) {
    visited.add(cursorId);
    const run: { id: string; parentRunId: string | null; documentId: string } | null = await db.aiRun.findUnique({
      where: { id: cursorId },
      select: { id: true, parentRunId: true, documentId: true }
    });
    if (!run || run.documentId !== documentId) {
      break;
    }
    chain.push({ id: run.id, parentRunId: run.parentRunId });
    cursorId = run.parentRunId;
  }
  if (chain.length === 0) {
    return { history: [], rootRunId: null };
  }
  chain.reverse();
  const events = await db.aiRunEvent.findMany({
    where: { aiRunId: { in: chain.map((entry) => entry.id) } },
    orderBy: { createdAt: "asc" },
    select: { role: true, message: true }
  });
  const history = events.filter((event) => CONVERSATION_HISTORY_ROLES.has(event.role));
  return { history, rootRunId: chain[0]?.id ?? null };
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

// How many run rows the document poll returns, and how many of each run's
// events. The event window must show the LATEST activity — a run that outgrows
// it should drop its oldest events, not freeze.
export const AI_RUN_LIST_LIMIT = 12;
export const AI_RUN_EVENT_WINDOW = 80;

// The run list the document poll (and the agent view) is built from. Shared
// with tests so the event-window behavior is pinned by a regression test.
export async function fetchDocumentAiRuns(documentId: string) {
  const runs = await db.aiRun.findMany({
    where: { documentId },
    orderBy: { startedAt: "desc" },
    take: AI_RUN_LIST_LIMIT,
    select: {
      id: true,
      triggerType: true,
      triggerId: true,
      selectionId: true,
      selectedText: true,
      parentRunId: true,
      instruction: true,
      status: true,
      progress: true,
      model: true,
      workspacePath: true,
      branchName: true,
      commitSha: true,
      commitUrl: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      appliedAt: true,
      events: {
        // Newest N, then flipped back to chronological below — asc+take would
        // pin the window to a long run's FIRST N events and freeze the timeline.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: AI_RUN_EVENT_WINDOW,
        select: {
          id: true,
          role: true,
          message: true,
          createdAt: true
        }
      }
    }
  });
  return runs.map((run) => ({ ...run, events: [...run.events].reverse() }));
}

export function serializeAiRun(run: {
  id: string;
  triggerType: string;
  triggerId: string | null;
  selectionId?: string | null;
  selectedText?: string | null;
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
    selectedText: run.selectedText ?? null,
    parentRunId: run.parentRunId ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    appliedAt: run.appliedAt ?? null,
    events: run.events ?? []
  };
}
