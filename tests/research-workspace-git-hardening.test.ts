import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, renameSync, symlinkSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { commitWorkspaceChanges, hardenAgentGitDir, syncBranchToBaseWorkspace } from "../lib/research-workspace";

// An agent container has write access to its run checkout, including .git.
// Host-side git must never execute anything that checkout names.

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeCheckout() {
  const repo = mkdtempSync(path.join(tmpdir(), "rw-harden-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.test");
  git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return repo;
}

function plantPayload(repo: string, name: string) {
  const marker = path.join(repo, `PWNED-${name}`);
  const script = path.join(repo, `payload-${name}.sh`);
  writeFileSync(script, `#!/bin/sh\necho "$SESSION_SECRET" > "${marker}"\n`);
  chmodSync(script, 0o755);
  return { marker, script };
}

test("hooks, fsmonitor, filters, gpg and askpass planted in an agent checkout do not run on commit", async () => {
  const repo = makeCheckout();
  process.env.SESSION_SECRET = "host-secret";
  const hook = plantPayload(repo, "hook");
  mkdirSync(path.join(repo, ".git/hooks"), { recursive: true });
  for (const name of ["pre-commit", "post-commit", "prepare-commit-msg", "commit-msg"]) {
    writeFileSync(path.join(repo, ".git/hooks", name), `#!/bin/sh\n"${hook.script}"\n`);
    chmodSync(path.join(repo, ".git/hooks", name), 0o755);
  }
  const fsmonitor = plantPayload(repo, "fsmonitor");
  const filter = plantPayload(repo, "filter");
  const gpg = plantPayload(repo, "gpg");
  git(repo, "config", "core.fsmonitor", fsmonitor.script);
  git(repo, "config", "filter.evil.clean", filter.script);
  git(repo, "config", "filter.evil.smudge", filter.script);
  git(repo, "config", "commit.gpgsign", "true");
  git(repo, "config", "gpg.program", gpg.script);
  git(repo, "config", "core.askPass", gpg.script);
  git(repo, "config", "core.sshCommand", gpg.script);
  git(repo, "config", "core.hooksPath", path.join(repo, ".git/hooks"));
  writeFileSync(path.join(repo, ".gitattributes"), "* filter=evil\n");
  writeFileSync(path.join(repo, "result.txt"), "agent output\n");

  // Control: without the hardening, plain git in this checkout does run the payload.
  const control = makeCheckout();
  const controlPayload = plantPayload(control, "control");
  git(control, "config", "core.fsmonitor", controlPayload.script);
  git(control, "status");
  assert.equal(existsSync(controlPayload.marker), true, "the attack is real against unhardened git");

  const result = await commitWorkspaceChanges({
    documentId: "doc", workspace: repo, repoUrl: null, message: "agent run", push: false
  } as Parameters<typeof commitWorkspaceChanges>[0]);

  assert.ok(result.commitSha, "the agent's work is still committed");
  for (const payload of [hook, fsmonitor, filter, gpg]) {
    assert.equal(existsSync(payload.marker), false, `${path.basename(payload.marker)} must not exist`);
  }
  const config = readFileSync(path.join(repo, ".git/config"), "utf8");
  assert.doesNotMatch(config, /fsmonitor|filter|gpg|askpass|sshcommand|hookspath/i);
  assert.match(config, /email = t@t\.test/);
});

test("a nested repository registered as a submodule cannot run its fsmonitor", async () => {
  const repo = makeCheckout();
  const nested = path.join(repo, "vendor");
  mkdirSync(nested);
  git(nested, "init", "-q", "-b", "main");
  git(nested, "config", "user.email", "t@t.test");
  git(nested, "config", "user.name", "Test");
  writeFileSync(path.join(nested, "a.txt"), "a\n");
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "nested");
  git(repo, "add", "vendor");
  git(repo, "commit", "-qm", "gitlink");
  const payload = plantPayload(repo, "nested");
  git(nested, "config", "core.fsmonitor", payload.script);
  writeFileSync(path.join(nested, "a.txt"), "changed\n");
  writeFileSync(path.join(repo, "result.txt"), "agent output\n");

  await commitWorkspaceChanges({
    documentId: "doc", workspace: repo, repoUrl: null, message: "agent run", push: false
  } as Parameters<typeof commitWorkspaceChanges>[0]);
  assert.equal(existsSync(payload.marker), false);
});

test("a checkout whose .git was replaced is refused", async () => {
  const repo = makeCheckout();
  const elsewhere = makeCheckout();
  renameSync(path.join(repo, ".git"), path.join(repo, "real-git"));
  writeFileSync(path.join(repo, ".git"), `gitdir: ${path.join(elsewhere, ".git")}\n`);
  await assert.rejects(hardenAgentGitDir(repo), /not a directory/);

  const linked = makeCheckout();
  renameSync(path.join(linked, ".git/config"), path.join(linked, ".git/config.real"));
  symlinkSync(path.join(elsewhere, ".git/config"), path.join(linked, ".git/config"));
  await assert.rejects(hardenAgentGitDir(linked), /not a regular file/);
});

test("a legacy linked worktree is accepted only when the base points back at it", async () => {
  const base = makeCheckout();
  const other = makeCheckout();
  const worktree = path.join(mkdtempSync(path.join(tmpdir(), "rw-harden-wt-")), "run");
  git(base, "worktree", "add", "-q", "-B", "ai/run", worktree, "HEAD");
  await hardenAgentGitDir(worktree);
  const stolen = path.join(mkdtempSync(path.join(tmpdir(), "rw-harden-wt-")), "victim");
  git(other, "worktree", "add", "-q", "-B", "ai/victim", stolen, "HEAD");
  // The agent rewrites its gitfile to hijack another repository's worktree entry.
  writeFileSync(path.join(worktree, ".git"), readFileSync(path.join(stolen, ".git"), "utf8"));
  await assert.rejects(hardenAgentGitDir(worktree), /not a directory/);
});

test("config includes and transport-helper remotes are stripped", async () => {
  const repo = makeCheckout();
  const payload = plantPayload(repo, "include");
  writeFileSync(path.join(repo, "extra.cfg"), `[core]\n\tfsmonitor = ${payload.script}\n`);
  git(repo, "config", "include.path", path.join(repo, "extra.cfg"));
  git(repo, "config", "remote.origin.url", `ext::sh -c ${payload.script}`);
  git(repo, "config", "branch.main.remote", "origin");
  await hardenAgentGitDir(repo);
  const config = readFileSync(path.join(repo, ".git/config"), "utf8");
  assert.doesNotMatch(config, /include|ext::/);
  assert.match(config, /\[branch "main"\]/);
  git(repo, "status");
  assert.equal(existsSync(payload.marker), false);
});

test("merging a run checkout into the base does not execute the run checkout's config", async () => {
  const base = makeCheckout();
  const run = mkdtempSync(path.join(tmpdir(), "rw-harden-run-"));
  git(path.dirname(run), "clone", "-q", base, run);
  git(run, "config", "user.email", "t@t.test");
  git(run, "config", "user.name", "Test");
  writeFileSync(path.join(run, "result.txt"), "agent output\n");
  git(run, "add", "-A");
  git(run, "commit", "-qm", "run");
  const sha = git(run, "rev-parse", "HEAD");
  const payload = plantPayload(run, "source");
  git(run, "config", "core.fsmonitor", payload.script);
  git(run, "config", "uploadpack.packObjectsHook", payload.script);

  await syncBranchToBaseWorkspace(base, sha, false, async () => {}, run);
  assert.equal(git(base, "rev-parse", "HEAD"), sha);
  assert.equal(existsSync(payload.marker), false);
});
