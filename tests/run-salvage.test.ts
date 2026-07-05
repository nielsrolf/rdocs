import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { db } from "../lib/db";
import { getWorkspacePath } from "../lib/research-workspace";
import { salvageOrphanedRunWorkspaces } from "../lib/run-salvage";

// A run killed by a restart never reaches its catch block, so its uncommitted
// worktree changes used to be stranded (and GC'd after 6h). The boot sweep now
// commits + merges them into the base checkout so a session continuation starts
// from everything the dead agent had done.

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "initial");
}

test("an interrupted run's dirty worktree is committed, merged into base, and cleaned up", async () => {
  const user = await db.user.create({
    data: { email: `salvage-${crypto.randomUUID()}@example.com`, name: "salvage", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Salvage test", content: "{}", ownerId: user.id }
  });
  const documentRoot = path.join(process.cwd(), ".research-workspaces", document.id);
  try {
    const run = await db.aiRun.create({
      data: {
        documentId: document.id,
        triggerType: "SELECTION_EDIT",
        instruction: "long experiment",
        status: "FAILED",
        error: "Run was interrupted by a server restart."
      }
    });

    // Base checkout + per-run worktree, the way ensureLinkedRepositoryWorktree
    // lays them out for a local (repo-less) document.
    const base = getWorkspacePath(document.id, null);
    initRepo(base);
    const worktree = path.join(documentRoot, "worktrees", `${run.id}-local`);
    const branchName = `ai/${document.id}/${run.id}`;
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(base, "worktree", "add", "-B", branchName, worktree, "HEAD");
    fs.writeFileSync(path.join(worktree, "results.md"), "half-finished experiment output\n");

    await db.aiRun.update({
      where: { id: run.id },
      data: { workspacePath: worktree, branchName }
    });

    const salvaged = await salvageOrphanedRunWorkspaces([
      { id: run.id, documentId: document.id, workspacePath: worktree, branchName }
    ]);

    assert.equal(salvaged.length, 1, "the dirty worktree was salvaged");
    assert.ok(salvaged[0].commitSha);

    // The work is reachable from the BASE checkout — a follow-up run's fresh
    // worktree (cut from base HEAD) will contain it.
    const baseFile = path.join(base, "results.md");
    assert.ok(fs.existsSync(baseFile), "salvaged file merged into the base checkout");
    assert.equal(fs.readFileSync(baseFile, "utf8"), "half-finished experiment output\n");

    assert.equal(fs.existsSync(worktree), false, "worktree removed after salvage");

    const fresh = await db.aiRun.findUnique({
      where: { id: run.id },
      select: { commitSha: true, events: { orderBy: { createdAt: "desc" }, take: 1, select: { message: true } } }
    });
    assert.equal(fresh?.commitSha, salvaged[0].commitSha, "salvage commit recorded on the run");
    assert.match(fresh?.events[0]?.message ?? "", /preserved as commit/i);
  } finally {
    await db.document.delete({ where: { id: document.id } }).catch(() => null);
    await db.user.delete({ where: { id: user.id } }).catch(() => null);
    fs.rmSync(documentRoot, { recursive: true, force: true });
  }
});

test("runs without a workspace or with a clean/missing worktree are skipped quietly", async () => {
  const salvaged = await salvageOrphanedRunWorkspaces([
    { id: "no-workspace", documentId: "doc", workspacePath: null, branchName: null },
    { id: "gone", documentId: "doc", workspacePath: "/nonexistent/worktree/path", branchName: "b" }
  ]);
  assert.deepEqual(salvaged, []);
});
