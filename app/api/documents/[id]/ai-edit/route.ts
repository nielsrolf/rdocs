import fs from "node:fs/promises";
import path from "node:path";

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
  return detectEditAssetIntent(instruction).wantsImage;
}

function wantsWidget(instruction: string) {
  return detectEditAssetIntent(instruction).wantsWidget;
}

function hasMarkdownImage(text: string) {
  return /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.test(text);
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

async function listRepoHtmlAssets(root: string, dir = "assets"): Promise<Array<{ path: string; mtimeMs: number }>> {
  const absoluteDir = path.join(root, dir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const assets: Array<{ path: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") {
      continue;
    }

    const relativePath = path.posix.join(dir.split(path.sep).join(path.posix.sep), entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      assets.push(...(await listRepoHtmlAssets(root, relativePath)));
      continue;
    }

    if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      const stat = await fs.stat(absolutePath).catch(() => null);
      assets.push({ path: relativePath, mtimeMs: stat?.mtimeMs ?? 0 });
    }
  }

  return assets;
}

async function findWidgetBuildScript(root: string, embedSource: string) {
  const assetBaseName = path.basename(embedSource).replace(/\.html?$/i, "");
  const candidates = [
    `widgets/build_${assetBaseName}.py`,
    `widgets/${assetBaseName}.py`,
    `widgets/build_${assetBaseName}.js`,
    `widgets/${assetBaseName}.js`,
    `widgets/build_${assetBaseName}.mjs`,
    `widgets/${assetBaseName}.mjs`,
    `widgets/build_${assetBaseName}.sh`,
    `widgets/${assetBaseName}.sh`
  ];

  for (const candidate of candidates) {
    const exists = await fs
      .stat(path.join(root, candidate))
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!exists) {
      continue;
    }

    if (candidate.endsWith(".py")) {
      return `python ${candidate}`;
    }
    if (candidate.endsWith(".js") || candidate.endsWith(".mjs")) {
      return `node ${candidate}`;
    }
    return `sh ${candidate}`;
  }

  return null;
}

function labelFromAssetPath(assetPath: string) {
  const baseName = path.basename(assetPath).replace(/\.html?$/i, "");
  return baseName
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ") || "Interactive widget";
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

async function inferAgentWidgets(input: {
  workspace: string | null;
  documentId: string;
  shareToken: string | null;
  instruction: string;
  aiRunId: string | null;
  runStartedAt: Date;
}) {
  if (!input.workspace || !wantsWidget(input.instruction)) {
    return { created: [] as Array<Record<string, unknown>>, buildErrors: [] as string[] };
  }

  const recentHtmlAssets = (await listRepoHtmlAssets(input.workspace))
    .filter((asset) => asset.mtimeMs >= input.runStartedAt.getTime() - 5_000)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));

  for (const asset of recentHtmlAssets) {
    const buildCmd = await findWidgetBuildScript(input.workspace, asset.path);
    if (!buildCmd) {
      continue;
    }

    const buildResult = await runWidgetBuild(buildCmd, input.workspace);
    const lastError = buildResult.ok ? null : buildResult.error.slice(0, 6000);
    const buildErrors = buildResult.ok ? [] : [`Inferred widget failed to build: ${lastError}`];
    const record = await db.embeddedWidget.create({
      data: {
        documentId: input.documentId,
        label: labelFromAssetPath(asset.path),
        buildCmd,
        embedSource: asset.path,
        createdByRunId: input.aiRunId,
        workspacePath: input.workspace,
        lastBuiltAt: buildResult.ok ? new Date() : null,
        lastError
      }
    });

    return {
      created: [
        {
          id: record.id,
          label: record.label,
          buildCmd: record.buildCmd,
          embedSource: record.embedSource,
          lastError: record.lastError,
          src: `/api/documents/${input.documentId}/widgets/${record.id}/source${
            input.shareToken ? `?share=${encodeURIComponent(input.shareToken)}` : ""
          }`
        }
      ],
      buildErrors
    };
  }

  const buildScript = path.join(input.workspace, "widgets", "build_rollout_explorer.py");
  const embedSource = "assets/rollouts.html";
  const hasBuildScript = await fs
    .stat(buildScript)
    .then((stat) => stat.isFile())
    .catch(() => false);

  if (!hasBuildScript) {
    return { created: [], buildErrors: [] };
  }

  const buildCmd = `python widgets/build_rollout_explorer.py --output ${embedSource}`;
  const buildResult = await runWidgetBuild(buildCmd, input.workspace);
  const lastError = buildResult.ok ? null : buildResult.error.slice(0, 6000);
  const buildErrors = buildResult.ok ? [] : [`Inferred widget failed to build: ${lastError}`];

  const record = await db.embeddedWidget.create({
    data: {
      documentId: input.documentId,
      label: "Agentic trajectory explorer",
      buildCmd,
      embedSource,
      createdByRunId: input.aiRunId,
      workspacePath: input.workspace,
      lastBuiltAt: buildResult.ok ? new Date() : null,
      lastError
    }
  });

  return {
    created: [
      {
        id: record.id,
        label: record.label,
        buildCmd: record.buildCmd,
        embedSource: record.embedSource,
        lastError: record.lastError,
        src: `/api/documents/${input.documentId}/widgets/${record.id}/source${
          input.shareToken ? `?share=${encodeURIComponent(input.shareToken)}` : ""
        }`
      }
    ],
    buildErrors
  };
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
    const widgetResult = await createAgentWidgets({
      widgets: result.widgets,
      documentId: id,
      shareToken: parsed.data.shareToken ?? null,
      workspace: linkedRepo?.workspace ?? null,
      aiRunId: aiRun.id
    });
    const widgetOutput =
      widgetResult.created.length > 0
        ? widgetResult
        : await inferAgentWidgets({
            workspace: linkedRepo?.workspace ?? null,
            documentId: id,
            shareToken: parsed.data.shareToken ?? null,
            instruction: parsed.data.instruction,
            aiRunId: aiRun.id,
            runStartedAt: aiRun.startedAt
          });
    const widgets = widgetOutput.created;
    for (const buildError of widgetOutput.buildErrors) {
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
