import { NextResponse } from "next/server";
import { z } from "zod";

import { getDocumentAiBlocks, getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { getCurrentUser } from "@/lib/auth";
import { recordAiRunEvent } from "@/lib/ai-runs";
import { runClaudeResearchAgent } from "@/lib/ai";
import { detectEditAssetIntent } from "@/lib/ai-asset-intent";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { commitWorkspaceChanges, ensureLinkedRepositoryWorktree, getWorkspaceOverview, runWidgetBuild } from "@/lib/research-workspace";
import { normalizeSourceLinks } from "@/lib/sources";

const aiEditSchema = z.object({
  selectedText: z.string().min(1).max(200000),
  selectedMarkdown: z.string().max(400000).optional().nullable(),
  selectedContext: z.string().max(50000).optional().nullable(),
  instruction: z.string().min(1).max(4000),
  selectionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/).optional().nullable(),
  shareToken: z.string().optional().nullable()
});

function buildRepoFileUrl(documentId: string, path: string, shareToken: string | null, aiRunId: string | null) {
  const params = new URLSearchParams({ path });
  if (shareToken) {
    params.set("share", shareToken);
  }
  if (aiRunId) {
    params.set("run", aiRunId);
  }

  return `/api/documents/${documentId}/repo-files?${params.toString()}`;
}

function normalizeAgentImages(images: unknown, documentId: string, shareToken: string | null, aiRunId: string | null) {
  if (!Array.isArray(images)) {
    return [];
  }

  return images
    .map((image) => {
      if (!image || typeof image !== "object") {
        return null;
      }
      const typed = image as { path?: unknown; alt?: unknown; caption?: unknown };
      if (typeof typed.path !== "string" || !typed.path.trim()) {
        return null;
      }
      const path = typed.path.trim();
      return {
        path,
        src: buildRepoFileUrl(documentId, path, shareToken, aiRunId),
        alt: typeof typed.alt === "string" ? typed.alt : path,
        caption: typeof typed.caption === "string" ? typed.caption : null
      };
    })
    .filter((image): image is NonNullable<typeof image> => image != null);
}

function hasMarkdownImage(text: string) {
  return /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.test(text);
}

