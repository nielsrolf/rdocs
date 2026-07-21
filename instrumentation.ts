// Runs once when the Next.js server process boots (Node runtime only).
//
// Startup chores:
//  1. Reap AiRuns abandoned by a DEAD previous process — judged by the silence
//     rule (no heartbeat/event within STALE_AI_RUN_MS), NOT by "any
//     non-terminal run at boot is orphaned". With blue/green deploys
//     (deploy/deploy.sh) the old process keeps draining its in-flight runs
//     while the new one boots; those runs heartbeat and must survive.
//  2. Keep a periodic global sweep running so runs owned by a crashed process
//     get reaped even when nobody has their document open (the doc-poll route
//     only reaps runs of documents being viewed).
//  3. GC worktrees left behind by crashed runs so disk doesn't grow unbounded.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Dynamic imports so this module stays inert in non-node runtimes.
  const { sweepAbandonedAiRuns } = await import("@/lib/ai-runs");
  const { gcStaleWorktrees } = await import("@/lib/research-workspace");

  const runSweep = async (label: string) => {
    const { failed, scanned } = await sweepAbandonedAiRuns();
    if (failed.length > 0) {
      console.log(
        `[${label}] reaped ${failed.length}/${scanned} abandoned AI run(s) from a dead process.`
      );
      // Snapshot the orphans' workspaces so their uncommitted work can be
      // preserved for session continuation. Background — never blocks.
      const { salvageOrphanedRunWorkspaces } = await import("@/lib/run-salvage");
      void salvageOrphanedRunWorkspaces(failed).catch((error) => {
        console.error(`[${label}] interrupted-run salvage failed`, {
          error: error instanceof Error ? error.message : error
        });
      });
    }
  };

  try {
    await runSweep("startup");
  } catch (error) {
    console.error("[startup] failed to reap orphaned AI runs", {
      error: error instanceof Error ? error.message : error
    });
  }

  // Periodic global reaper — silence-based, so it can never kill a run whose
  // owning process (this one or a draining sibling) is still heartbeating.
  const globalReaper = setInterval(() => {
    runSweep("reaper").catch((error) => {
      console.error("[reaper] global sweep failed", {
        error: error instanceof Error ? error.message : error
      });
    });
  }, 5 * 60_000);
  globalReaper.unref?.();

  // Don't block startup on filesystem GC.
  void gcStaleWorktrees().catch((error) => {
    console.error("[startup] worktree GC failed", {
      error: error instanceof Error ? error.message : error
    });
  });

  // Periodically reap idle collaboration rooms (no subscribers, no presence) so
  // the in-memory rooms map doesn't grow unbounded for the process lifetime.
  // Also catches rooms created transiently by poll-only clients. unref() so it
  // never keeps the process alive on its own.
  // Slack bot (Socket Mode) — no-op unless SLACK_BOT_TOKEN + SLACK_APP_TOKEN
  // are configured. Don't block startup on the websocket handshake.
  void import("@/lib/slack/service")
    .then(({ startSlackSocketService }) => startSlackSocketService())
    .catch((error) => {
      console.error("[startup] slack service failed to start", {
        error: error instanceof Error ? error.message : error
      });
    });

  // Scheduled agent tasks (Slack schedule_task tool) — 30s DB poll, no-op
  // when nothing is due.
  try {
    const { startSchedulerLoop } = await import("@/lib/scheduler");
    startSchedulerLoop();
  } catch (error) {
    console.error("[startup] scheduler failed to start", {
      error: error instanceof Error ? error.message : error
    });
  }

  const { reapIdleCollaborationRooms } = await import("@/lib/collaboration");
  const reaper = setInterval(() => {
    try {
      reapIdleCollaborationRooms();
    } catch {
      // best-effort
    }
  }, 60_000);
  reaper.unref?.();
}
