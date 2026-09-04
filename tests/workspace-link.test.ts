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
import {
  getLinkedWorkspaceDocContext,
  setSlackChannelDocument,
  setWorkspaceLink,
  WorkspaceLinkError
} from "../lib/workspace-link";

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
    // The clone borrows the base's object FILES via hardlinks (cheap), but must
    // never borrow its object STORE via alternates — a `.git/objects/info/alternates`
    // pointing outside the mounted directory breaks every git command in the
    // container, and so would a gitfile `.git`.
    await assert.rejects(fs.stat(path.join(refreshed.worktree, ".git", "objects", "info", "alternates")));
    assert.equal(git(refreshed.worktree, "fsck", "--connectivity-only"), "");
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

// The reverse direction: start with a doc, then attach a Slack channel to it.
// Attaching a channel to a doc MERGES the channel document into the doc: the
// doc becomes the channel's backing document (Slack ids move onto it), so the
// doc's env/agent settings apply and Slack runs land in its agent tab. The
// separate slack_channel document is deleted.
test("linking a channel to a doc merges the channel document into the doc", async () => {
  const owner = await makeUser();
  const member = await makeUser();
  const channelDoc = await makeSlackChannelDocument(owner.id);
  const doc = await db.document.create({
    data: { ownerId: owner.id, title: "Canonical doc", content: "{}" }
  });
  // A doc that shared the channel's workspace must be repointed at the target.
  const followerDoc = await db.document.create({
    data: { ownerId: owner.id, title: "Follower", content: "{}", workspaceDocumentId: channelDoc.id }
  });
  await db.documentMembership.create({
    data: { documentId: channelDoc.id, userId: member.id, permission: "EDIT" }
  });
  const run = await db.aiRun.create({
    data: {
      documentId: channelDoc.id,
      triggerType: "SLACK_MENTION",
      triggerId: `${channelDoc.slackChannelId}:1.0`,
      instruction: "x",
      status: "FAILED",
      error: "test fixture"
    }
  });
  const task = await db.scheduledTask.create({
    data: {
      documentId: channelDoc.id,
      instruction: "test fixture — never fire",
      contextType: "slack_channel",
      slackTeamId: channelDoc.slackTeamId!,
      slackChannelId: channelDoc.slackChannelId!,
      nextRunAt: new Date(0),
      disabledAt: new Date()
    }
  });
  // Attachment: DB row + file on disk in the channel doc's store, plus a
  // colliding file already in the target doc's store.
  const channelStore = path.join(WORKSPACE_ROOT, channelDoc.id, "attachments");
  const targetStore = path.join(WORKSPACE_ROOT, doc.id, "attachments");
  await fs.mkdir(channelStore, { recursive: true });
  await fs.mkdir(targetStore, { recursive: true });
  await fs.writeFile(path.join(channelStore, "notes.txt"), "from channel\n");
  await fs.writeFile(path.join(targetStore, "notes.txt"), "already here\n");
  const attachment = await db.attachment.create({
    data: {
      documentId: channelDoc.id,
      fileName: "notes.txt",
      storedName: "notes.txt",
      mimeType: "text/plain",
      size: 13
    }
  });

  try {
    const link = await setWorkspaceLink({
      documentId: channelDoc.id,
      targetDocumentId: doc.id,
      userId: owner.id
    });
    assert.equal(link?.id, doc.id);

    // The channel document is gone; the target doc carries the Slack binding.
    assert.equal(await db.document.findUnique({ where: { id: channelDoc.id } }), null);
    const target = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
    assert.equal(target.slackTeamId, channelDoc.slackTeamId);
    assert.equal(target.slackChannelId, channelDoc.slackChannelId);
    // The Slack event path looks up the backing doc by team+channel: it must
    // now find the merged doc.
    const bySlackIds = await db.document.findUnique({
      where: {
        slackTeamId_slackChannelId: {
          slackTeamId: channelDoc.slackTeamId!,
          slackChannelId: channelDoc.slackChannelId!
        }
      }
    });
    assert.equal(bySlackIds?.id, doc.id);

    // History moved: runs, scheduled tasks, attachments.
    const movedRun = await db.aiRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(movedRun.documentId, doc.id);
    const movedTask = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(movedTask.documentId, doc.id);
    const movedAttachment = await db.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
    assert.equal(movedAttachment.documentId, doc.id);
    // Collision-safe copy: the target's own notes.txt is untouched, the
    // channel's file arrives under a renamed storedName.
    assert.notEqual(movedAttachment.storedName, "notes.txt");
    assert.equal(
      await fs.readFile(path.join(targetStore, movedAttachment.storedName), "utf8"),
      "from channel\n"
    );
    assert.equal(await fs.readFile(path.join(targetStore, "notes.txt"), "utf8"), "already here\n");

    // Channel members keep access: membership upserted on the target.
    const movedMembership = await db.documentMembership.findUnique({
      where: { documentId_userId: { documentId: doc.id, userId: member.id } }
    });
    assert.equal(movedMembership?.permission, "EDIT");

    // Docs that shared the channel's workspace now point at the target.
    const follower = await db.document.findUniqueOrThrow({ where: { id: followerDoc.id } });
    assert.equal(follower.workspaceDocumentId, doc.id);
  } finally {
    await db.scheduledTask.deleteMany({ where: { id: task.id } });
    await cleanup([followerDoc.id, channelDoc.id, doc.id], [owner.id, member.id]);
  }
});

