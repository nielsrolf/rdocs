import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveDocumentAccess } from "@/lib/permissions";
import { ensureLinkedRepository } from "@/lib/research-workspace";
import { readEmbedSourceFromCandidates } from "@/lib/widget-source";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
    widgetId: string;
  }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { id, widgetId } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");
  const access = await resolveDocumentAccess(id, user?.id, shareToken);

  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
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

  const linkedRepo = await ensureLinkedRepository(id, { requireClean: false, runnerUserId: user?.id ?? null });
  if (!linkedRepo) {
    return NextResponse.json({ error: "Repository is not linked." }, { status: 400 });
  }

  // Base checkout first (post-merge home of the asset, and the per-run worktree
  // may have been garbage-collected), then the run's recorded workspace.
  const html = await readEmbedSourceFromCandidates(
    [linkedRepo.workspace, widget.workspacePath],
    widget.embedSource
  );
  if (html !== null) {
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' data: blob:",
          "img-src 'self' data: blob: https:",
          "script-src 'self' 'unsafe-inline' https://cdn.plot.ly https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://d3js.org",
          "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
          "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
          "connect-src 'self' https://cdn.plot.ly https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com"
        ].join("; ")
      }
    });
  }

  const escapedSource = widget.embedSource.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch)
  );
  const escapedError = (widget.lastError ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch)
  );
  const errorHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:1.25rem;font:14px -apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#202124;background:#fdecea;}
    h1{margin:0 0 .5rem;font-size:1rem;color:#c5221f;}
    p{margin:.25rem 0;}
    code{background:rgba(0,0,0,.06);padding:.1rem .3rem;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem;}
    pre{margin:.5rem 0 0;padding:.6rem .75rem;background:#fff5f4;border:1px solid rgba(197,34,31,.2);border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.78rem;white-space:pre-wrap;max-height:14rem;overflow:auto;}
  </style></head><body>
    <h1>Widget source not found</h1>
    <p>Expected to find <code>${escapedSource}</code> in the linked repository.</p>
    <p>Try <strong>Refresh</strong> on the widget, or ask Claude to regenerate it.</p>
    ${escapedError ? `<pre>${escapedError}</pre>` : ""}
  </body></html>`;
  return new NextResponse(errorHtml, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}
