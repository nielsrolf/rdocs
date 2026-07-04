import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAiRunEvent, serializeAiRun } from "@/lib/ai-runs";
import { getAgentRunner } from "@/lib/agent-runner";
import { getCurrentUser } from "@/lib/auth";
import { getDocumentAiBlocks, getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { loadDocumentEnv } from "@/lib/document-env";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeAgentImages } from "@/lib/ai-edit-submission";
import { createAgentCommentThreads } from "@/lib/agent-comments";
import { flattenDocumentTextNodes } from "@/lib/suggestion-content";
import {
  commitWorkspaceChanges,
  ensureLinkedRepositoryWorktree,
  getWorkspaceOverview,
  removeRunWorktree
} from "@/lib/research-workspace";

export const runtime = "nodejs";

const agentConversationSchema = z.object({
  message: z.string().min(1).max(6000),
  shareToken: z.string().optional().nullable(),
  previousRunId: z.string().optional().nullable()
});

const CONVERSATION_HISTORY_ROLES = new Set(["user", "agent"]);
const MAX_CONVERSATION_TURNS = 24;

async function buildConversationHistory(documentId: string, previousRunId: string | null) {
  if (!previousRunId) {
    return { history: [] as Array<{ role: string; message: string }>, rootRunId: null as string | null };
  }
  const chain: Array<{ id: string; parentRunId: string | null }> = [];
  let cursorId: string | null = previousRunId;
  const visited = new Set<string>();
  while (cursorId && !visited.has(cursorId) && chain.length < MAX_CONVERSATION_TURNS) {
    visited.add(cursorId);
    const run: { id: string; parentRunId: string | null; documentId: string } | null = await db.aiRun.findUnique({
      where: { id: cursorId },
      select: { id: true, parentRunId: true, documentId: true }
    });
    if (!run || run.documentId !== documentId) {
      break;
    }
    chain.push({ id: run.id, parentRunId: run.parentRunId });
    cursorId = run.parentRunId;
  }
  if (chain.length === 0) {
    return { history: [], rootRunId: null };
  }
  chain.reverse();
  const events = await db.aiRunEvent.findMany({
    where: { aiRunId: { in: chain.map((entry) => entry.id) } },
    orderBy: { createdAt: "asc" },
    select: { role: true, message: true }
  });
  const history = events.filter((event) => CONVERSATION_HISTORY_ROLES.has(event.role));
  return { history, rootRunId: chain[0]?.id ?? null };
}

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// Runs the document-level conversation agent off the request path. The HTTP
// handler returns 202 immediately; the client tracks the run (progress, the
// agent reply event, terminal status) via AiRun polling. This avoids the
// Cloudflare ~100s origin timeout (524) on long synchronous conversations.
async function runAgentConversationInBackground(input: {
  documentId: string;
  aiRunId: string;
  message: string;
  previousRunId: string | null;
  documentTitle: string;
  documentContent: string;
  createdById: string;
  agentConfig: { model: string | null; effort: string | null };
}) {
  const { documentId, aiRunId, message, previousRunId, documentTitle, documentContent, createdById, agentConfig } =
    input;
  let linkedRepo: Awaited<ReturnType<typeof ensureLinkedRepositoryWorktree>> = null;

  try {
    const { history: conversationHistory } = await buildConversationHistory(documentId, previousRunId);

    linkedRepo = await ensureLinkedRepositoryWorktree(documentId, aiRunId);
    if (linkedRepo) {
      await db.aiRun.update({
        where: { id: aiRunId },
        data: {
          workspacePath: linkedRepo.workspace,
          branchName: linkedRepo.branchName
        }
      });
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: `Using isolated worktree ${linkedRepo.workspace} on branch ${linkedRepo.branchName}.`
      });
    }

    const parsedContent = parseDocumentContent(documentContent);
    const documentText = getDocumentPlainText(parsedContent);
    const suggestionAnchorText = flattenDocumentTextNodes(parsedContent);
    const documentBlocks = getDocumentAiBlocks(parsedContent);
    const unresolvedThreads = await db.commentThread.findMany({
      where: {
        documentId,
        status: "OPEN"
      },
      orderBy: {
        updatedAt: "desc"
      },
      select: {
        id: true,
        anchorText: true,
        anchorContext: true,
        comments: {
          orderBy: { createdAt: "asc" },
          select: {
            body: true,
            author: { select: { name: true } },
            aiModel: true
          }
        }
      }
    });
    const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null, documentId);
    const agentEnv = await loadDocumentEnv(documentId);
    const result = await getAgentRunner().run({
      mode: "conversation",
      documentTitle,
      documentText,
      documentBlocks,
      unresolvedThreads: unresolvedThreads.map((thread) => ({
        id: thread.id,
        anchorText: thread.anchorText,
        anchorContext: thread.anchorContext,
        comments: thread.comments.map((comment) => ({
          author: comment.author?.name ?? comment.aiModel ?? "Claude",
          body: comment.body
        }))
      })),
      workspacePath: linkedRepo?.workspace ?? null,
      workspaceOverview,
      instruction: message,
      conversationHistory
    }, {
      agentConfig: { model: agentConfig.model, effort: agentConfig.effort },
      agentEnv,
      validation: { kind: "conversation", documentText: suggestionAnchorText },
      onProgress: async (event) => {
        await Promise.all([
          db.aiRun.update({
            where: { id: aiRunId },
            data: { progress: event.message }
          }),
          recordAiRunEvent({
            aiRunId,
            role: event.role ?? "agent",
            message: event.message
          })
        ]).catch(() => null);
      }
    });

    const commit = linkedRepo
      ? await commitWorkspaceChanges({
          workspace: linkedRepo.workspace,
          baseWorkspace: linkedRepo.baseWorkspace,
          repoUrl: linkedRepo.url,
          message: "AI research conversation changes",
          push: true
        })
      : { commitSha: null, commitUrl: null, pushed: false };
    if (commit.pushError) {
      await recordAiRunEvent({
        aiRunId,
        role: "error",
        message: `Changes were committed locally but could not be pushed to the linked repository: ${commit.pushError}`
      }).catch(() => null);
    }

    await recordAiRunEvent({
      aiRunId,
      role: "agent",
      message: result.reply ?? result.summary ?? "Finished agent conversation."
    });

    const agentComments = await createAgentCommentThreads({
      documentId,
      aiRunId,
      createdById,
      model: result.model,
      comments: Array.isArray(result.comments) ? result.comments : [],
      documentText
    });

    await db.aiRun.update({
      where: { id: aiRunId },
      data: {
        status: "SUCCEEDED",
        progress: result.summary ?? "Finished.",
        model: result.model,
        commitSha: commit.commitSha,
        commitUrl: commit.commitUrl,
        finishedAt: new Date(),
        suggestions: JSON.stringify(Array.isArray(result.suggestions) ? result.suggestions : []),
        agentComments: JSON.stringify(agentComments),
        replacementImages: JSON.stringify(normalizeAgentImages(result.images, documentId, null, aiRunId))
      }
    });
  } catch (error) {
    if (linkedRepo) {
      await commitWorkspaceChanges({
        workspace: linkedRepo.workspace,
        baseWorkspace: linkedRepo.baseWorkspace,
        repoUrl: linkedRepo.url,
        message: "Save failed AI conversation changes",
        push: true
      }).catch(() => null);
    }

    await recordAiRunEvent({
      aiRunId,
      role: "error",
      message: error instanceof Error ? error.message : "Agent conversation failed."
    }).catch(() => null);
    await db.aiRun
      .update({
        where: { id: aiRunId },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "Agent conversation failed.",
          finishedAt: new Date()
        }
      })
      .catch(() => null);
  } finally {
    if (linkedRepo && linkedRepo.baseWorkspace !== linkedRepo.worktree) {
      await removeRunWorktree(linkedRepo).catch(() => null);
    }
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to message an agent." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = agentConversationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid agent message payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have agent access." }, { status: 403 });
  }

  // Agent runs are expensive; cap how many a single user can kick off per minute.
  const runLimit = rateLimit(`ai-run:user:${user.id}`, 10, 60_000);
  if (!runLimit.allowed) {
    return NextResponse.json(
      { error: "You're messaging the agent too quickly. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(runLimit.retryAfterSeconds) } }
    );
  }

  const aiRun = await db.aiRun.create({
    data: {
      documentId: id,
      triggerType: parsed.data.previousRunId ? "CONVERSATION_FOLLOWUP" : "CONVERSATION",
      parentRunId: parsed.data.previousRunId ?? null,
      instruction: parsed.data.message.trim(),
      progress: "Starting Claude research agent.",
      // Conversation runs only ever propose suggestions, never commit content.
      suggestOnly: true
    }
  });
  await recordAiRunEvent({
    aiRunId: aiRun.id,
    role: "user",
    message: parsed.data.message.trim()
  });

  // Kick the agent off in the background and return immediately; the client
  // tracks the run via polling.
  void runAgentConversationInBackground({
    documentId: id,
    aiRunId: aiRun.id,
    message: parsed.data.message.trim(),
    previousRunId: parsed.data.previousRunId ?? null,
    documentTitle: access.document.title,
    documentContent: access.document.content,
    createdById: user.id,
    agentConfig: { model: access.document.agentModel, effort: access.document.agentEffort }
  }).catch((error) => {
    console.error("[agents] background run threw", {
      documentId: id,
      aiRunId: aiRun.id,
      error: error instanceof Error ? error.message : error
    });
  });

  const created = await db.aiRun.findUnique({
    where: { id: aiRun.id },
    include: { events: { orderBy: { createdAt: "asc" } } }
  });

  return NextResponse.json(
    { aiRun: created ? serializeAiRun(created) : { id: aiRun.id, status: aiRun.status } },
    { status: 202 }
  );
}
