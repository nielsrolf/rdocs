import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { commitWorkspaceChanges } from "../lib/research-workspace";

// Regression: a denied `git push` (e.g. the bot account lacks write access to
// the linked repo — GitHub 403) used to make commitWorkspaceChanges throw AFTER
// the local commit succeeded. The ai-edit route's catch block then marked the
// whole run FAILED and discarded the agent's already-submitted response. A
// push failure must be non-fatal: the local commit is the source of truth and
// the caller decides how to surface the push error.

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepoWithDeniedOrigin() {
  const repo = mkdtempSync(path.join(tmpdir(), "rw-push-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  // An origin that always rejects the push (nonexistent local path).
  git(repo, "remote", "add", "origin", path.join(repo, "does-not-exist.git"));
  return repo;
}

test("a denied push still returns the local commit instead of throwing", async () => {
  const repo = makeRepoWithDeniedOrigin();
  try {
    writeFileSync(path.join(repo, "result.md"), "agent output\n");

    const result = await commitWorkspaceChanges({
      workspace: repo,
      repoUrl: "https://github.com/example/denied",
      message: "AI research for document edit",
      push: true
    });

    assert.ok(result.commitSha, "local commit sha must be returned");
    assert.equal(result.pushed, false, "push did not happen");
    assert.ok(result.pushError, "push failure must be reported in the result");
    assert.equal(git(repo, "rev-parse", "HEAD"), result.commitSha, "the work is committed locally");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a successful commit without origin still reports pushed=false and no pushError", async () => {
  const repo = makeRepoWithDeniedOrigin();
  try {
    git(repo, "remote", "remove", "origin");
    writeFileSync(path.join(repo, "result.md"), "agent output\n");

    const result = await commitWorkspaceChanges({
      workspace: repo,
      repoUrl: null,
      message: "AI research for document edit",
      push: true
    });

    assert.ok(result.commitSha);
    assert.equal(result.pushed, false);
    assert.equal(result.pushError ?? null, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
