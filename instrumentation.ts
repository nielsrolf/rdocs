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
}
