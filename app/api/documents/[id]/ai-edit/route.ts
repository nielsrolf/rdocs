import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { getCurrentUser } from "@/lib/auth";
import { recordAiRunEvent } from "@/lib/ai-runs";
import { runClaudeResearchAgent } from "@/lib/ai";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { commitWorkspaceChanges, ensureLinkedRepositoryWorktree, getWorkspaceOverview } from "@/lib/research-workspace";

const aiEditSchema = z.object({
  selectedText: z.string().min(1).max(200000),
  selectedContext: z.string().max(50000).optional().nullable(),
  instruction: z.string().min(1).max(4000),
  fromPos: z.number().int().nonnegative().optional(),
  toPos: z.number().int().nonnegative().optional(),
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

function wantsPlots(instruction: string) {
  return /\b(plot|plots|figure|figures|chart|charts|image|images|visual|visuals)\b/i.test(instruction);
}

function wantsWidget(instruction: string) {
  return /\b(widget|explorer|interactive|rollout|rollouts|trajectory|trajectories)\b/i.test(instruction);
}

async function listRepoImages(root: string, dir = ""): Promise<string[]> {
  const absoluteDir = path.join(root, dir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const images: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") {
      continue;
    }

    const relativePath = path.posix.join(dir.split(path.sep).join(path.posix.sep), entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      images.push(...(await listRepoImages(root, relativePath)));
      continue;
    }

    if (entry.isFile() && /\.(png|jpe?g|webp|gif|svg)$/i.test(entry.name)) {
      images.push(relativePath);
    }
  }

  return images;
}

function scoreInferredImage(filePath: string) {
  const lower = filePath.toLowerCase();
  let score = 0;
  if (lower.includes("claude-opus-4-7")) score += 20;
  if (lower.includes("correlations/grid")) score += 18;
  if (lower.includes("agentic/ranking")) score += 18;
  if (lower.includes("number/ranking")) score += 14;
  if (lower.includes("fermi/ranking")) score += 14;
  if (lower.includes("elo/ranking")) score += 12;
  if (lower.includes("liking/ranking")) score += 10;
  if (lower.includes("legacy")) score -= 12;
  if (lower.includes("ranking.png")) score += 6;
  if (lower.includes("correlations")) score += 5;
  return score;
}

async function inferPlotImages(input: {
  workspace: string | null;
  documentId: string;
  shareToken: string | null;
  aiRunId: string | null;
  instruction: string;
}) {
  if (!input.workspace || !wantsPlots(input.instruction)) {
    return [];
  }

  const candidates = await listRepoImages(input.workspace);
  return candidates
    .map((candidate) => ({ candidate, score: scoreInferredImage(candidate) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate))
    .slice(0, 5)
    .map((item) => ({
      path: item.candidate,
      src: buildRepoFileUrl(input.documentId, item.candidate, input.shareToken, input.aiRunId),
      alt: item.candidate.split("/").slice(-3).join(" / "),
      caption: item.candidate
    }));
}

async function createAgentWidgets(input: {
  widgets: unknown;
  documentId: string;
  shareToken: string | null;
}) {
  if (!Array.isArray(input.widgets)) {
    return [];
  }

  const created = [];
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

    const record = await db.embeddedWidget.create({
      data: {
        documentId: input.documentId,
        label,
        buildCmd,
        embedSource
      }
    });

    created.push({
      id: record.id,
      label: record.label,
      buildCmd: record.buildCmd,
      embedSource: record.embedSource,
      src: `/api/documents/${input.documentId}/widgets/${record.id}/source${
        input.shareToken ? `?share=${encodeURIComponent(input.shareToken)}` : ""
      }`
    });
  }

  return created;
}

async function inferAgentWidgets(input: {
  workspace: string | null;
  documentId: string;
  shareToken: string | null;
  instruction: string;
}) {
  if (!input.workspace || !wantsWidget(input.instruction)) {
    return [];
  }

  const buildScript = path.join(input.workspace, "widgets", "build_rollout_explorer.py");
  const embedSource = "assets/rollouts.html";
  const hasBuildScript = await fs
    .stat(buildScript)
    .then((stat) => stat.isFile())
    .catch(() => false);

  if (!hasBuildScript) {
    return [];
  }

  const record = await db.embeddedWidget.create({
    data: {
      documentId: input.documentId,
      label: "Agentic trajectory explorer",
      buildCmd: `python widgets/build_rollout_explorer.py --output ${embedSource}`,
      embedSource
    }
  });

  return [
    {
      id: record.id,
      label: record.label,
      buildCmd: record.buildCmd,
      embedSource: record.embedSource,
      src: `/api/documents/${input.documentId}/widgets/${record.id}/source${
        input.shareToken ? `?share=${encodeURIComponent(input.shareToken)}` : ""
      }`
    }
  ];
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
        triggerId:
          typeof parsed.data.fromPos === "number" && typeof parsed.data.toPos === "number"
            ? `selection:${parsed.data.fromPos}:${parsed.data.toPos}`
            : null,
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
    const commit = linkedRepo
      ? await commitWorkspaceChanges({
          workspace: linkedRepo.workspace,
          repoUrl: linkedRepo.url,
          message: "AI research for document edit",
          push: true
      })
      : { commitSha: null, commitUrl: null, pushed: false };
    const normalizedImages = normalizeAgentImages(result.images, id, parsed.data.shareToken ?? null, aiRun.id);
    const images =
      normalizedImages.length > 0
        ? normalizedImages
        : await inferPlotImages({
            workspace: linkedRepo?.workspace ?? null,
            documentId: id,
            shareToken: parsed.data.shareToken ?? null,
            aiRunId: aiRun.id,
            instruction: parsed.data.instruction
          });
    const createdWidgets = await createAgentWidgets({
      widgets: result.widgets,
      documentId: id,
      shareToken: parsed.data.shareToken ?? null
    });
    const widgets =
      createdWidgets.length > 0
        ? createdWidgets
        : await inferAgentWidgets({
            workspace: linkedRepo?.workspace ?? null,
            documentId: id,
            shareToken: parsed.data.shareToken ?? null,
            instruction: parsed.data.instruction
          });

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
      visitedSources: [],
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
