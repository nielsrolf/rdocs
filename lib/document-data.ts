import { getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { aggregateReactions, type RawReaction } from "@/lib/reactions";
import { parseSourceLinks, serializeSourceLinks } from "@/lib/sources";

const VERSION_SNAPSHOT_COOLDOWN_MS = 45_000;
const DEFAULT_THREAD_TAGS = ["Resolved", "Footnote"];

export function normalizeThreadTags(tags: unknown) {
  if (!Array.isArray(tags)) {
    return [];
  }

  const seen = new Set<string>();
  return tags
    .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
    .filter((tag) => tag.length > 0 && tag.length <= 48)
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

export function parseThreadTags(tags: string | null | undefined, status?: string | null) {
  const parsed = (() => {
    if (!tags) {
      return [];
    }

    try {
      return normalizeThreadTags(JSON.parse(tags));
    } catch {
      return [];
    }
  })();

  if (status === "RESOLVED" && !parsed.some((tag) => tag.toLowerCase() === "resolved")) {
    return ["Resolved", ...parsed];
  }

  return parsed;
}

export function getDefaultThreadTags() {
  return DEFAULT_THREAD_TAGS;
}

export function serializeComment(
  comment: {
    id: string;
    body: string;
    aiModel: string | null;
    guestName?: string | null;
    sourceLinks?: string | null;
    commitSha?: string | null;
    commitUrl?: string | null;
    aiRunId?: string | null;
    createdAt: Date;
    author: {
      id: string;
      name: string;
    } | null;
    reactions?: RawReaction[];
  },
  options?: { currentUserId?: string | null }
) {
  return {
    id: comment.id,
    body: comment.body,
    aiModel: comment.aiModel,
    guestName: comment.guestName ?? null,
    sourceLinks: parseSourceLinks(comment.sourceLinks),
    commitSha: comment.commitSha ?? null,
    commitUrl: comment.commitUrl ?? null,
    aiRunId: comment.aiRunId ?? null,
    createdAt: comment.createdAt,
    author: comment.author,
    reactions: aggregateReactions(comment.reactions ?? [], options?.currentUserId ?? null)
  };
}

export function serializeThread(
  thread: {
    id: string;
    anchorText: string;
    anchorContext: string | null;
    status: string;
    tags?: string | null;
    createdAt: Date;
    createdBy: {
      id: string;
      name: string;
    } | null;
    comments: Array<{
      id: string;
      body: string;
      aiModel: string | null;
      guestName?: string | null;
      sourceLinks?: string | null;
      commitSha?: string | null;
      commitUrl?: string | null;
      aiRunId?: string | null;
      createdAt: Date;
      author: {
        id: string;
        name: string;
      } | null;
      reactions?: RawReaction[];
    }>;
  },
  options?: { lastReadAt?: Date | null; currentUserId?: string | null }
) {
  return {
    id: thread.id,
    anchorText: thread.anchorText,
    anchorContext: thread.anchorContext,
    status: thread.status,
    tags: parseThreadTags(thread.tags, thread.status),
    createdAt: thread.createdAt,
    createdBy: thread.createdBy,
    lastReadAt: options?.lastReadAt ?? null,
    comments: thread.comments.map((comment) =>
      serializeComment(comment, { currentUserId: options?.currentUserId ?? null })
    )
  };
}

export function serializeVersion(version: {
  id: string;
  title: string;
  content: string;
  sourceLinks: string | null;
  commitSha?: string | null;
  commitUrl?: string | null;
  createdAt: Date;
}) {
  const parsedContent = parseDocumentContent(version.content);

  return {
    id: version.id,
    title: version.title,
    content: parsedContent,
    plainText: getDocumentPlainText(parsedContent),
    sourceLinks: parseSourceLinks(version.sourceLinks),
    commitSha: version.commitSha ?? null,
    commitUrl: version.commitUrl ?? null,
    createdAt: version.createdAt
  };
}

export async function listDocumentThreads(documentId: string, userId?: string | null) {
  const threads = await db.commentThread.findMany({
    where: { documentId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      anchorText: true,
      anchorContext: true,
      status: true,
      tags: true,
      createdAt: true,
      createdBy: {
        select: {
          id: true,
          name: true
        }
      },
      comments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          body: true,
          aiModel: true,
          guestName: true,
          sourceLinks: true,
          commitSha: true,
          commitUrl: true,
          aiRunId: true,
          createdAt: true,
          author: {
            select: {
              id: true,
              name: true
            }
          },
          reactions: {
            select: { emoji: true, userId: true, user: { select: { name: true } } }
          }
        }
      }
    }
  });

  if (!userId) {
    return threads.map((thread) => serializeThread(thread, { currentUserId: null }));
  }

  const reads = await db.commentThreadRead.findMany({
    where: {
      userId,
      threadId: { in: threads.map((thread) => thread.id) }
    },
    select: { threadId: true, lastReadAt: true }
  });
  const lastReadByThread = new Map(reads.map((row) => [row.threadId, row.lastReadAt]));

  return threads.map((thread) =>
    serializeThread(thread, {
      lastReadAt: lastReadByThread.get(thread.id) ?? null,
      currentUserId: userId
    })
  );
}

