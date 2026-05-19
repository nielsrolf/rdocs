import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { commitWorkspaceChanges, ensureLinkedRepository, runWidgetBuild } from "@/lib/research-workspace";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
    widgetId: string;
  }>;
};

async function workspaceHasFile(workspace: string | null, relPath: string) {
  if (!workspace) return false;
  try {
    const stat = await fs.stat(path.resolve(workspace, relPath));
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id, widgetId } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");
  const access = await resolveDocumentAccess(id, user?.id, shareToken);

  if (!access || !canEdit(access.permission)) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  const widget = await db.embeddedWidget.findFirst({
    where: {
      id: widgetId,
      documentId: id
    }
  });

  if (!widget) {
    return NextResponse.json({ error: "Widget not found." }, { status: 404 });
  }

  const linkedRepo = await ensureLinkedRepository(id, { requireClean: false });
  if (!linkedRepo) {
    return NextResponse.json({ error: "Link a repository before refreshing widgets." }, { status: 400 });
  }

  // Detect the first token of the build command — usually the script path — so we
  // can pick the workspace that actually has it.
  const buildHints = widget.buildCmd
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => /(^|\/)widgets\/|\.(py|js|mjs|cjs|ts|tsx|sh)$/i.test(token) && !token.startsWith("-"));

  const candidates = [linkedRepo.workspace];
  if (widget.workspacePath && !candidates.includes(widget.workspacePath)) {
    candidates.push(widget.workspacePath);
  }

  let chosen = linkedRepo.workspace;
  for (const candidate of candidates) {
    const hasAll = await Promise.all(
      buildHints.map((token) => workspaceHasFile(candidate, token))
    ).then((results) => results.every(Boolean));
    if (hasAll) {
      chosen = candidate;
      break;
    }
  }

  const buildResult = await runWidgetBuild(widget.buildCmd, chosen);
  if (!buildResult.ok) {
    const message = buildResult.error || "Widget build failed.";
    await db.embeddedWidget.update({
      where: { id: widget.id },
      data: { lastError: message }
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (chosen === linkedRepo.workspace) {
    await commitWorkspaceChanges({
      workspace: linkedRepo.workspace,
      repoUrl: linkedRepo.url,
      message: `Refresh widget ${widget.id}`,
      push: true
    }).catch(() => null);
  }

  const refreshed = await db.embeddedWidget.update({
    where: { id: widget.id },
    data: {
      lastBuiltAt: new Date(),
      lastError: null
    }
  });

  return NextResponse.json({
    widget: refreshed,
    embedUrl: `/api/documents/${id}/widgets/${widget.id}/source?share=${encodeURIComponent(shareToken ?? "")}`
  });
}