// Legacy rows: a channel that still carries a workspaceDocumentId link from
// before merge semantics keeps resolving the doc's workspace and context.
test("a channel with a legacy doc link exposes the doc's content as conversation context", async () => {
  const user = await makeUser();
  const channelDoc = await makeSlackChannelDocument(user.id);
  const doc = await db.document.create({
    data: {
      ownerId: user.id,
      title: "Project plan",
      content: JSON.stringify({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Ship the reverse workspace link." }] }
        ]
      })
    }
  });

  try {
    // No link yet -> no linked context.
    assert.equal(await getLinkedWorkspaceDocContext(channelDoc.id), null);
    // A regular doc never gets linked context, even with a link set.
    assert.equal(await getLinkedWorkspaceDocContext(doc.id), null);

    await db.document.update({
      where: { id: channelDoc.id },
      data: { workspaceDocumentId: doc.id }
    });
    assert.equal(await resolveWorkspaceDocumentId(channelDoc.id), doc.id);
    const context = await getLinkedWorkspaceDocContext(channelDoc.id);
    assert.ok(context);
    assert.equal(context.id, doc.id);
    assert.equal(context.title, "Project plan");
    assert.match(context.text, /Ship the reverse workspace link\./);
  } finally {
    await cleanup([channelDoc.id, doc.id], [user.id]);
  }
});

