import { NextResponse } from "next/server";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { deleteSkillFromStore, getDocumentSkillDir } from "@/lib/skills";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: RouteContext<{ id: string; skillId: string }>
) {
  const { id, skillId } = await params;

  const gate = await requireDocumentAccess(request, id, "EDIT", {
    requireUser: true,
    forbiddenMessage: "Sign in with edit access to manage agent skills."
  });
  if (!gate.ok) {
    return gate.response;
  }

  const skill = await db.documentSkill.findUnique({ where: { id: skillId } });
  if (!skill || skill.documentId !== id) {
    return NextResponse.json({ error: "Skill not found." }, { status: 404 });
  }

  await db.documentSkill.delete({ where: { id: skillId } });
  await deleteSkillFromStore(getDocumentSkillDir(id, skill.name));

  return NextResponse.json({ ok: true });
}
