import { getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
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

export function serializeComment(comment: {
  id: string;
  body: string;
  aiModel: string | null;
  sourceLinks?: string | null;
  commitSha?: string | null;
  commitUrl?: string | null;
  aiRunId?: string | null;
  createdAt: Date;
  author: {
    id: string;
    name: string;
  } | null;
}) {
  return {
    id: comment.id,
    body: comment.body,
    aiModel: comment.aiModel,
    sourceLinks: parseSourceLinks(comment.sourceLinks),
    commitSha: comment.commitSha ?? null,
    commitUrl: comment.commitUrl ?? null,
    aiRunId: comment.aiRunId ?? null,
    createdAt: comment.createdAt,
    author: comment.author
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
    };
    comments: Array<{
      id: string;
      body: string;
      aiModel: string | null;
      sourceLinks?: string | null;
      commitSha?: string | null;
      commitUrl?: string | null;
      aiRunId?: string | null;
      createdAt: Date;
      author: {
        id: string;
        name: string;
      } | null;
    }>;
  },
  options?: { lastReadAt?: Date | null }
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
    comments: thread.comments.map(serializeComment)
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
          }
        }
      }
    }
  });

  if (!userId) {
    return threads.map((thread) => serializeThread(thread));
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
    serializeThread(thread, { lastReadAt: lastReadByThread.get(thread.id) ?? null })
  );
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
