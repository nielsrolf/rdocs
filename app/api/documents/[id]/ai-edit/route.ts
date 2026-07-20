import { NextResponse } from "next/server";
import { z } from "zod";

import { getDocumentAiBlocks, getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { getCurrentUser } from "@/lib/auth";
import { buildConversationHistory, markAiRunSucceeded, recordAiRunEvent, startAiRunHeartbeat } from "@/lib/ai-runs";
import {
  RUN_CANCELLED_MESSAGE,
  deregisterRunAbortController,
  isRunCancellation,
  registerRunAbortController
} from "@/lib/agent-runner/run-registry";
import { buildAndVerifyWidget } from "@/agent-core";
import { getAgentRunner, getSelfHostedRunner } from "@/lib/agent-runner";
import { detectEditAssetIntent } from "@/lib/ai-asset-intent";
import {
  embedSourceExists,
  hasMarkdownImage,
  normalizeAgentImages,
  normalizeSubmittedWidget
} from "@/lib/ai-edit-submission";
import { db } from "@/lib/db";
import { loadAgentEnvWithFreeFallback, restrictAgentEnvForReadOnly } from "@/lib/user-credentials";
import { agentAccessModeForDocumentAccess, canComment, canEdit, resolveDocumentAccess } from "@/lib/permissions";
import type { AgentAccessMode } from "@/agent-core";
import { createLiveCommentRecorder } from "@/lib/agent-comments";
import { flattenDocumentTextNodes } from "@/lib/suggestion-content";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import {
  commitWorkspaceChanges,
  ensureLinkedRepositoryWorktree,
  getWorkspaceOverview,
  removeRunWorktree
} from "@/lib/research-workspace";
import { normalizeSourceLinks } from "@/lib/sources";

const aiEditSchema = z
  .object({
    selectedText: z.string().max(200000),
    selectedMarkdown: z.string().max(400000).optional().nullable(),
    selectedContext: z.string().max(50000).optional().nullable(),
    instruction: z.string().min(1).max(4000),
    selectionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/).optional().nullable(),
    shareToken: z.string().optional().nullable(),
    // Set by comment-access users: the selection edit and any out-of-selection
    // edits are applied as tracked-change suggestions instead of committed content.
    suggest: z.boolean().optional(),
    // Session continuation: a follow-up message into an existing edit session.
    // The new run threads under this parent (same conversation in the agent
    // view) and the agent gets the prior attempts' transcript as history.
    parentRunId: z.string().min(1).max(60).optional().nullable()
  })
  .superRefine((data, ctx) => {
    // A fresh edit needs a real selection; a continuation may have lost its
    // anchor (the previous attempt failed and the marker is gone) and still be
    // worth running — the agent has the session history to work from.
    if (!data.parentRunId && data.selectedText.length < 1) {
      ctx.addIssue({
        code: "custom",
        message: "selectedText is required unless this is a session continuation (parentRunId).",
        path: ["selectedText"]
      });
    }
  });

async function createAgentWidgets(input: {
  widgets: unknown;
  documentId: string;
  workspace: string | null;
  aiRunId: string | null;
  // When the agent ran in the container runner, widgets were already built and
  // verified IN-SANDBOX during submission validation. Re-building here would run
  // untrusted code on the host, so we only confirm the embed_source exists.
  verifyOnly: boolean;
}) {
  if (!Array.isArray(input.widgets)) {
    return { created: [] as Array<Record<string, unknown>>, buildErrors: [] as string[] };
  }

  const created: Array<Record<string, unknown>> = [];
  const buildErrors: string[] = [];
  for (const widget of input.widgets) {
    const normalized = normalizeSubmittedWidget(widget);
    if (!normalized) continue;
    const { label, buildCmd, embedSource } = normalized;

    let lastError: string | null = null;
    let lastBuiltAt: Date | null = null;
    if (input.workspace) {
      let result: { ok: true; lastBuiltAt: Date } | { ok: false; error: string };
      if (input.verifyOnly) {
        const exists = await embedSourceExists(input.workspace, embedSource);
        result = exists
          ? { ok: true, lastBuiltAt: new Date() }
          : { ok: false, error: `embed_source "${embedSource}" was not found in the workspace.` };
      } else {
        result = await buildAndVerifyWidget(normalized, input.workspace);
      }
      if (!result.ok) {
        lastError = result.error.slice(0, 6000);
        buildErrors.push(`Widget "${label}" failed to build: ${lastError}`);
      } else {
        lastBuiltAt = result.lastBuiltAt;
      }
    }

    const record = await db.embeddedWidget.create({
      data: {
        documentId: input.documentId,
        label,
        buildCmd,
        embedSource,
        createdByRunId: input.aiRunId,
        workspacePath: input.workspace,
        lastBuiltAt,
        lastError
      }
    });

    created.push({
      id: record.id,
      label: record.label,
      buildCmd: record.buildCmd,
      embedSource: record.embedSource,
      lastError: record.lastError,
      src: `/api/documents/${input.documentId}/widgets/${record.id}/source`
    });
  }

  return { created, buildErrors };
}

