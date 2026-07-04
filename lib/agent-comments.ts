import { broadcastDocumentEvent } from "@/lib/collaboration";
import { getContextAroundMatch } from "@/lib/content";
import { serializeThread } from "@/lib/document-data";
import { db } from "@/lib/db";
import type { AgentComment } from "@/agent-core/ai-edit-submission";

const THREAD_SELECT = {
  id: true,
  anchorText: true,
  anchorContext: true,
  status: true,
  tags: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  comments: {
    orderBy: { createdAt: "asc" as const },
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
      author: { select: { id: true, name: true } }
    }
  }
};

// Creates the comment threads an agent left during a run. Each thread's initial
// comment is AI-authored (aiModel set, no human author) and tied to the run. The
// thread is created WITHOUT a document anchor mark — the client adds the
// commentAnchor mark (via the collab step pipeline) when it processes the run,
// keeping the content invariant intact. Returns the {threadId, findText} pairs
// the client needs to resolve and anchor.
export async function createAgentCommentThreads(input: {
  documentId: string;
  aiRunId: string;
  // Null when the run was triggered by an anonymous share-link visitor.
  createdById: string | null;
  model: string | null;
  comments: AgentComment[];
  documentText: string;
}): Promise<Array<{ threadId: string; findText: string }>> {
  const created: Array<{ threadId: string; findText: string }> = [];

  for (const comment of input.comments) {
    const anchorText = comment.findText.slice(0, 1000);
    const anchorContext =
      getContextAroundMatch(input.documentText, comment.findText)?.slice(0, 2000) ?? null;

    try {
      const thread = await db.commentThread.create({
        data: {
          documentId: input.documentId,
          createdById: input.createdById,
          anchorText,
          anchorContext,
          comments: {
            create: {
              body: comment.body,
              aiModel: input.model,
              aiRunId: input.aiRunId
            }
          }
        },
        select: THREAD_SELECT
      });

      broadcastDocumentEvent(input.documentId, "thread-created", {
        thread: serializeThread(thread),
        updatedAt: null
      });

      created.push({ threadId: thread.id, findText: comment.findText });
    } catch (error) {
      console.error("[agent-comments] failed to create thread", {
        documentId: input.documentId,
        aiRunId: input.aiRunId,
        error: error instanceof Error ? error.message : error
      });
    }
  }

  return created;
}