// A merged doc (kind "document" carrying Slack ids) can move its channel
// binding to another doc, or drop it entirely ("none").
test("a merged doc can move or drop its slack channel binding", async () => {
  const owner = await makeUser();
  const channelDoc = await makeSlackChannelDocument(owner.id);
  const teamId = channelDoc.slackTeamId!;
  const channelId = channelDoc.slackChannelId!;
  const docA = await db.document.create({
    data: { ownerId: owner.id, title: "Doc A", content: "{}" }
  });
  const docB = await db.document.create({
    data: { ownerId: owner.id, title: "Doc B", content: "{}" }
  });

  try {
    const merged = await setSlackChannelDocument({
      documentId: channelDoc.id,
      targetDocumentId: docA.id,
      userId: owner.id
    });
    assert.equal(merged.action, "merged");

    // Channel-scoped scheduled task, created after the merge, lives on docA.
    const task = await db.scheduledTask.create({
      data: {
        documentId: docA.id,
        instruction: "test fixture — never fire",
        contextType: "slack_channel",
        slackTeamId: teamId,
        slackChannelId: channelId,
        nextRunAt: new Date(0),
        disabledAt: new Date()
      }
    });

    // Re-link: move the binding from docA to docB.
    const moved = await setSlackChannelDocument({
      documentId: docA.id,
      targetDocumentId: docB.id,
      userId: owner.id
    });
    assert.equal(moved.action, "moved");
    assert.equal(moved.action === "moved" ? moved.target.id : null, docB.id);
    const afterA = await db.document.findUniqueOrThrow({ where: { id: docA.id } });
    assert.equal(afterA.slackTeamId, null);
    assert.equal(afterA.slackChannelId, null);
    const afterB = await db.document.findUniqueOrThrow({ where: { id: docB.id } });
    assert.equal(afterB.slackTeamId, teamId);
    assert.equal(afterB.slackChannelId, channelId);
    // Channel-scoped tasks follow the binding.
    const movedTask = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(movedTask.documentId, docB.id);

    // Re-linking to the doc that already backs the channel is a no-op.
    const unchanged = await setSlackChannelDocument({
      documentId: docB.id,
      targetDocumentId: docB.id,
      userId: owner.id
    });
    assert.equal(unchanged.action, "unchanged");

    // "none" drops the binding; the doc stays.
    const unbound = await setSlackChannelDocument({
      documentId: docB.id,
      targetDocumentId: null,
      userId: owner.id
    });
    assert.equal(unbound.action, "unbound");
    const afterUnbind = await db.document.findUniqueOrThrow({ where: { id: docB.id } });
    assert.equal(afterUnbind.slackTeamId, null);
    assert.equal(afterUnbind.slackChannelId, null);

    await db.scheduledTask.deleteMany({ where: { id: task.id } });
  } finally {
    await cleanup([channelDoc.id, docA.id, docB.id], [owner.id]);
  }
});

test("workspace resolution follows doc -> channel -> doc chains (two hops, cycle-safe)", async () => {
  const user = await makeUser();
  const canonicalDoc = await db.document.create({
    data: { ownerId: user.id, title: "Canonical", content: "{}" }
  });
  const channelDoc = await makeSlackChannelDocument(user.id);
  const otherDoc = await db.document.create({
    data: { ownerId: user.id, title: "Other doc", content: "{}" }
  });

  try {
    await db.document.update({
      where: { id: channelDoc.id },
      data: { workspaceDocumentId: canonicalDoc.id }
    });
    await db.document.update({
      where: { id: otherDoc.id },
      data: { workspaceDocumentId: channelDoc.id }
    });

    // otherDoc -> channel -> canonicalDoc: all three share one workspace.
    assert.equal(await resolveWorkspaceDocumentId(otherDoc.id), canonicalDoc.id);
    assert.equal(await resolveWorkspaceDocumentId(channelDoc.id), canonicalDoc.id);
    assert.equal(await resolveWorkspaceDocumentId(canonicalDoc.id), canonicalDoc.id);

    // A cycle written directly to the DB must not hang or throw.
    await db.document.update({
      where: { id: canonicalDoc.id },
      data: { workspaceDocumentId: channelDoc.id }
    });
    const resolved = await resolveWorkspaceDocumentId(otherDoc.id);
    assert.ok(
      resolved === canonicalDoc.id || resolved === channelDoc.id,
      `cycle resolution must settle on a chain member (got ${resolved})`
    );
  } finally {
    await cleanup([otherDoc.id, channelDoc.id, canonicalDoc.id], [user.id]);
  }
});

