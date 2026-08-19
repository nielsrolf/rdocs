import { db } from "@/lib/db";
import { listAccessibleDocumentsForUser } from "@/lib/document-data";
import { getDocumentPlainText, parseDocumentContent } from "@/lib/content";

export type ForumDocumentSummary = {
  id: string;
  title: string;
  postedAt: Date;
  updatedAt: Date;
  owner: { id: string; name: string };
  permission: string;
  isOwner: boolean;
  score: number;
  ownVote: number;
  commentCount: number;
};

// LessWrong-style hotness: score decayed by age. Pure so the frontpage can
// re-rank without another query.
export function forumHotness(score: number, postedAt: Date, now: Date = new Date()): number {
  const ageHours = Math.max(0, (now.getTime() - postedAt.getTime()) / 36e5);
  return (score + 1) / Math.pow(ageHours + 2, 1.3);
}

// All documents the user can access (same gate as the dashboard) that carry
// the "posted to forum" flag, PLUS every public forum post (forumPublic —
// readable by anyone, so it is listed for anyone, including logged-out
// visitors when userId is null). Non-public posting never widens access.
export async function listForumDocumentsForUser(
  userId: string | null
): Promise<ForumDocumentSummary[]> {
  const accessible = userId ? await listAccessibleDocumentsForUser(userId) : [];
  // Quicktakes are forum documents too, but they live in their own section —
  // keep them out of the main post list.
  const candidateIds = accessible
    .filter((d) => d.kind !== "slack_channel" && d.kind !== "quicktake")
    .map((d) => d.id);

  const posted = await db.document.findMany({
    where: {
      forumPostedAt: { not: null },
      NOT: { kind: { in: ["slack_channel", "quicktake"] } },
      OR: [{ id: { in: candidateIds } }, { forumPublic: true }]
    },
    select: {
      id: true,
      title: true,
      forumPostedAt: true,
      updatedAt: true,
      owner: { select: { id: true, name: true } }
    }
  });
  if (posted.length === 0) return [];
  const postedIds = posted.map((d) => d.id);

  const [votes, commentCounts] = await Promise.all([
    db.documentVote.findMany({
      where: { documentId: { in: postedIds } },
      select: { documentId: true, userId: true, value: true }
    }),
    db.comment.groupBy({
      by: ["threadId"],
      where: { thread: { documentId: { in: postedIds } } },
      _count: { _all: true }
    }).then(async (rows) => {
      const threads = await db.commentThread.findMany({
        where: { documentId: { in: postedIds } },
        select: { id: true, documentId: true }
      });
      const docByThread = new Map(threads.map((t) => [t.id, t.documentId]));
      const counts = new Map<string, number>();
      for (const row of rows) {
        const docId = docByThread.get(row.threadId);
        if (!docId) continue;
        counts.set(docId, (counts.get(docId) ?? 0) + row._count._all);
      }
      return counts;
    })
  ]);

  const scoreByDoc = new Map<string, number>();
  const ownVoteByDoc = new Map<string, number>();
  for (const vote of votes) {
    scoreByDoc.set(vote.documentId, (scoreByDoc.get(vote.documentId) ?? 0) + vote.value);
    if (vote.userId === userId) ownVoteByDoc.set(vote.documentId, vote.value);
  }

  const accessById = new Map(accessible.map((d) => [d.id, d]));
  const summaries: ForumDocumentSummary[] = posted.map((doc) => ({
    id: doc.id,
    title: doc.title,
    postedAt: doc.forumPostedAt as Date,
    updatedAt: doc.updatedAt,
    owner: doc.owner,
    permission: accessById.get(doc.id)?.permission ?? "VIEW",
    isOwner: accessById.get(doc.id)?.isOwner ?? false,
    score: scoreByDoc.get(doc.id) ?? 0,
    ownVote: ownVoteByDoc.get(doc.id) ?? 0,
    commentCount: commentCounts.get(doc.id) ?? 0
  }));

  return summaries.sort(
    (a, b) => forumHotness(b.score, b.postedAt) - forumHotness(a.score, a.postedAt)
  );
}

export type ForumComment = {
  id: string;
  threadId: string;
  parentId: string | null;
  body: string;
  authorName: string;
  authorId: string | null;
  isAi: boolean;
  createdAt: Date;
  score: number;
  ownVote: number;
  // For comments imported from the studio view: the anchored document text
  // they were attached to, rendered as a "> quote" prefix in the forum.
  anchorQuote: string | null;
  replies: ForumComment[];
};

// Loads every comment thread of a document and folds it into the forum tree:
// - forum-origin threads: their root comment is a top-level forum comment,
//   nested replies follow `parentId`.
// - studio-origin threads: the first comment becomes a top-level forum comment
//   carrying the anchor quote; subsequent flat thread replies nest under it
//   (or under their explicit parentId when set).
export async function listForumComments(documentId: string, userId: string | null): Promise<ForumComment[]> {
  const threads = await db.commentThread.findMany({
    where: { documentId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      origin: true,
      anchorText: true,
      createdAt: true,
      comments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          parentId: true,
          body: true,
          guestName: true,
          aiModel: true,
          authorId: true,
          createdAt: true,
          author: { select: { id: true, name: true } },
          votes: { select: { userId: true, value: true } }
        }
      }
    }
  });

  const roots: ForumComment[] = [];
  for (const thread of threads) {
    if (thread.comments.length === 0) continue;
    const nodes = new Map<string, ForumComment>();
    for (const comment of thread.comments) {
      const score = comment.votes.reduce((sum, v) => sum + v.value, 0);
      const ownVote = userId
        ? comment.votes.find((v) => v.userId === userId)?.value ?? 0
        : 0;
      nodes.set(comment.id, {
        id: comment.id,
        threadId: thread.id,
        parentId: comment.parentId,
        body: comment.body,
        authorName: comment.author?.name ?? comment.guestName ?? (comment.aiModel ? "Claude" : "Unknown"),
        authorId: comment.authorId,
        isAi: Boolean(comment.aiModel),
        createdAt: comment.createdAt,
        score,
        ownVote,
        anchorQuote: null,
        replies: []
      });
    }

    const first = thread.comments[0];
    const rootNode = nodes.get(first.id)!;
    if (thread.origin !== "forum" && thread.anchorText.trim().length > 0) {
      rootNode.anchorQuote = thread.anchorText;
    }
    roots.push(rootNode);

    for (const comment of thread.comments.slice(1)) {
      const node = nodes.get(comment.id)!;
      const parent = (comment.parentId && nodes.get(comment.parentId)) || rootNode;
      if (parent === node) {
        roots.push(node);
        continue;
      }
      parent.replies.push(node);
    }
  }

  return roots;
}

// Plain-text preview of a document body for the forum frontpage cards.
export function forumExcerpt(content: string, maxLength = 280): string {
  try {
    const text = getDocumentPlainText(parseDocumentContent(content)).replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  } catch {
    return "";
  }
}
