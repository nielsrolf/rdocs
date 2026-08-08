// Shared background runner for AI selection edits. Extracted from
// app/api/documents/[id]/ai-edit/route.ts (mirroring lib/agent-conversation.ts
// / lib/ask-ai.ts's extraction) so it is not a route-file export — Next.js's
// route type-checking rejects extra named exports from route.ts — and so the
// route stays a thin HTTP shell (validate → create AiRun → fire background fn
// → respond 202).

import { buildAndVerifyWidget } from "@/agent-core";
import type { AgentAccessMode } from "@/agent-core";
import { buildConversationHistory, markAiRunSucceeded, recordAiRunEvent } from "@/lib/ai-runs";
import { withAgentRunLifecycle } from "@/lib/agent-run-lifecycle";
import { detectEditAssetIntent } from "@/lib/ai-asset-intent";
import {
  embedSourceExists,
  hasMarkdownImage,
  normalizeAgentImages,
  normalizeSubmittedWidget
} from "@/lib/ai-edit-submission";
import { getDocumentAiBlocks, getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { db } from "@/lib/db";
import { createLiveCommentRecorder } from "@/lib/agent-comments";
import { flattenDocumentTextNodes } from "@/lib/suggestion-content";
import { getWorkspaceOverview } from "@/lib/research-workspace";
import { normalizeSourceLinks } from "@/lib/sources";

export async function createAgentWidgets(input: {
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

// The validated request fields the background run needs. The route's zod
// schema (app/api/documents/[id]/ai-edit/route.ts) infers a structural
// superset of this shape.
export type AiEditRunPayload = {
  selectedText: string;
  selectedMarkdown?: string | null;
  selectedContext?: string | null;
  instruction: string;
  shareToken?: string | null;
  parentRunId?: string | null;
};

export async function runAiEditInBackground(input: {
  documentId: string;
  aiRunId: string;
  parsed: AiEditRunPayload;
  documentTitle: string;
  documentContentRaw: string;
  createdById: string | null;
  agentConfig: { model: string | null; effort: string | null };
  agentAccessMode: AgentAccessMode;
  runnerMode: string;
}) {
  const { documentId, aiRunId, parsed, documentTitle, documentContentRaw, createdById, agentConfig, agentAccessMode, runnerMode } = input;

  await withAgentRunLifecycle(
    {
      aiRunId,
      documentId,
      createdById,
      agentAccessMode,
      // selfHosted documents: the app never manages a repo/worktree for these —
      // the owner's external worker clones and works in its own checkout
      // (gated inside the lifecycle wrapper, which also skips every
      // commit/cleanup step already gated on the worktree being set).
      runnerMode,
      failureCommitMessage: "Save failed AI document edit changes",
      onFailureCommitError: (commitError) => {
        console.error("Failed to commit AI edit workspace changes", {
          documentId,
          error: commitError instanceof Error ? commitError.message : commitError
        });
      },
      defaultFailureMessage: "AI edit failed."
    },
    async (ctx) => {
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

      const linkedRepo = await ctx.setupWorkspace();
      const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null, documentId);
      const assetIntent = detectEditAssetIntent(parsed.instruction);
      const { runAgentEnv, effectiveAgentConfig } = await ctx.loadEnv(agentConfig);
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

      const result = await ctx.runner.run(
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
          agentEnv: runAgentEnv,
          signal: ctx.abortSignal,
          containerName: `gdocs-run-${aiRunId}`,
          documentId,
          aiRunId,
          onComment: commentRecorder?.onComment,
          onProgress: ctx.onProgress,
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
        verifyOnly: ctx.runner.mode !== "inprocess"
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

      const commit = await ctx.commitRunChanges("AI research for document edit");

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
    }
  );
}
