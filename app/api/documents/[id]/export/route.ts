import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getDocumentMarkdown, parseDocumentContent } from "@/lib/content";
import { resolveDocumentAccess } from "@/lib/permissions";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "document"
  );
}

// Export the document as Markdown. Read access is sufficient (anyone who can
// view the document can export what they can already see).
export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const markdown = getDocumentMarkdown(parseDocumentContent(access.document.content));
  const title = access.document.title?.trim() || "Untitled document";
  const body = `# ${title}\n\n${markdown}\n`;

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slugify(title)}.md"`
    }
  });
}
