import fs from "node:fs/promises";

import { recordAiRunEvent } from "@/lib/ai-runs";
import { db } from "@/lib/db";
import { commitWorkspaceChanges, getWorkspacePath, removeRunWorktree } from "@/lib/research-workspace";

export type OrphanedRunWorkspace = {
  id: string;
  documentId: string;
  workspacePath: string | null;
  branchName: string | null;
};

// Preserve the uncommitted work of runs that died with the previous server
// process (restart/crash). A run that fails NORMALLY commits its worktree in
// its catch block, so its work is already merged into the base checkout — but
// an interrupted run never reached that path, leaving its work stranded in a
// worktree that the 6h GC would silently delete. Committing + merging it here
// means a session continuation (follow-up into the interrupted session) starts
// from everything the dead agent had done.
export async function salvageOrphanedRunWorkspaces(runs: OrphanedRunWorkspace[]) {
  const salvaged: Array<{ id: string; commitSha: string }> = [];
  for (const run of runs) {
    if (!run.workspacePath) continue;
    try {
      const exists = await fs
        .stat(run.workspacePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue;
      const doc = await db.document.findUnique({
        where: { id: run.documentId },
        select: { repoUrl: true }
      });
      const repoUrl = doc?.repoUrl ?? null;
      const baseWorkspace = getWorkspacePath(run.documentId, repoUrl);
      const commit = await commitWorkspaceChanges({
        workspace: run.workspacePath,
        baseWorkspace,
        repoUrl,
        message: "Preserve work from interrupted AI run",
        push: true
      });
      if (commit.commitSha) {
        await db.aiRun
          .update({
            where: { id: run.id },
            data: { commitSha: commit.commitSha, commitUrl: commit.commitUrl }
          })
          .catch(() => null);
        await recordAiRunEvent({
          aiRunId: run.id,
          role: "system",
          message: `The interrupted run's unsaved workspace changes were preserved as commit ${commit.commitSha.slice(0, 7)} and merged into the document repository. A follow-up message into this session continues from that state.`
        }).catch(() => null);
        salvaged.push({ id: run.id, commitSha: commit.commitSha });
      }
      if (run.branchName) {
        await removeRunWorktree({
          baseWorkspace,
          worktree: run.workspacePath,
          branchName: run.branchName
        }).catch(() => null);
      }
    } catch (error) {
      console.error("[startup] failed to salvage interrupted run workspace", {
        aiRunId: run.id,
        workspacePath: run.workspacePath,
        error: error instanceof Error ? error.message : error
      });
    }
  }
  if (salvaged.length > 0) {
    console.log(
      `[startup] preserved workspace changes from ${salvaged.length} interrupted AI run(s): ${salvaged
        .map((s) => `${s.id}@${s.commitSha.slice(0, 7)}`)
        .join(", ")}`
    );
  }
  return salvaged;
}
