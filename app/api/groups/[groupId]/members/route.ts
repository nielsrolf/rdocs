import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

const addMemberSchema = z.object({
  email: z.string().trim().email()
});

const removeMemberSchema = z.object({
  userId: z.string().min(1)
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
    return { error: NextResponse.json({ error: "Only the group owner can manage members." }, { status: 403 }) };
  }
  return { group };
}

export async function POST(request: Request, { params }: RouteContext) {
  const { groupId } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const check = await requireGroupOwner(groupId, user.id);
  if ("error" in check) return check.error;

  const parsed = addMemberSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid member payload." }, { status: 400 });
  }
  const target = await db.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
    select: { id: true, name: true, email: true }
  });
  if (!target) {
    return NextResponse.json({ error: "No user with that email." }, { status: 404 });
  }
  await db.groupMember.upsert({
    where: { groupId_userId: { groupId, userId: target.id } },
    create: { groupId, userId: target.id },
    update: {}
  });
  console.log("[groups] member added", { groupId, userId: user.id, memberId: target.id });
  return NextResponse.json({
    member: { userId: target.id, name: target.name, email: target.email, role: "member" }
  });
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { groupId } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const parsed = removeMemberSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid member payload." }, { status: 400 });
  }
  // Members may remove THEMSELVES (leave); otherwise owner-only.
  if (parsed.data.userId !== user.id) {
    const check = await requireGroupOwner(groupId, user.id);
    if ("error" in check) return check.error;
  }
  await db.groupMember.deleteMany({ where: { groupId, userId: parsed.data.userId } });
  return NextResponse.json({ ok: true });
}
