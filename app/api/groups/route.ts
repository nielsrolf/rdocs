import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export type GroupView = {
  id: string;
  name: string;
  ownerId: string;
  isOwner: boolean;
  members: { userId: string; name: string; email: string; role: string }[];
};

function serializeGroup(
  group: {
    id: string;
    name: string;
    ownerId: string;
    members: { userId: string; role: string; user: { name: string; email: string } }[];
  },
  userId: string
): GroupView {
  return {
    id: group.id,
    name: group.name,
    ownerId: group.ownerId,
    isOwner: group.ownerId === userId,
    members: group.members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role
    }))
  };
}

const groupSelect = {
  id: true,
  name: true,
  ownerId: true,
  members: {
    orderBy: { createdAt: "asc" as const },
    select: { userId: true, role: true, user: { select: { name: true, email: true } } }
  }
};

// Groups the user owns or belongs to.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const groups = await db.group.findMany({
    where: {
      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }]
    },
    orderBy: { createdAt: "asc" },
    select: groupSelect
  });
  return NextResponse.json({ groups: groups.map((g) => serializeGroup(g, user.id)) });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const parsed = createGroupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid group payload." }, { status: 400 });
  }
  const group = await db.group.create({
    data: {
      name: parsed.data.name,
      ownerId: user.id,
      // The creator is a member too, so "docs shared with my groups" includes
      // docs shared with groups they created.
      members: { create: { userId: user.id, role: "owner" } }
    },
    select: groupSelect
  });
  console.log("[groups] created", { groupId: group.id, userId: user.id });
  return NextResponse.json({ group: serializeGroup(group, user.id) });
}
