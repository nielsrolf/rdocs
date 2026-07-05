import type { ActiveAiRunView, AiRunEventView } from "./types";

// Content fingerprint of a polled run list. The 2s document poll returns fresh
// object identities every tick even when nothing changed; re-setting state from
// them re-renders the whole agent view, which yanks auto-scroll and disturbs
// any text selection the user is making. Callers compare fingerprints and skip
// the state update entirely for no-op polls.
export function aiRunsFingerprint(runs: ActiveAiRunView[]): string {
  return JSON.stringify(runs);
}

export type AgentConversation = {
  rootId: string;
  runs: ActiveAiRunView[];
  events: AiRunEventView[];
  latestRun: ActiveAiRunView;
  rootInstruction: string;
  startedAt: string | Date;
  lastActivityAt: string | Date;
  status: string;
  branchName: string | null;
  commitSha: string | null;
  commitUrl: string | null;
  progress: string | null;
};

export function buildConversations(runs: ActiveAiRunView[]): AgentConversation[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const rootIdFor = (run: ActiveAiRunView): string => {
    let cursor: ActiveAiRunView = run;
    const seen = new Set<string>();
    while (cursor.parentRunId && byId.has(cursor.parentRunId) && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentRunId)!;
    }
    return cursor.id;
  };
  const grouped = new Map<string, ActiveAiRunView[]>();
  for (const run of runs) {
    const rootId = rootIdFor(run);
    if (!grouped.has(rootId)) grouped.set(rootId, []);
    grouped.get(rootId)!.push(run);
  }
  const conversations: AgentConversation[] = [];
  for (const [rootId, list] of grouped) {
    const sorted = [...list].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
    );
    const events = sorted
      .flatMap((run) => run.events ?? [])
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const latest = sorted[sorted.length - 1];
    const root = sorted[0];
    conversations.push({
      rootId,
      runs: sorted,
      events,
      latestRun: latest,
      rootInstruction: root.instruction,
      startedAt: root.startedAt,
      lastActivityAt: latest.finishedAt ?? latest.startedAt,
      status: latest.status,
      branchName: latest.branchName ?? null,
      commitSha: latest.commitSha ?? null,
      commitUrl: latest.commitUrl ?? null,
      progress: latest.progress
    });
  }
  conversations.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
  );
  return conversations;
}
