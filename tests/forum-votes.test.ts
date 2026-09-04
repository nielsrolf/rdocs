import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { replaceCommentBody, type ForumCommentView } from "../components/forum/forum-comments";
import { nextKarmaVote } from "../components/forum/vote-widget";
import { db } from "../lib/db";
import { listForumComments } from "../lib/forum-data";
import {
  castCommentVote,
  castDocumentVote,
  documentVoteTally,
  isAllowedVoteValue,
  STRONG_VOTE_WEIGHT,
  tallyVotes,
  tallyVotesByTarget
} from "../lib/forum-votes";
import { createQuicktake, getQuicktake, listQuicktakes, updateQuicktake } from "../lib/quicktakes";

// Forum votes have two independent axes (LessWrong-style): "karma" is the
// general ▲▼ vote that ranks the feed, "agreement" is ✓/✗. One user holds at
// most one vote per axis per target; the axes never mix.

async function makeUser(tag: string) {
  return db.user.create({
    data: { email: `fv-${tag}-${crypto.randomUUID()}@example.com`, name: tag, passwordHash: "x" }
  });
}

test("tallyVotes keeps karma and agreement apart and reports the viewer's own votes", () => {
  const votes = [
    { userId: "a", kind: "karma", value: 1 },
    { userId: "b", kind: "karma", value: 1 },
    { userId: "c", kind: "karma", value: -1 },
    { userId: "a", kind: "agreement", value: -1 },
    { userId: "b", kind: "agreement", value: -1 },
    { userId: "z", kind: "something-else", value: 5 }
  ];
  assert.deepEqual(tallyVotes(votes, "a"), { score: 1, ownVote: 1, agreement: -2, ownAgreement: -1 });
  assert.deepEqual(tallyVotes(votes, "b"), { score: 1, ownVote: 1, agreement: -2, ownAgreement: -1 });
  assert.deepEqual(tallyVotes(votes, "c"), { score: 1, ownVote: -1, agreement: -2, ownAgreement: 0 });
  assert.deepEqual(tallyVotes(votes, null), { score: 1, ownVote: 0, agreement: -2, ownAgreement: 0 });

  const byTarget = tallyVotesByTarget(
    [
      { documentId: "d1", userId: "a", kind: "karma", value: 1 },
      { documentId: "d2", userId: "a", kind: "agreement", value: 1 }
    ],
    (v) => v.documentId,
    "a"
  );
  assert.deepEqual(byTarget.get("d1"), { score: 1, ownVote: 1, agreement: 0, ownAgreement: 0 });
  assert.deepEqual(byTarget.get("d2"), { score: 0, ownVote: 0, agreement: 1, ownAgreement: 1 });
});

test("a user can upvote AND disagree with the same quicktake; each axis toggles independently", async () => {
  const owner = await makeUser("owner");
  const voter = await makeUser("voter");
  const take = await createQuicktake(owner.id, "Strong opinion, loosely held.");
  try {
    let tally = await castDocumentVote(take.id, voter.id, "karma", 1);
    assert.deepEqual(tally, { score: 1, ownVote: 1, agreement: 0, ownAgreement: 0 });

    tally = await castDocumentVote(take.id, voter.id, "agreement", -1);
    assert.deepEqual(tally, { score: 1, ownVote: 1, agreement: -1, ownAgreement: -1 });

    // Both surfaces read the same tally.
    const listed = (await listQuicktakes(voter.id)).find((t) => t.id === take.id);
    assert.ok(listed);
    assert.equal(listed.score, 1);
    assert.equal(listed.agreement, -1);
    assert.equal(listed.ownAgreement, -1);
    const single = await getQuicktake(take.id, owner.id);
    assert.equal(single?.agreement, -1);
    assert.equal(single?.ownAgreement, 0);

    // Clearing agreement leaves karma untouched; flipping karma leaves agreement.
    tally = await castDocumentVote(take.id, voter.id, "agreement", 0);
    assert.deepEqual(tally, { score: 1, ownVote: 1, agreement: 0, ownAgreement: 0 });
    tally = await castDocumentVote(take.id, voter.id, "karma", -1);
    assert.equal(tally.score, -1);
    assert.equal((await documentVoteTally(take.id, null)).ownVote, 0);
  } finally {
    await db.document.deleteMany({ where: { id: take.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, voter.id] } } });
  }
});

