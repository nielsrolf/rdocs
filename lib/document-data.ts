import { getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { parseSourceLinks, serializeSourceLinks } from "@/lib/sources";

const VERSION_SNAPSHOT_COOLDOWN_MS = 45_000;

export function serializeComment(comment: {
  id: string;
  body: string;
  aiModel: string | null;
  sourceLinks?: string | null;
  commitSha?: string | null;
  commitUrl?: string | null;
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
    createdAt: comment.createdAt,
    author: comment.author
  };
}

export function serializeThread(thread: {
  id: string;
  anchorText: string;
  anchorContext: string | null;
  fromPos: number | null;
  toPos: number | null;
  status: string;
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
    createdAt: Date;
    author: {
      id: string;
      name: string;
    } | null;
  }>;
}) {
  return {
    id: thread.id,
    anchorText: thread.anchorText,
    anchorContext: thread.anchorContext,
    fromPos: thread.fromPos,
    toPos: thread.toPos,
    status: thread.status,
    createdAt: thread.createdAt,
    createdBy: thread.createdBy,
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

export async function listDocumentThreads(documentId: string) {
  const threads = await db.commentThread.findMany({
    where: { documentId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      anchorText: true,
      anchorContext: true,
      fromPos: true,
      toPos: true,
      status: true,
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

  return threads.map(serializeThread);
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

  const latestVersion = await db.documentVersion.findFirst({
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