type AiEditPayload = z.infer<typeof aiEditSchema>;

async function runAiEditInBackground(input: {
  documentId: string;
  aiRunId: string;
  parsed: AiEditPayload;
  documentTitle: string;
  documentContentRaw: string;
  createdById: string | null;
  agentConfig: { model: string | null; effort: string | null };
  agentAccessMode: AgentAccessMode;
  runnerMode: string;
}) {
  const { documentId, aiRunId, parsed, documentTitle, documentContentRaw, createdById, agentConfig, agentAccessMode, runnerMode } = input;
  // selfHosted documents: the app never manages a repo/worktree for these —
  // the owner's external worker clones and works in its own checkout. Leaving
  // linkedRepo null skips ensureLinkedRepositoryWorktree AND every
  // commit/cleanup step below that is already gated on `linkedRepo` being set.
  const isSelfHosted = runnerMode === "selfHosted";
  const runner = isSelfHosted ? getSelfHostedRunner() : getAgentRunner();
  let linkedRepo: Awaited<ReturnType<typeof ensureLinkedRepositoryWorktree>> = null;
  const stopHeartbeat = startAiRunHeartbeat(aiRunId);
  const abort = registerRunAbortController(aiRunId);
  try {
    const documentContent = parseDocumentContent(documentContentRaw);
    const documentText = getDocumentPlainText(documentContent);
    const suggestionAnchorText = flattenDocumentTextNodes(documentContent);
    const documentBlocks = getDocumentAiBlocks(documentContent);
    const unresolvedThreads = await db.commentThread.findMany({
      where: { documentId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        anchorText: true,
        anchorContext: true,
        comments: {
          orderBy: { createdAt: "asc" },
          select: { body: true, author: { select: { name: true } }, aiModel: true }
        }
      }
    });

    linkedRepo = isSelfHosted
      ? null
      : await ensureLinkedRepositoryWorktree(documentId, aiRunId, createdById);
    if (linkedRepo) {
      await db.aiRun.update({
        where: { id: aiRunId },
        data: { workspacePath: linkedRepo.workspace, branchName: linkedRepo.branchName }
      });
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: `Using isolated worktree ${linkedRepo.workspace} on branch ${linkedRepo.branchName}.`
      });
    }
    const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null, documentId);
    const assetIntent = detectEditAssetIntent(parsed.instruction);
    const {
      agentEnv,
      agentConfig: effectiveAgentConfig,
      usedFreeFallback
    } = await loadAgentEnvWithFreeFallback(documentId, agentConfig, createdById);
    if (usedFreeFallback) {
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: `No AI credential connected — running on the free local model (${effectiveAgentConfig.model}). It is much slower than Claude (first output can take a few minutes). Connect a credential under AI credentials in the topbar to use Claude.`
      });
    }
    if (agentAccessMode === "read_only") {
      await recordAiRunEvent({
        aiRunId,
        role: "system",
        message: "Share-link agent is read-only: repository writes, commands, document secrets, commits, and pushes are disabled."
      });
    }
    // Session continuation: give the agent the prior attempts' transcript so it
    // can pick up where the previous (failed/cancelled) attempt left off. The
    // prior attempt's committed work is already merged into the base checkout,
    // so this run's fresh worktree contains it.
    const { history: conversationHistory } = parsed.parentRunId
      ? await buildConversationHistory(documentId, parsed.parentRunId)
      : { history: [] };

    // Comments the agent leaves via add_comment are created (and broadcast)
    // the moment they arrive, so collaborators see review feedback mid-run.
    // Anonymous share-link runs never created agent comments before; keep that.
    const commentRecorder = createdById
      ? createLiveCommentRecorder({
          documentId,
          aiRunId,
          createdById,
          model: effectiveAgentConfig.model ?? null,
          documentText
        })
      : null;

    const result = await runner.run(
      {
        mode: "edit_selection",
        accessMode: agentAccessMode,
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
        selectedText: parsed.selectedText,
        selectedMarkdown: parsed.selectedMarkdown ?? null,
        selectedContext: parsed.selectedContext ?? null,
        instruction: parsed.instruction.trim(),
        conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined
      },
      {
        agentConfig: effectiveAgentConfig,
        agentEnv: agentAccessMode === "read_only" ? restrictAgentEnvForReadOnly(agentEnv) : agentEnv,
        signal: abort.signal,
        containerName: `gdocs-run-${aiRunId}`,
        documentId,
        aiRunId,
        onComment: commentRecorder?.onComment,
        onProgress: async (event) => {
          await Promise.all([
            db.aiRun.update({ where: { id: aiRunId }, data: { progress: event.message } }),
            recordAiRunEvent({
              aiRunId,
              role: event.role ?? "agent",
              message: event.message
            })
          ]).catch(() => null);
        },
        // Serializable validation spec — reconstructed into a validator wherever
        // the agent actually runs (in-process, or inside the container, where
        // the untrusted widget build is sandboxed).
        validation: {
          kind: "edit_selection",
          selectedText: parsed.selectedText,
          assetIntent,
          documentText: suggestionAnchorText
        }
      }
    );

    const sourceLinks = normalizeSourceLinks([
      ...(Array.isArray(result.sources) ? result.sources : []),
      ...(Array.isArray(result.sourceLinks) ? result.sourceLinks : [])
    ]);
    const images = normalizeAgentImages(result.images, documentId, parsed.shareToken ?? null, aiRunId);
    const widgetResult = await createAgentWidgets({
      widgets: agentAccessMode === "workspace" ? result.widgets : [],
      documentId,
      workspace: linkedRepo?.workspace ?? null,
      aiRunId,
      // selfHostedPull's mode is also "http" (see self-hosted.ts) — never build
      // untrusted widget code on the host for it either.
      verifyOnly: runner.mode !== "inprocess"
    });
    const widgets = widgetResult.created;
    for (const buildError of widgetResult.buildErrors) {
      await recordAiRunEvent({ aiRunId, role: "error", message: buildError });
    }

    const returnedImage = images.length > 0 || hasMarkdownImage(result.replacementText ?? "");
    const returnedWidget = widgets.length > 0;
    if (assetIntent.requiresAnyAsset && !returnedImage && !returnedWidget) {
      throw new Error(
        "The edit request asked for a figure or widget, but the agent did not return either asset."
      );
    }
    if (assetIntent.requiresImage && !returnedImage) {
      throw new Error(
        "The edit request asked for a figure or visual, but the agent did not return a repo image."
      );
    }
    if (assetIntent.requiresWidget && !returnedWidget) {
      throw new Error(
        "The edit request asked for an interactive widget, but the agent did not return a valid widget."
      );
    }

    const commit = linkedRepo && agentAccessMode === "workspace"
      ? await commitWorkspaceChanges({
          workspace: linkedRepo.workspace,
          baseWorkspace: linkedRepo.baseWorkspace,
          repoUrl: linkedRepo.url,
          message: "AI research for document edit",
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

    const rawReplacement = typeof result.replacementText === "string" ? result.replacementText : "";
    const trimmedReplacement = rawReplacement.trim();
    const trimmedSelected = parsed.selectedText.trim();
    const replacementIsEmpty = !trimmedReplacement;
    const replacementEqualsSelection =
      !replacementIsEmpty && trimmedReplacement === trimmedSelected;
    // Empty replacementText is legitimate when the run produced images/widgets
    // (the validator already rejects empty-with-no-assets). We NEVER substitute
    // the agent's chat-style `summary` or the original selection into the
    // document body — that is what leaked meta-commentary / stale text into docs.
    // The client inserts the images/widgets and simply removes the selection.
    const fallbackFired = replacementIsEmpty;
    const finalReplacement = rawReplacement;
    const diagnostics = {
      aiRunId,
      documentId,
      instructionPreview: parsed.instruction.trim().slice(0, 140),
      selectedTextLen: parsed.selectedText.length,
      replacementTextLen: rawReplacement.length,
      replacementIsEmpty,
      replacementEqualsSelection,
      fallbackFired,
      imageCount: images.length,
      widgetCount: widgets.length,
      hasMarkdownImage: hasMarkdownImage(rawReplacement),
      commitSha: commit.commitSha,
      model: result.model
    };
    console.log(`[ai-edit] finished ${JSON.stringify(diagnostics)}`);
    if (fallbackFired || replacementEqualsSelection) {
      const note = fallbackFired
        ? "Diagnostics: agent submitted empty replacementText; the selection will be replaced by the run's images/widgets only (no text substitution)."
        : "Diagnostics: agent submitted replacementText identical to the original selection; the document will not visibly change.";
      console.warn(`[ai-edit] suspect ${JSON.stringify(diagnostics)}`);
      await recordAiRunEvent({ aiRunId, role: "system", message: note }).catch(() => null);
    }

    await markAiRunSucceeded(aiRunId, {
      model: result.model,
      commitSha: commit.commitSha,
      commitUrl: commit.commitUrl,
      replacementText: finalReplacement,
      replacementImages: JSON.stringify(images),
      replacementWidgets: JSON.stringify(widgets),
      replacementSources: JSON.stringify(sourceLinks),
      suggestions: JSON.stringify(Array.isArray(result.suggestions) ? result.suggestions : []),
      agentComments: JSON.stringify(
        commentRecorder
          ? await commentRecorder.finalize(
              Array.isArray(result.comments) ? result.comments : [],
              result.model
            )
          : []
      )
    });
    await recordAiRunEvent({
      aiRunId,
      role: "agent",
      message: result.summary || "Finished AI edit."
    });
  } catch (error) {
    if (linkedRepo && agentAccessMode === "workspace") {
      await commitWorkspaceChanges({
        workspace: linkedRepo.workspace,
        baseWorkspace: linkedRepo.baseWorkspace,
        repoUrl: linkedRepo.url,
        message: "Save failed AI document edit changes",
        push: true
      }).catch((commitError) => {
        console.error("Failed to commit AI edit workspace changes", {
          documentId,
          error: commitError instanceof Error ? commitError.message : commitError
        });
      });
    }

    const failureMessage = isRunCancellation(error, abort.signal)
      ? RUN_CANCELLED_MESSAGE
      : error instanceof Error
        ? error.message
        : "AI edit failed.";
    await recordAiRunEvent({
      aiRunId,
      role: "error",
      message: failureMessage
    }).catch(() => null);
    await db.aiRun
      .update({
        where: { id: aiRunId },
        data: {
          status: "FAILED",
          error: failureMessage,
          finishedAt: new Date()
        }
      })
      .catch(() => null);
  } finally {
    deregisterRunAbortController(aiRunId);
    stopHeartbeat();
    if (linkedRepo && linkedRepo.baseWorkspace !== linkedRepo.worktree) {
      await removeRunWorktree(linkedRepo).catch(() => null);
    }
  }
}

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = aiEditSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid AI edit payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, parsed.data.shareToken ?? null);
  // Editors may commit edits directly; comment-access users may run the agent
  // only in suggestion mode (suggest: true), where the result lands as tracked
  // changes they cannot commit on their own.
  const editorAccess = Boolean(access) && canEdit(access!.permission);
  const suggestAccess = Boolean(access) && parsed.data.suggest === true && canComment(access!.permission);
  if (!access || (!editorAccess && !suggestAccess)) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }
  const suggestOnly = !editorAccess;

  // Agent runs are expensive; cap per-user (or per-IP for share-token editors).
  const runLimitKey = user ? `ai-run:user:${user.id}` : `ai-run:ip:${getClientIp(request)}`;
  const runLimit = rateLimit(runLimitKey, 10, 60_000);
  if (!runLimit.allowed) {
    return NextResponse.json(
      { error: "You're starting AI edits too quickly. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(runLimit.retryAfterSeconds) } }
    );
  }

  // Continuations must thread under a run of the SAME document; a bad parent
  // id degrades to a fresh run rather than leaking another doc's session.
  let parentRunId: string | null = null;
  if (parsed.data.parentRunId) {
    const parent = await db.aiRun.findFirst({
      where: { id: parsed.data.parentRunId, documentId: id },
      select: { id: true }
    });
    parentRunId = parent?.id ?? null;
  }

  const aiRun = await db.aiRun.create({
    data: {
      documentId: id,
      triggerType: "SELECTION_EDIT",
      createdById: user?.id ?? null,
      triggerId: parsed.data.selectionId ? `selection:${parsed.data.selectionId}` : null,
      selectionId: parsed.data.selectionId ?? null,
      // Kept (truncated) so the agent view can show what the run was triggered
      // on after the live selection marker is gone.
      selectedText: parsed.data.selectedText.trim().slice(0, 1500) || null,
      parentRunId,
      instruction: parsed.data.instruction.trim(),
      progress: "Starting Claude research agent.",
      suggestOnly
    }
  });

  await recordAiRunEvent({
    aiRunId: aiRun.id,
    role: "user",
    message: parsed.data.instruction.trim()
  });

  void runAiEditInBackground({
    documentId: id,
    aiRunId: aiRun.id,
    parsed: parsed.data,
    documentTitle: access.document.title,
    documentContentRaw: access.document.content,
    createdById: user?.id ?? null,
    agentConfig: { model: access.document.agentModel, effort: access.document.agentEffort },
    agentAccessMode: agentAccessModeForDocumentAccess(access),
    runnerMode: access.document.runnerMode
  }).catch((error) => {
    console.error("[ai-edit] background run threw", {
      aiRunId: aiRun.id,
      documentId: id,
      error: error instanceof Error ? error.message : error
    });
  });

  return NextResponse.json({ aiRunId: aiRun.id, status: aiRun.status }, { status: 202 });
}
