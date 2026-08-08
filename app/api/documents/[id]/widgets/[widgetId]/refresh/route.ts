import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { commitWorkspaceChanges, ensureLinkedRepository, runWidgetBuild } from "@/lib/research-workspace";

export const runtime = "nodejs";

async function workspaceHasFile(workspace: string | null, relPath: string) {
  if (!workspace) return false;
  try {
    const stat = await fs.stat(path.resolve(workspace, relPath));
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  { params }: RouteContext<{ id: string; widgetId: string }>
) {
  const { id, widgetId } = await params;
  // canManageDocumentAutomation: edit access AND a signed-in account.
  const gate = await requireDocumentAccess(request, id, "EDIT", {
    requireUser: true,
    forbiddenMessage: "Sign in with edit access to refresh widgets."
  });
  if (!gate.ok) {
    return gate.response;
  }
  const { user } = gate;

  const widget = await db.embeddedWidget.findFirst({
    where: {
      id: widgetId,
      documentId: id
    }
  });

  if (!widget) {
    return NextResponse.json({ error: "Widget not found." }, { status: 404 });
  }

  const linkedRepo = await ensureLinkedRepository(id, { requireClean: false, runnerUserId: user?.id ?? null });
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
    embedUrl: `/api/documents/${id}/widgets/${widget.id}/source`
  });
}
