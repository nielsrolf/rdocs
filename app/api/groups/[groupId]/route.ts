import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

type RouteContext = { params: Promise<{ groupId: string }> };

async function requireGroupOwner(groupId: string, userId: string) {
  const group = await db.group.findUnique({
    where: { id: groupId },
    select: { id: true, ownerId: true, members: { where: { userId }, select: { role: true } } }
  });
  if (!group) return { error: NextResponse.json({ error: "Group not found." }, { status: 404 }) };
  const isOwner = group.ownerId === userId || group.members.some((m) => m.role === "owner");
  if (!isOwner) {
    return { error: NextResponse.json({ error: "Only the group owner can do this." }, { status: 403 }) };
  }
  return { group };
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { groupId } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const check = await requireGroupOwner(groupId, user.id);
  if ("error" in check) return check.error;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid group payload." }, { status: 400 });
  }
  await db.group.update({ where: { id: groupId }, data: { name: parsed.data.name } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { groupId } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const check = await requireGroupOwner(groupId, user.id);
  if ("error" in check) return check.error;
  await db.group.delete({ where: { id: groupId } });
  console.log("[groups] deleted", { groupId, userId: user.id });
  return NextResponse.json({ ok: true });
}