test("setWorkspaceLink validates channel -> doc merges", async () => {
  const owner = await makeUser();
  const outsider = await makeUser();
  const channelDoc = await makeSlackChannelDocument(owner.id);
  const otherChannel = await makeSlackChannelDocument(owner.id);
  const doc = await db.document.create({
    data: { ownerId: owner.id, title: "Target doc", content: "{}" }
  });
  const quicktake = await db.document.create({
    data: { ownerId: owner.id, title: "qt", content: "{}", kind: "quicktake", quicktakeBody: "x" }
  });
  const alreadyLinkedDoc = await db.document.create({
    data: {
      ownerId: owner.id,
      title: "Linked elsewhere",
      content: "{}",
      workspaceDocumentId: otherChannel.id
    }
  });
  const alreadyBoundDoc = await db.document.create({
    data: {
      ownerId: owner.id,
      title: "Already backs a channel",
      content: "{}",
      slackTeamId: `T-${crypto.randomUUID()}`,
      slackChannelId: `C-${crypto.randomUUID()}`
    }
  });

  try {
    // A channel cannot link another channel or a quicktake.
    await assert.rejects(
      setWorkspaceLink({ documentId: channelDoc.id, targetDocumentId: otherChannel.id, userId: owner.id }),
      WorkspaceLinkError
    );
    await assert.rejects(
      setWorkspaceLink({ documentId: channelDoc.id, targetDocumentId: quicktake.id, userId: owner.id }),
      WorkspaceLinkError
    );

    // A doc that already shares another workspace cannot become a target.
    await assert.rejects(
      setWorkspaceLink({ documentId: channelDoc.id, targetDocumentId: alreadyLinkedDoc.id, userId: owner.id }),
      WorkspaceLinkError
    );

    // A doc that already backs another Slack channel cannot become a target.
    await assert.rejects(
      setWorkspaceLink({ documentId: channelDoc.id, targetDocumentId: alreadyBoundDoc.id, userId: owner.id }),
      WorkspaceLinkError
    );

    // Edit access on the target doc is required.
    await assert.rejects(
      setWorkspaceLink({ documentId: channelDoc.id, targetDocumentId: doc.id, userId: outsider.id }),
      (error: unknown) => error instanceof WorkspaceLinkError && error.status === 403
    );

    // A valid channel -> doc link merges the channel into the doc.
    const link = await setWorkspaceLink({
      documentId: channelDoc.id,
      targetDocumentId: doc.id,
      userId: owner.id
    });
    assert.equal(link?.id, doc.id);
    assert.equal(await db.document.findUnique({ where: { id: channelDoc.id } }), null);

    // Legacy disconnect still works for channel documents with an old link.
    await db.document.update({
      where: { id: otherChannel.id },
      data: { workspaceDocumentId: doc.id }
    });
    const cleared = await setWorkspaceLink({
      documentId: otherChannel.id,
      targetDocumentId: null,
      userId: owner.id
    });
    assert.equal(cleared, null);
    const otherAfter = await db.document.findUniqueOrThrow({ where: { id: otherChannel.id } });
    assert.equal(otherAfter.workspaceDocumentId, null);
  } finally {
    await cleanup(
      [alreadyBoundDoc.id, alreadyLinkedDoc.id, quicktake.id, doc.id, otherChannel.id, channelDoc.id],
      [owner.id, outsider.id]
    );
  }
});

// After a merge, other docs can still join the channel's workspace by linking
// the merged doc (which now IS the channel's backing document).
test("a doc can link the workspace of a merged (slack-bound) doc", async () => {
  const owner = await makeUser();
  const mergedDoc = await db.document.create({
    data: {
      ownerId: owner.id,
      title: "Merged doc",
      content: "{}",
      slackTeamId: `T-${crypto.randomUUID()}`,
      slackChannelId: `C-${crypto.randomUUID()}`
    }
  });
  const plainDoc = await db.document.create({
    data: { ownerId: owner.id, title: "Plain", content: "{}" }
  });
  const joiner = await db.document.create({
    data: { ownerId: owner.id, title: "Joiner", content: "{}" }
  });

  try {
    // A plain (non-slack-bound) doc is still not a valid target.
    await assert.rejects(
      setWorkspaceLink({ documentId: joiner.id, targetDocumentId: plainDoc.id, userId: owner.id }),
      WorkspaceLinkError
    );
    const link = await setWorkspaceLink({
      documentId: joiner.id,
      targetDocumentId: mergedDoc.id,
      userId: owner.id
    });
    assert.equal(link?.id, mergedDoc.id);
    assert.equal(await resolveWorkspaceDocumentId(joiner.id), mergedDoc.id);
  } finally {
    await cleanup([joiner.id, plainDoc.id, mergedDoc.id], [owner.id]);
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
