import { NextResponse } from "next/server";
import { z } from "zod";

import { getDocumentAiBlocks, getDocumentPlainText, parseDocumentContent } from "@/lib/content";
import { getCurrentUser } from "@/lib/auth";
import { runAiSelectionEdit } from "@/lib/ai";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

const aiEditSchema = z.object({
  selectedText: z.string().min(1).max(10000),
  selectedContext: z.string().max(20000).optional().nullable(),
  instruction: z.string().min(1).max(4000),
  shareToken: z.string().optional().nullable()
});

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

  try {
    const documentContent = parseDocumentContent(access.document.content);
    const documentText = getDocumentPlainText(documentContent);
    const documentBlocks = getDocumentAiBlocks(documentContent);
    const result = await runAiSelectionEdit({
      documentTitle: access.document.title,
      documentText,
      documentBlocks,
      selectedText: parsed.data.selectedText,
      selectedContext: parsed.data.selectedContext ?? null,
      instruction: parsed.data.instruction.trim()
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "The AI edit helper failed unexpectedly."
      },
      { status: 500 }
    );
  }
}
