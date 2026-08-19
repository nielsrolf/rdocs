import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { db } from "../lib/db";
import {
  commitWorkspaceChanges,
  ensureLinkedRepositoryWorktree,
  removeRunWorktree,
  resolveWorkspaceDocumentId
} from "../lib/research-workspace";
import { setWorkspaceLink, WorkspaceLinkError } from "../lib/workspace-link";

// A document with `workspaceDocumentId` set shares the base workspace of the
// referenced slack_channel document: its runs check out worktrees from — and
// merge results back into — the channel's workspace, so a doc and its Slack
// channel see the same files.

const WORKSPACE_ROOT = path.join(process.cwd(), ".research-workspaces");

async function makeUser() {
  return db.user.create({
    data: { email: `wl-${crypto.randomUUID()}@example.com`, name: "wl", passwordHash: "x" }
  });
}

async function makeSlackChannelDocument(ownerId: string) {
  return db.document.create({
    data: {
      ownerId,
      title: "#test-channel",
      content: "{}",
      kind: "slack_channel",
      slackTeamId: `T-${crypto.randomUUID()}`,
      slackChannelId: `C-${crypto.randomUUID()}`
    }
  });
}

async function cleanup(documentIds: string[], userIds: string[]) {
  for (const id of documentIds) {
    await fs.rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true }).catch(() => null);
    await db.document.deleteMany({ where: { id } });
  }
  for (const id of userIds) {
    await db.user.deleteMany({ where: { id } });
  }
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("managed run checkout follows the fetched remote default branch and has self-contained git metadata", async () => {
  const user = await makeUser();
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rdocs-remote-refresh-"));
  const source = path.join(fixture, "source");
  const remote = path.join(fixture, "remote.git");
  await fs.mkdir(source);
  git(source, "init", "--initial-branch=master");
  git(source, "config", "user.email", "test@example.com");
  git(source, "config", "user.name", "Test");
  await fs.writeFile(path.join(source, "README.md"), "initial\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "initial");
  execFileSync("git", ["clone", "--bare", source, remote]);

  const doc = await db.document.create({
    data: { ownerId: user.id, title: "Remote refresh", content: "{}", repoUrl: remote }
  });

  try {
    // Materialize the app's base clone while the remote only has the initial commit.
    const first = await ensureLinkedRepositoryWorktree(doc.id, "run-before-remote-update");
    assert.ok(first);
    await removeRunWorktree(first);

    // Advance the remote without touching the app's checked-out local branch.
    await fs.mkdir(path.join(source, "pilot"));
    await fs.writeFile(path.join(source, "pilot", "run.py"), "print('pilot')\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "add pilot");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "master");

    // Simulate local workspace content that cannot be pushed yet. Both
    // harnesses must see this draft AND the newly fetched remote pilot files.
    await fs.writeFile(path.join(first.baseWorkspace, "local-draft.txt"), "uncommitted workspace draft\n");
    await fs.mkdir(path.join(remote, "hooks"), { recursive: true });
    const rejectPush = path.join(remote, "hooks", "pre-receive");
    await fs.writeFile(rejectPush, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const refreshed = await ensureLinkedRepositoryWorktree(doc.id, "run-after-remote-update");
    assert.ok(refreshed);
    assert.equal(await fs.readFile(path.join(refreshed.worktree, "pilot", "run.py"), "utf8"), "print('pilot')\n");
    assert.equal(
      await fs.readFile(path.join(refreshed.worktree, "local-draft.txt"), "utf8"),
      "uncommitted workspace draft\n"
    );
    assert.equal(
      (await fs.stat(path.join(refreshed.worktree, ".git"))).isDirectory(),
      true,
      "the isolated checkout must remain a git repository when mounted without the base clone"
    );
    assert.equal(git(refreshed.worktree, "status", "--short"), "");
    await removeRunWorktree(refreshed);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
    await cleanup([doc.id], [user.id]);
  }
});

test("runs on a linked doc share the slack channel document's workspace", async () => {
  const user = await makeUser();
  const channelDoc = await makeSlackChannelDocument(user.id);
  const doc = await db.document.create({
    data: {
      ownerId: user.id,
      title: "Linked doc",
      content: "{}",
      workspaceDocumentId: channelDoc.id
    }
  });

  try {
    assert.equal(await resolveWorkspaceDocumentId(doc.id), channelDoc.id);
    assert.equal(await resolveWorkspaceDocumentId(channelDoc.id), channelDoc.id);

    // A run on the linked doc gets a worktree under the CHANNEL doc's dir.
    const worktree1 = await ensureLinkedRepositoryWorktree(doc.id, "run-link-1");
    assert.ok(worktree1);
    assert.equal(worktree1.workspaceDocumentId, channelDoc.id);
    assert.ok(
      worktree1.baseWorkspace.includes(path.join(".research-workspaces", channelDoc.id)),
      `base workspace ${worktree1.baseWorkspace} must live under the channel doc's dir`
    );
    assert.ok(
      worktree1.worktree.includes(path.join(".research-workspaces", channelDoc.id, "worktrees")),
      `worktree ${worktree1.worktree} must live under the channel doc's dir`
    );

    // Work committed from the linked doc's run lands in the shared base…
    await fs.writeFile(path.join(worktree1.worktree, "shared-note.md"), "hello from linked doc\n");
    const commit = await commitWorkspaceChanges({
      workspace: worktree1.worktree,
      baseWorkspace: worktree1.baseWorkspace,
      repoUrl: null,
      message: "note from linked doc",
      push: false
    });
    assert.ok(commit.commitSha);
    await removeRunWorktree(worktree1);

    // …and a run on the CHANNEL doc itself sees it.
    const worktree2 = await ensureLinkedRepositoryWorktree(channelDoc.id, "run-channel-1");
    assert.ok(worktree2);
    const content = await fs.readFile(path.join(worktree2.worktree, "shared-note.md"), "utf8");
    assert.equal(content, "hello from linked doc\n");
    await removeRunWorktree(worktree2);
  } finally {
    await cleanup([doc.id, channelDoc.id], [user.id]);
  }
});

test("a dangling workspace link falls back to the doc's own workspace", async () => {
  const user = await makeUser();
  const doc = await db.document.create({
    data: {
      ownerId: user.id,
      title: "Dangling link doc",
      content: "{}",
      workspaceDocumentId: "does-not-exist"
    }
  });
  try {
    assert.equal(await resolveWorkspaceDocumentId(doc.id), doc.id);
    const worktree = await ensureLinkedRepositoryWorktree(doc.id, "run-dangling-1");
    assert.ok(worktree);
    assert.equal(worktree.workspaceDocumentId, doc.id);
    await removeRunWorktree(worktree);
  } finally {
    await cleanup([doc.id], [user.id]);
  }
});

test("setWorkspaceLink validates the target and clears any linked repo", async () => {
  const owner = await makeUser();
  const outsider = await makeUser();
  const channelDoc = await makeSlackChannelDocument(owner.id);
  const plainDoc = await db.document.create({
    data: { ownerId: owner.id, title: "Plain doc", content: "{}" }
  });
  const doc = await db.document.create({
    data: {
      ownerId: owner.id,
      title: "Doc with repo",
      content: "{}",
      repoUrl: "https://github.com/example/repo",
      repoBranch: "main",
      repoWorkspace: "/tmp/somewhere"
    }
  });

  try {
    // Target must be a slack_channel document.
    await assert.rejects(
      setWorkspaceLink({ documentId: doc.id, targetDocumentId: plainDoc.id, userId: owner.id }),
      WorkspaceLinkError
    );

    // Linking requires EDIT access to the target document.
    await assert.rejects(
      setWorkspaceLink({ documentId: doc.id, targetDocumentId: channelDoc.id, userId: outsider.id }),
      (error: unknown) => error instanceof WorkspaceLinkError && error.status === 403
    );

    // A slack_channel document cannot itself link a workspace.
    await assert.rejects(
      setWorkspaceLink({
        documentId: channelDoc.id,
        targetDocumentId: channelDoc.id,
        userId: owner.id
      }),
      WorkspaceLinkError
    );

    // A valid link clears the repo fields (mutual exclusion).
    const link = await setWorkspaceLink({
      documentId: doc.id,
      targetDocumentId: channelDoc.id,
      userId: owner.id
    });
    assert.equal(link?.id, channelDoc.id);
    const updated = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
      select: { workspaceDocumentId: true, repoUrl: true, repoBranch: true, repoWorkspace: true }
    });
    assert.equal(updated.workspaceDocumentId, channelDoc.id);
    assert.equal(updated.repoUrl, null);
    assert.equal(updated.repoBranch, null);
    assert.equal(updated.repoWorkspace, null);

    // Disconnect.
    const cleared = await setWorkspaceLink({
      documentId: doc.id,
      targetDocumentId: null,
      userId: owner.id
    });
    assert.equal(cleared, null);
    const after = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
      select: { workspaceDocumentId: true }
    });
    assert.equal(after.workspaceDocumentId, null);
  } finally {
    await cleanup([doc.id, plainDoc.id, channelDoc.id], [owner.id, outsider.id]);
  }
});
