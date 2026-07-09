import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { deleteSkillFromStore, getUserSkillDir } from "@/lib/skills";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    skillId: string;
  }>;
};

const patchSchema = z.object({
  isDefault: z.boolean()
});

export async function PATCH(request: Request, { params }: RouteContext) {
  const { skillId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid skill update." }, { status: 400 });
  }

  const skill = await db.userSkill.findUnique({ where: { id: skillId } });
  if (!skill || skill.userId !== user.id) {
    return NextResponse.json({ error: "Skill not found." }, { status: 404 });
  }

  const updated = await db.userSkill.update({
    where: { id: skillId },
    data: { isDefault: parsed.data.isDefault }
  });

  return NextResponse.json({
    skill: {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      isDefault: updated.isDefault,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    }
  });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { skillId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const skill = await db.userSkill.findUnique({ where: { id: skillId } });
  if (!skill || skill.userId !== user.id) {
    return NextResponse.json({ error: "Skill not found." }, { status: 404 });
  }

  await db.userSkill.delete({ where: { id: skillId } });
  await deleteSkillFromStore(getUserSkillDir(user.id, skill.name));

  return NextResponse.json({ ok: true });
}
