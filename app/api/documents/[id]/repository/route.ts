import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { getWorkspacePath } from "@/lib/research-workspace";

export const runtime = "nodejs";

const repositorySchema = z.object({
  repoUrl: z.string().trim().max(500).optional().nullable(),
  repoBranch: z.string().trim().max(120).optional().nullable()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = repositorySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid repository payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, null);
  if (!access || !canEdit(access.permission)) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  const repoUrl = parsed.data.repoUrl?.trim() || null;
  const repoBranch = parsed.data.repoBranch?.trim() || null;

  if (repoUrl && !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/.test(repoUrl) && !/^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/.test(repoUrl)) {
    return NextResponse.json(
      { error: "Use a GitHub HTTPS or SSH repository URL." },
      { status: 400 }
    );
  }

  const updated = await db.document.update({
    where: { id },
    data: {
      repoUrl,
      repoBranch,
      repoWorkspace: repoUrl ? getWorkspacePath(id, repoUrl) : null
    },
    select: {
      repoUrl: true,
      repoBranch: true
    }
  });

  return NextResponse.json({ repository: updated });
}
