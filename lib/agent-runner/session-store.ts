// Durable bookkeeping for a detached session container.
//
// The app is a stateless reader of the container (see container-session.ts), so
// these four columns on AiRun are the ENTIRE handover surface between one
// deployment and the next:
//
//   containerId     → what to reap if the session is really dead
//   sessionEndpoint → where to attach (http://127.0.0.1:<published host port>)
//   sessionSecret   → the per-container bearer secret
//   frameCursor     → how far this run's events have been persisted
//
// Two rules are encoded here. The handle is written BEFORE any work starts
// (a running container nothing can reach is the failure mode this whole design
// removes), and the endpoint/secret are cleared once the container has been
// released, so neither boot adoption nor the reaper talks to a corpse.

import type { DetachedSessionHandle, DetachedSessionStore } from "./container-session";

export function detachedContainersEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const value = env.AGENT_DETACHED_CONTAINERS;
  return value === "1" || value === "true";
}

type AiRunSessionUpdate = Record<string, unknown>;

export type AiRunSessionStoreDeps = {
  /** Injected for tests; defaults to a Prisma update of the AiRun row. */
  update?: (data: AiRunSessionUpdate) => Promise<void>;
  now?: () => number;
  /** Minimum gap between cursor writes; the final write always lands. */
  cursorIntervalMs?: number;
};

/**
 * Persistence hooks for one detached run. `aiRunId` is optional because some
 * container jobs (merge_resolve) have no AiRun row — those simply do not
 * participate in adoption.
 */
export function createAiRunSessionStore(
  aiRunId: string | undefined,
  deps?: AiRunSessionStoreDeps
): DetachedSessionStore {
  if (!aiRunId) return {};
  const now = deps?.now ?? (() => Date.now());
  const interval = deps?.cursorIntervalMs ?? 2_000;
  const update =
    deps?.update ??
    (async (data: AiRunSessionUpdate) => {
      const { db } = await import("@/lib/db");
      await db.aiRun.update({ where: { id: aiRunId }, data: data as never }).catch((error) => {
        // Losing a cursor write is survivable (frames replay idempotently);
        // losing the run is not, so this never throws into the agent loop.
        console.warn(
          `[agent-session] failed to persist session state for run ${aiRunId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    });

  let lastWrittenCursor = -1;
  let lastWriteAt = -Infinity;
  let pendingCursor: number | null = null;

  const flushCursor = async () => {
    if (pendingCursor === null || pendingCursor === lastWrittenCursor) return;
    const cursor = pendingCursor;
    pendingCursor = null;
    lastWrittenCursor = cursor;
    lastWriteAt = now();
    await update({ frameCursor: cursor });
  };

  return {
    async onStarted(handle: DetachedSessionHandle) {
      // Deliberately not caught: if we cannot record the container, the caller
      // removes it instead of leaving an unreachable one running.
      await update({
        containerId: handle.containerId,
        sessionEndpoint: handle.endpoint,
        sessionSecret: handle.secret,
        frameCursor: 0
      });
      lastWrittenCursor = 0;
    },
    async onCursor(cursor: number) {
      if (cursor <= lastWrittenCursor) return;
      pendingCursor = cursor;
      if (now() - lastWriteAt < interval) return;
      await flushCursor();
    },
    async onFinished() {
      // Land the newest cursor even if the throttle window was open, then stop
      // advertising an endpoint that is about to stop answering.
      await flushCursor();
      await update({ sessionEndpoint: null, sessionSecret: null });
    }
  };
}
