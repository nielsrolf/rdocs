import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { commitWorkspaceChanges, ensureLinkedRepository } from "@/lib/research-workspace";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
    widgetId: string;
  }>;
};

function runBuildCommand(command: string, cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env
    });

    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Widget build timed out after 120 seconds."));
    }, 120_000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || `Widget build exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
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

  try {
    await runBuildCommand(widget.buildCmd, linkedRepo.workspace);
    await commitWorkspaceChanges({
      workspace: linkedRepo.workspace,
      repoUrl: linkedRepo.url,
      message: `Refresh widget ${widget.id}`,
      push: true
    });
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Widget build failed.";
    await db.embeddedWidget.update({
      where: { id: widget.id },
      data: {
        lastError: message
      }
    });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
