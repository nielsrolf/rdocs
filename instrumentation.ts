// Runs once when the Next.js server process boots (Node runtime only).
//
// Two startup chores:
//  1. Fail AiRuns left in a non-terminal state by a previous process. In a
//     single-process deploy (see CLAUDE.md), any RUNNING run at boot is orphaned
//     — its in-process work died with the old process and will never finish.
//  2. GC worktrees left behind by crashed runs so disk doesn't grow unbounded.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Dynamic imports so this module stays inert in non-node runtimes.
  const { db } = await import("@/lib/db");
  const { gcStaleWorktrees } = await import("@/lib/research-workspace");

  try {
    // Snapshot the orphans' workspaces BEFORE flipping their status, so their
    // uncommitted work can be preserved for session continuation.
    const orphanedRuns = await db.aiRun.findMany({
      where: { status: { in: ["RUNNING", "PENDING"] } },
      select: { id: true, documentId: true, workspacePath: true, branchName: true }
    });
    const orphaned = await db.aiRun.updateMany({
      where: { status: { in: ["RUNNING", "PENDING"] } },
      data: {
        status: "FAILED",
        error: "Run was interrupted by a server restart.",
        finishedAt: new Date()
      }
    });
    if (orphaned.count > 0) {
      console.log(`[startup] failed ${orphaned.count} orphaned AI run(s) from a previous process.`);
    }
    if (orphanedRuns.length > 0) {
      // Don't block startup on git work; salvage runs in the background.
      const { salvageOrphanedRunWorkspaces } = await import("@/lib/run-salvage");
      void salvageOrphanedRunWorkspaces(orphanedRuns).catch((error) => {
        console.error("[startup] interrupted-run salvage failed", {
          error: error instanceof Error ? error.message : error
        });
      });
    }
  } catch (error) {
    console.error("[startup] failed to reap orphaned AI runs", {
      error: error instanceof Error ? error.message : error
    });
  }

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