test("comment votes carry both axes and canEdit marks only the viewer's own comments", async () => {
  const owner = await makeUser("owner");
  const other = await makeUser("other");
  const take = await createQuicktake(owner.id, "Comment on this.");
  try {
    const thread = await db.commentThread.create({
      data: {
        documentId: take.id,
        anchorText: "",
        origin: "forum",
        createdById: owner.id,
        comments: { create: { body: "First!", authorId: owner.id } }
      },
      select: { comments: { select: { id: true } } }
    });
    const commentId = thread.comments[0].id;
    await castCommentVote(commentId, other.id, "karma", 1);
    const tally = await castCommentVote(commentId, other.id, "agreement", 1);
    assert.deepEqual(tally, { score: 1, ownVote: 1, agreement: 1, ownAgreement: 1 });

    const asOther = await listForumComments(take.id, other.id);
    assert.equal(asOther[0].agreement, 1);
    assert.equal(asOther[0].ownAgreement, 1);
    assert.equal(asOther[0].canEdit, false);
    const asOwner = await listForumComments(take.id, owner.id);
    assert.equal(asOwner[0].canEdit, true);
    assert.equal(asOwner[0].ownAgreement, 0);
    const anonymous = await listForumComments(take.id, null);
    assert.equal(anonymous[0].canEdit, false);
  } finally {
    await db.document.deleteMany({ where: { id: take.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }
});

test("updateQuicktake is owner-only and refreshes body + derived title", async () => {
  const owner = await makeUser("owner");
  const other = await makeUser("other");
  const take = await createQuicktake(owner.id, "Original text");
  try {
    assert.equal(await updateQuicktake(other.id, take.id, "Hijacked"), null);
    const updated = await updateQuicktake(owner.id, take.id, "  Revised text  ");
    assert.equal(updated?.body, "Revised text");
    const row = await db.document.findUnique({ where: { id: take.id }, select: { title: true, quicktakeBody: true } });
    assert.equal(row?.quicktakeBody, "Revised text");
    assert.match(row?.title ?? "", /Revised text/);
    await assert.rejects(() => updateQuicktake(owner.id, take.id, "   "));
  } finally {
    await db.document.deleteMany({ where: { id: take.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }
});

test("replaceCommentBody edits a nested comment in place", () => {
  const leaf = (id: string, body: string): ForumCommentView => ({
    id,
    threadId: "t",
    parentId: null,
    body,
    authorName: "x",
    authorId: "u",
    isAi: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    canEdit: true,
    anchorQuote: null,
    replies: [],
    score: 0,
    ownVote: 0,
    agreement: 0,
    ownAgreement: 0
  });
  const tree = [{ ...leaf("a", "A"), replies: [leaf("b", "B")] }, leaf("c", "C")];
  const next = replaceCommentBody(tree, "b", "B2");
  assert.equal(next[0].replies[0].body, "B2");
  assert.equal(next[0].body, "A");
  assert.equal(next[1].body, "C");
});

test("strong votes exist only on the karma axis and weigh STRONG_VOTE_WEIGHT", async () => {
  assert.equal(isAllowedVoteValue("karma", STRONG_VOTE_WEIGHT), true);
  assert.equal(isAllowedVoteValue("karma", -STRONG_VOTE_WEIGHT), true);
  assert.equal(isAllowedVoteValue("karma", 2), false);
  assert.equal(isAllowedVoteValue("agreement", STRONG_VOTE_WEIGHT), false);
  assert.equal(isAllowedVoteValue("agreement", 1), true);

  const owner = await makeUser("owner");
  const voter = await makeUser("voter");
  const other = await makeUser("other");
  const take = await createQuicktake(owner.id, "Hold to strong-upvote.");
  try {
    await castDocumentVote(take.id, other.id, "karma", 1);
    let tally = await castDocumentVote(take.id, voter.id, "karma", STRONG_VOTE_WEIGHT);
    assert.equal(tally.score, 1 + STRONG_VOTE_WEIGHT);
    assert.equal(tally.ownVote, STRONG_VOTE_WEIGHT);

    // Downgrading to a normal vote replaces, never stacks.
    tally = await castDocumentVote(take.id, voter.id, "karma", 1);
    assert.equal(tally.score, 2);
    assert.equal(tally.ownVote, 1);

    await assert.rejects(() => castDocumentVote(take.id, voter.id, "agreement", STRONG_VOTE_WEIGHT), RangeError);
    await assert.rejects(() => castDocumentVote(take.id, voter.id, "karma", 2), RangeError);
    assert.equal((await documentVoteTally(take.id, voter.id)).agreement, 0);
  } finally {
    await db.document.deleteMany({ where: { id: take.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, voter.id, other.id] } } });
  }
});

test("karma button: tap toggles a normal vote, hold toggles a strong vote", () => {
  const S = STRONG_VOTE_WEIGHT;
  assert.equal(nextKarmaVote(0, 1, false), 1);
  assert.equal(nextKarmaVote(1, 1, false), 0);
  assert.equal(nextKarmaVote(0, 1, true), S);
  assert.equal(nextKarmaVote(S, 1, true), 0);
  // Tap while strong-voted drops to a normal vote; hold while normal-voted upgrades.
  assert.equal(nextKarmaVote(S, 1, false), 1);
  assert.equal(nextKarmaVote(1, 1, true), S);
  // Opposite direction always switches.
  assert.equal(nextKarmaVote(S, -1, false), -1);
  assert.equal(nextKarmaVote(-1, 1, true), S);
});