// Per-document comment stats for the dashboard, aggregated in SQL instead of
// loading every comment across every document into JS. "unread" matches the
// dashboard rule: a comment in a non-resolved thread, not authored by the
// viewer, created after the viewer last read that thread. SQLite stores
// DateTime as integer epoch-ms, so the createdAt/lastReadAt comparison is a
// plain integer comparison.
export async function getDocumentCommentStats(userId: string, documentIds: string[]) {
  const unreadByDoc = new Map<string, number>();
  const lastCommentByDoc = new Map<string, Date>();
  if (documentIds.length === 0) {
    return { unreadByDoc, lastCommentByDoc };
  }

  const placeholders = documentIds.map(() => "?").join(", ");

  const unreadRows = await db.$queryRawUnsafe<Array<{ documentId: string; unreadCount: number | bigint }>>(
    `SELECT t.documentId AS documentId, COUNT(c.id) AS unreadCount
     FROM CommentThread t
     JOIN Comment c ON c.threadId = t.id
     LEFT JOIN CommentThreadRead r ON r.threadId = t.id AND r.userId = ?
     WHERE t.documentId IN (${placeholders})
       AND t.status <> 'RESOLVED'
       AND (c.authorId IS NULL OR c.authorId <> ?)
       AND c.createdAt > COALESCE(r.lastReadAt, 0)
     GROUP BY t.documentId`,
    userId,
    ...documentIds,
    userId
  );
  for (const row of unreadRows) {
    unreadByDoc.set(row.documentId, Number(row.unreadCount));
  }

  const lastRows = await db.$queryRawUnsafe<Array<{ documentId: string; lastCommentAt: number | bigint | null }>>(
    `SELECT t.documentId AS documentId, MAX(c.createdAt) AS lastCommentAt
     FROM CommentThread t
     JOIN Comment c ON c.threadId = t.id
     WHERE t.documentId IN (${placeholders})
     GROUP BY t.documentId`,
    ...documentIds
  );
  for (const row of lastRows) {
    if (row.lastCommentAt != null) {
      lastCommentByDoc.set(row.documentId, new Date(Number(row.lastCommentAt)));
    }
  }

  return { unreadByDoc, lastCommentByDoc };
}

export type AccessibleDocument = {
  id: string;
  title: string;
  kind: string;
  updatedAt: Date;
  isOwner: boolean;
  permission: string;
  owner: { id: string; name: string };
};

// The union of documents a user can reach: everything they own plus every
// document they were added to as a member. This is the same list the dashboard
// renders; extracted here so the cross-document comment view scopes to exactly
// the same set (no leakage of docs the user cannot see).
export async function listAccessibleDocumentsForUser(userId: string): Promise<AccessibleDocument[]> {
  const [ownedDocuments, memberships] = await Promise.all([
    db.document.findMany({
      where: { ownerId: userId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        kind: true,
        updatedAt: true,
        owner: { select: { id: true, name: true } }
      }
    }),
    db.documentMembership.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: {
        permission: true,
        document: {
          select: {
            id: true,
            title: true,
            kind: true,
            updatedAt: true,
            owner: { select: { id: true, name: true } }
          }
        }
      }
    })
  ]);

  const owned: AccessibleDocument[] = ownedDocuments.map((d) => ({
    id: d.id,
    title: d.title,
    kind: d.kind,
    updatedAt: d.updatedAt,
    isOwner: true,
    permission: "EDIT",
    owner: d.owner
  }));
  const shared: AccessibleDocument[] = memberships.map(({ document, permission }) => ({
    id: document.id,
    title: document.title,
    kind: document.kind,
    updatedAt: document.updatedAt,
    isOwner: false,
    permission,
    owner: document.owner
  }));

  return [...owned, ...shared];
}

export type InboxThread = ReturnType<typeof serializeThread> & {
  documentId: string;
  documentTitle: string;
};