async function createAgentWidgets(input: {
  widgets: unknown;
  documentId: string;
  shareToken: string | null;
  workspace: string | null;
  aiRunId: string | null;
}) {
  if (!Array.isArray(input.widgets)) {
    return { created: [] as Array<Record<string, unknown>>, buildErrors: [] as string[] };
  }

  const created: Array<Record<string, unknown>> = [];
  const buildErrors: string[] = [];
  for (const widget of input.widgets) {
    if (!widget || typeof widget !== "object") {
      continue;
    }

    const typed = widget as {
      label?: unknown;
      build_cmd?: unknown;
      buildCmd?: unknown;
      embed_source?: unknown;
      embedSource?: unknown;
    };
    const label = typeof typed.label === "string" && typed.label.trim() ? typed.label.trim() : "Interactive widget";
    const buildCmd =
      typeof typed.build_cmd === "string"
        ? typed.build_cmd.trim()
        : typeof typed.buildCmd === "string"
          ? typed.buildCmd.trim()
          : "";
    const embedSource =
      typeof typed.embed_source === "string"
        ? typed.embed_source.trim()
        : typeof typed.embedSource === "string"
          ? typed.embedSource.trim()
          : "";

    if (!buildCmd || !embedSource) {
      continue;
    }

    let lastError: string | null = null;
    let lastBuiltAt: Date | null = null;
    if (input.workspace) {
      const result = await runWidgetBuild(buildCmd, input.workspace);
      if (!result.ok) {
        lastError = result.error.slice(0, 6000);
        buildErrors.push(`Widget "${label}" failed to build: ${lastError}`);
      } else {
        lastBuiltAt = new Date();
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
      src: `/api/documents/${input.documentId}/widgets/${record.id}/source${
        input.shareToken ? `?share=${encodeURIComponent(input.shareToken)}` : ""
      }`
    });
  }

  return { created, buildErrors };
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
  if (!access || !canEdit(access.permission)) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  let aiRunId: string | null = null;
  let linkedRepo: Awaited<ReturnType<typeof ensureLinkedRepositoryWorktree>> = null;

  try {
    const aiRun = await db.aiRun.create({
      data: {
        documentId: id,
        triggerType: "SELECTION_EDIT",
        triggerId: parsed.data.selectionId ? `selection:${parsed.data.selectionId}` : null,
        instruction: parsed.data.instruction.trim(),
        progress: "Starting Claude research agent."
      }
    });
    aiRunId = aiRun.id;
    await recordAiRunEvent({
      aiRunId: aiRun.id,
      role: "user",
      message: parsed.data.instruction.trim()
    });

    const documentContent = parseDocumentContent(access.document.content);
    const documentText = getDocumentPlainText(documentContent);
    const documentBlocks = getDocumentAiBlocks(documentContent);
    const unresolvedThreads = await db.commentThread.findMany({
      where: {
        documentId: id,
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
          orderBy: {
            createdAt: "asc"
          },
          select: {
            body: true,
            author: {
              select: {
                name: true
              }
            },
            aiModel: true
          }
        }
      }
    });
    linkedRepo = await ensureLinkedRepositoryWorktree(id, aiRun.id);
    if (linkedRepo) {
      await db.aiRun.update({
        where: { id: aiRun.id },
        data: {
          workspacePath: linkedRepo.workspace,
          branchName: linkedRepo.branchName
        }
      });
      await recordAiRunEvent({
        aiRunId: aiRun.id,
        role: "system",
        message: `Using isolated worktree ${linkedRepo.workspace} on branch ${linkedRepo.branchName}.`
      });
    }
    const workspaceOverview = await getWorkspaceOverview(linkedRepo?.workspace ?? null);
    const result = await runClaudeResearchAgent({
      mode: "edit_selection",
      documentTitle: access.document.title,
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
      selectedText: parsed.data.selectedText,
      selectedMarkdown: parsed.data.selectedMarkdown ?? null,
      selectedContext: parsed.data.selectedContext ?? null,
      instruction: parsed.data.instruction.trim()
    }, async (event) => {
      await Promise.all([
        db.aiRun.update({
          where: { id: aiRun.id },
          data: { progress: event.message }
        }),
        recordAiRunEvent({
          aiRunId: aiRun.id,
          role: event.role ?? "agent",
          message: event.message
        })
      ]).catch(() => null);
    });
    const sourceLinks = normalizeSourceLinks([
      ...(Array.isArray(result.sources) ? result.sources : []),
      ...(Array.isArray(result.sourceLinks) ? result.sourceLinks : [])
    ]);
    const images = normalizeAgentImages(result.images, id, parsed.data.shareToken ?? null, aiRun.id);
    const widgetResult = await createAgentWidgets({
      widgets: result.widgets,
      documentId: id,
      shareToken: parsed.data.shareToken ?? null,
      workspace: linkedRepo?.workspace ?? null,
      aiRunId: aiRun.id
    });
    const widgets = widgetResult.created;
    for (const buildError of widgetResult.buildErrors) {
      await recordAiRunEvent({ aiRunId: aiRun.id, role: "error", message: buildError });
    }
    const assetIntent = detectEditAssetIntent(parsed.data.instruction);
    const returnedImage = images.length > 0 || hasMarkdownImage(result.replacementText ?? "");
    const returnedWidget = widgets.length > 0;
    if (assetIntent.requiresAnyAsset && !returnedImage && !returnedWidget) {
      throw new Error("The edit request asked for a figure or widget, but the agent did not return either asset.");
    }
    if (assetIntent.requiresImage && !returnedImage) {
      throw new Error("The edit request asked for a figure or visual, but the agent did not return a repo image.");
    }
    if (assetIntent.requiresWidget && !returnedWidget) {
      throw new Error("The edit request asked for an interactive widget, but the agent did not return a valid widget.");
    }
    const commit = linkedRepo
      ? await commitWorkspaceChanges({
          workspace: linkedRepo.workspace,
          baseWorkspace: linkedRepo.baseWorkspace,
          repoUrl: linkedRepo.url,
          message: "AI research for document edit",
          push: true
      })
      : { commitSha: null, commitUrl: null, pushed: false };

    await db.aiRun.update({
      where: { id: aiRun.id },
      data: {
        status: "SUCCEEDED",
        model: result.model,
        commitSha: commit.commitSha,
        commitUrl: commit.commitUrl,
        finishedAt: new Date()
      }
    });
    await recordAiRunEvent({
      aiRunId: aiRun.id,
      role: "agent",
      message: result.summary || "Finished AI edit."
    });

    return NextResponse.json({
      replacementText:
        typeof result.replacementText === "string" && result.replacementText.trim()
          ? result.replacementText
          : result.summary || parsed.data.selectedText,
      model: result.model,
      visitedSources: sourceLinks,
      images,
      widgets,
      commitSha: commit.commitSha,
      commitUrl: commit.commitUrl,
      aiRunId: aiRun.id
    });
  } catch (error) {
    if (linkedRepo) {
      await commitWorkspaceChanges({
        workspace: linkedRepo.workspace,
        baseWorkspace: linkedRepo.baseWorkspace,
        repoUrl: linkedRepo.url,
        message: "Save failed AI document edit changes",
        push: true
      }).catch((commitError) => {
        console.error("Failed to commit AI edit workspace changes", {
          documentId: id,
          error: commitError instanceof Error ? commitError.message : commitError
        });
      });
    }

    if (aiRunId) {
      await recordAiRunEvent({
        aiRunId,
        role: "error",
        message: error instanceof Error ? error.message : "AI edit failed."
      }).catch(() => null);
      await db.aiRun.update({
        where: { id: aiRunId },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "AI edit failed.",
          finishedAt: new Date()
        }
      }).catch(() => null);
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "The AI edit helper failed unexpectedly."
      },
      { status: 500 }
    );
  }
}
