import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canManageDocumentAutomation, resolveDocumentAccess } from "@/lib/permissions";
import { deleteSkillFromStore, getDocumentSkillDir } from "@/lib/skills";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
    skillId: string;
  }>;
};

export async function DELETE(request: Request, { params }: RouteContext) {
  const { id, skillId } = await params;
  const user = await getCurrentUser();
  const shareToken = new URL(request.url).searchParams.get("share");

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access || !canManageDocumentAutomation(access, user?.id)) {
    return NextResponse.json({ error: "Sign in with collaborator edit access to manage agent skills." }, { status: 403 });
  }

  const skill = await db.documentSkill.findUnique({ where: { id: skillId } });
  if (!skill || skill.documentId !== id) {
    return NextResponse.json({ error: "Skill not found." }, { status: 404 });
  }

  await db.documentSkill.delete({ where: { id: skillId } });
  await deleteSkillFromStore(getDocumentSkillDir(id, skill.name));

  return NextResponse.json({ ok: true });
}