// Every comment thread across the documents a user can access, annotated with
// its parent document, plus the distinct set of tags in play (for filter
// chips). Filtering by tag is done client-side because tags live as a
// JSON-string column, not a normalized table.
export async function listTaggedThreadsForUser(
  userId: string
): Promise<{ threads: InboxThread[]; tags: string[] }> {
  const documents = await listAccessibleDocumentsForUser(userId);
  const titleByDoc = new Map(documents.map((d) => [d.id, d.title]));
  const docIds = documents.map((d) => d.id);
  if (docIds.length === 0) {
    return { threads: [], tags: getDefaultThreadTags() };
  }

  const threads = await db.commentThread.findMany({
    where: { documentId: { in: docIds } },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      documentId: true,
      anchorText: true,
      anchorContext: true,
      status: true,
      tags: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          body: true,
          aiModel: true,
          guestName: true,
          sourceLinks: true,
          commitSha: true,
          commitUrl: true,
          aiRunId: true,
          createdAt: true,
          author: { select: { id: true, name: true } },
          reactions: {
            select: { emoji: true, userId: true, user: { select: { name: true } } }
          }
        }
      }
    }
  });

  const reads = await db.commentThreadRead.findMany({
    where: { userId, threadId: { in: threads.map((t) => t.id) } },
    select: { threadId: true, lastReadAt: true }
  });
  const lastReadByThread = new Map(reads.map((row) => [row.threadId, row.lastReadAt]));

  const tagUniverse = new Set(getDefaultThreadTags());
  const inboxThreads: InboxThread[] = threads.map((thread) => {
    const serialized = serializeThread(thread, {
      lastReadAt: lastReadByThread.get(thread.id) ?? null,
      currentUserId: userId
    });
    for (const tag of serialized.tags) {
      tagUniverse.add(tag);
    }
    return {
      ...serialized,
      documentId: thread.documentId,
      documentTitle: titleByDoc.get(thread.documentId) ?? "Untitled"
    };
  });

  return { threads: inboxThreads, tags: Array.from(tagUniverse) };
}

export async function listDocumentVersions(documentId: string) {
  const versions = await db.documentVersion.findMany({
    where: { documentId },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      title: true,
      content: true,
      sourceLinks: true,
      commitSha: true,
      commitUrl: true,
      createdAt: true
    }
  });

  return versions.map(serializeVersion);
}

export async function maybeCreateVersionSnapshot(input: {
  documentId: string;
  currentTitle: string;
  currentContent: string;
  nextTitle: string;
  nextContent: string;
  force?: boolean;
  sourceLinks?: string[];
  commitSha?: string | null;
  commitUrl?: string | null;
  aiRunId?: string | null;
}) {
  const titleChanged = input.currentTitle !== input.nextTitle;
  const contentChanged = input.currentContent !== input.nextContent;

  if (!titleChanged && !contentChanged) {
    return;
  }

  let latestVersion = await db.documentVersion.findFirst({
    where: {
      documentId: input.documentId
    },
    orderBy: {
      createdAt: "desc"
    },
    select: {
      createdAt: true,
      title: true,
      content: true
    }
  });

  // Always archive the previous remote state if it isn't already the latest
  // version. This is the safety net for overwrites and server-side rebases:
  // every unique pre-overwrite state stays recoverable from the version
  // history, regardless of cooldown.
  const previousIsArchived =
    !!latestVersion &&
    latestVersion.title === input.currentTitle &&
    latestVersion.content === input.currentContent;

  if (!previousIsArchived) {
    await db.documentVersion.create({
      data: {
        documentId: input.documentId,
        title: input.currentTitle,
        content: input.currentContent,
        sourceLinks: serializeSourceLinks([]),
        commitSha: null,
        commitUrl: null,
        aiRunId: null
      }
    });

    latestVersion = await db.documentVersion.findFirst({
      where: { documentId: input.documentId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, title: true, content: true }
    });
  }

  const withinCooldown =
    latestVersion &&
    Date.now() - latestVersion.createdAt.getTime() < VERSION_SNAPSHOT_COOLDOWN_MS;
  const snapshotMatchesLatest =
    latestVersion?.title === input.nextTitle && latestVersion?.content === input.nextContent;

  if (!input.force && (withinCooldown || snapshotMatchesLatest)) {
    return;
  }

  await db.documentVersion.create({
    data: {
      documentId: input.documentId,
      title: input.nextTitle,
      content: input.nextContent,
      sourceLinks: serializeSourceLinks(input.sourceLinks ?? []),
      commitSha: input.commitSha ?? null,
      commitUrl: input.commitUrl ?? null,
      aiRunId: input.aiRunId ?? null
    }
  });
}
