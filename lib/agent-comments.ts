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

// Live mid-run comment delivery. The agent's add_comment tool routes here via
// the runner's onComment callback: each comment is persisted (and
// SSE-broadcast) immediately so collaborators see review feedback while the
// run is still working, and the growing {threadId, findText} list is
// snapshotted onto AiRun.agentComments so polling clients can anchor the
// comments incrementally. finalize() creates threads for any comments that
// arrived only in submit_response's comments array — deduped against the live
// ones, which also makes a retried attempt that re-leaves the same comments
// idempotent — and returns the complete list for the run record.
export function createLiveCommentRecorder(input: {
  documentId: string;
  aiRunId: string;
  createdById: string | null;
  model: string | null;
  documentText: string;
}) {
  const live: Array<{ threadId: string; findText: string }> = [];
  const seen = new Set<string>();
  const keyOf = (comment: AgentComment) => `${comment.findText}\u0000${comment.body}`;

  const persist = async (comment: AgentComment, model: string | null) => {
    const created = await createAgentCommentThreads({
      documentId: input.documentId,
      aiRunId: input.aiRunId,
      createdById: input.createdById,
      model,
      comments: [comment],
      documentText: input.documentText
    });
    live.push(...created);
  };

  return {
    onComment: async (comment: AgentComment) => {
      const key = keyOf(comment);
      if (seen.has(key)) return;
      seen.add(key);
      await persist(comment, input.model);
      await db.aiRun
        .update({ where: { id: input.aiRunId }, data: { agentComments: JSON.stringify(live) } })
        .catch(() => null);
    },
    finalize: async (submitted: AgentComment[] | undefined, model?: string | null) => {
      for (const comment of submitted ?? []) {
        const key = keyOf(comment);
        if (seen.has(key)) continue;
        seen.add(key);
        await persist(comment, model ?? input.model);
      }
      return live;
    }
  };
}
