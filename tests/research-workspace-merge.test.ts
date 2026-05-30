import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ensureBaseWorkspaceClean, syncBranchToBaseWorkspace } from "../lib/research-workspace";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(repo: string, rel: string, content: string | Buffer) {
  const full = path.join(repo, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// A tiny "PNG-like" binary payload with NUL bytes so git treats it as binary.
function binaryBlob(seed: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, seed, 0, 255, seed, 7]);
}

// Builds a base repo on `main` whose HEAD added assets/foo.txt="BASE", plus a
// divergent commit (returned sha) that added the same file with different content,
// so merging the sha into main is guaranteed to conflict (both added).
function makeConflictingRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "rw-merge-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.test");
  git(repo, "config", "user.name", "Test");
  writeFile(repo, "README.md", "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");

  // Divergent branch adds assets/foo.txt = "FEATURE".
  git(repo, "checkout", "-q", "-b", "feature");
  writeFile(repo, "assets/foo.txt", "FEATURE\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "feature");
  const featureSha = git(repo, "rev-parse", "HEAD");

  // main adds assets/foo.txt = "BASE" -> conflicts with feature on merge.
  git(repo, "checkout", "-q", "main");
  writeFile(repo, "assets/foo.txt", "BASE\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "main-change");

  return { repo, featureSha };
}

function isClean(repo: string) {
  return git(repo, "status", "--porcelain") === "" && !existsSync(path.join(repo, ".git", "MERGE_HEAD"));
}

test("a failed conflict resolution never leaves the base wedged mid-merge", async () => {
  const { repo, featureSha } = makeConflictingRepo();
  try {
    // Resolver throws — exactly what a Claude merge-agent timeout/error does.
    await assert.rejects(
      syncBranchToBaseWorkspace(repo, featureSha, false, async () => {
        throw new Error("resolver timed out");
      }),
      /resolver timed out/
    );

    // The bug: the base used to be left with MERGE_HEAD + "AA"/"A" unmerged paths,
    // so the NEXT run threw "Cannot merge … pending changes" forever.
    assert.ok(isClean(repo), `base must be clean after a failed merge, got:\n${git(repo, "status", "--porcelain")}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ensureBaseWorkspaceClean recovers a repo left mid-merge", async () => {
  const { repo, featureSha } = makeConflictingRepo();
  try {
    // Wedge it like the old code did: start the conflicting merge and walk away.
    try {
      git(repo, "merge", "--no-edit", featureSha);
    } catch {
      // expected conflict
    }
    assert.ok(existsSync(path.join(repo, ".git", "MERGE_HEAD")), "precondition: merge is in progress");
    assert.notEqual(git(repo, "status", "--porcelain"), "", "precondition: working tree dirty");

    await ensureBaseWorkspaceClean(repo);

    assert.ok(isClean(repo), "recovery must restore a clean base");
    assert.equal(git(repo, "show", "HEAD:assets/foo.txt"), "BASE", "HEAD content is preserved");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sync self-heals a pre-wedged base, then merges the new commit", async () => {
  const { repo, featureSha } = makeConflictingRepo();
  try {
    // Leave a leftover merge from a previous crashed run.
    try {
      git(repo, "merge", "--no-edit", featureSha);
    } catch {
      /* conflict */
    }
    assert.ok(existsSync(path.join(repo, ".git", "MERGE_HEAD")));

    // A fresh run whose resolver succeeds (resolves + stages the merged file) must
    // recover from the leftover merge and finish.
    await syncBranchToBaseWorkspace(repo, featureSha, false, async (base) => {
      writeFile(base, "assets/foo.txt", "MERGED\n");
      git(base, "add", "-A");
    });

    assert.ok(isClean(repo), "base clean after a successful self-healed merge");
    assert.equal(git(repo, "show", "HEAD:assets/foo.txt"), "MERGED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a clean fast-forward merge still works", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "rw-ff-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "Test");
    writeFile(repo, "README.md", "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    git(repo, "checkout", "-q", "-b", "feature");
    writeFile(repo, "assets/plot.txt", "data\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "feature");
    const featureSha = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");

    await syncBranchToBaseWorkspace(repo, featureSha, false, async () => {
      throw new Error("resolver should not be called for a clean merge");
    });

    assert.ok(isClean(repo));
    assert.equal(git(repo, "show", "HEAD:assets/plot.txt"), "data");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a binary asset conflict resolves automatically (takes the incoming version, no resolver)", async () => {
  // Two parallel runs each generate a different assets/sine_plot.png — git can't
  // merge binaries, and the old code dead-ended with "could not resolve … sine_plot.png".
  const repo = mkdtempSync(path.join(tmpdir(), "rw-bin-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "Test");
    writeFile(repo, "README.md", "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");

    // Incoming run's branch: its own binary plot.
    git(repo, "checkout", "-q", "-b", "feature");
    writeFile(repo, "assets/sine_plot.png", binaryBlob(11));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "feature plot");
    const featureSha = git(repo, "rev-parse", "HEAD");
    const theirs = git(repo, "rev-parse", "feature:assets/sine_plot.png");

    // main (base) committed a different binary plot at the same path -> add/add binary conflict.
    git(repo, "checkout", "-q", "main");
    writeFile(repo, "assets/sine_plot.png", binaryBlob(99));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base plot");

    // The text resolver must NOT be needed for a pure binary conflict.
    await syncBranchToBaseWorkspace(repo, featureSha, false, async () => {
      throw new Error("text resolver should not be called for a binary-only conflict");
    });

    assert.ok(isClean(repo), `base must be clean after the binary merge:\n${git(repo, "status", "--porcelain")}`);
    // The incoming run's version won.
    assert.equal(git(repo, "rev-parse", "HEAD:assets/sine_plot.png"), theirs);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
