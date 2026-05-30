import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveDocumentAccess } from "@/lib/permissions";
import { ensureLinkedRepository } from "@/lib/research-workspace";
import { repairSvgMarkup } from "@/lib/svg-repair";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const contentTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

async function readWorkspaceFile(workspace: string, filePath: string) {
  const resolvedFile = path.resolve(workspace, filePath);
  const workspaceRoot = path.resolve(workspace);
  if (!resolvedFile.startsWith(`${workspaceRoot}${path.sep}`)) {
    return null;
  }

  return fs.readFile(resolvedFile).catch(() => null);
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const shareToken = url.searchParams.get("share");
  const filePath = url.searchParams.get("path");
  const runId = url.searchParams.get("run");

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  if (!filePath) {
    return NextResponse.json({ error: "Missing file path." }, { status: 400 });
  }

  const linkedRepo = await ensureLinkedRepository(id, { requireClean: false });
  if (!linkedRepo) {
    return NextResponse.json({ error: "Repository is not linked." }, { status: 400 });
  }

  const resolvedFile = path.resolve(linkedRepo.workspace, filePath);
  const workspaceRoot = path.resolve(linkedRepo.workspace);
  if (!resolvedFile.startsWith(`${workspaceRoot}${path.sep}`)) {
    return NextResponse.json({ error: "File path must be inside the linked repository." }, { status: 400 });
  }

  const extension = path.extname(resolvedFile).toLowerCase();
  const contentType = contentTypes[extension];
  if (!contentType) {
    return NextResponse.json({ error: "Only image files can be embedded." }, { status: 400 });
  }

  const explicitRun = runId
    ? await db.aiRun.findFirst({
        where: {
          id: runId,
          documentId: id,
          workspacePath: {
            not: null
          }
        },
        select: {
          workspacePath: true
        }
      })
    : null;

  const explicitRunBytes =
    explicitRun?.workspacePath && filePath ? await readWorkspaceFile(explicitRun.workspacePath, filePath) : null;
  const baseBytes = explicitRunBytes ?? (await fs.readFile(resolvedFile).catch(() => null));
  const fallbackRuns = baseBytes
    ? []
    : await db.aiRun.findMany({
        where: {
          documentId: id,
          status: "SUCCEEDED",
          workspacePath: {
            not: null
          }
        },
        orderBy: {
          finishedAt: "desc"
        },
        select: {
          workspacePath: true
        },
        take: 20
      });

  let bytes = baseBytes;
  for (const run of fallbackRuns) {
    if (!run.workspacePath || !filePath) {
      continue;
    }
    bytes = await readWorkspaceFile(run.workspacePath, filePath);
    if (bytes) {
      break;
    }
  }

  if (bytes) {
    // SVGs are parsed strictly as XML by the browser. Agents that generate plots
    // via a shell/Python one-liner sometimes over-escape `!`, leaving `<\!--`
    // comment markers that abort XML parsing — the figure then renders as bare alt
    // text. Repair that markup on the way out so the plot actually shows.
    const body =
      contentType === "image/svg+xml" ? Buffer.from(repairSvgMarkup(bytes.toString("utf8")), "utf8") : bytes;
    return new NextResponse(body, {
      headers: {
        "Cache-Control": "private, max-age=60",
        "Content-Type": contentType
      }
    });
  }

  return NextResponse.json({ error: "File not found." }, { status: 404 });
}
