// Per-thread, mid-run Slack bookkeeping: messages queued behind a working run,
// and the anchors of messages that were STEERED into a live run and therefore
// still owe a ✅/❌ when that run finishes.
//
// This state is in-memory (a restart legitimately forgets it), but it must be
// PROCESS-wide, and a module-local Map is not that: Next.js evaluates
// `instrumentation.ts` — owner of the Slack socket and the scheduler — in a
// different module context than the App Router route handlers, which is where
// the agent's own `message_thread` tool starts runs. With per-module Maps a run
// started from the route context was invisible to the socket context's
// bookkeeping: a DM follow-up got injected into the live run (that registry
// already lives on globalThis) but its 👀 was recorded in a map copy the run's
// onFinished never read, so it never flipped to ✅ (real failure 2026-08-10).
// Same trap, same remedy as `lib/agent-runner/run-registry.ts`.

export const SLACK_THREAD_STATE_GLOBAL_KEY = "__rdocsSlackThreadState__";

export type QueuedFollowUp = {
  userId: string;
  slackUserId: string;
  senderName: string;
  text: string;
  ts: string;
};

type SlackThreadState = {
  queuedFollowUps: Map<string, QueuedFollowUp[]>;
  steeredRunAnchors: Map<string, Array<{ ts: string }>>;
};

const stateHost = globalThis as typeof globalThis & {
  [SLACK_THREAD_STATE_GLOBAL_KEY]?: SlackThreadState;
};

const state: SlackThreadState = (stateHost[SLACK_THREAD_STATE_GLOBAL_KEY] ??= {
  queuedFollowUps: new Map<string, QueuedFollowUp[]>(),
  steeredRunAnchors: new Map<string, Array<{ ts: string }>>()
});

export const queuedFollowUps = state.queuedFollowUps;
export const steeredRunAnchors = state.steeredRunAnchors;
