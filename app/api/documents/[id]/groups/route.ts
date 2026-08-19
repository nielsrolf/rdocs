import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { permissionLevels } from "@/lib/contracts";
import { db } from "@/lib/db";

const grantSchema = z.object({
  groupId: z.string().min(1),
  permission: z.enum(permissionLevels)
});

const revokeSchema = z.object({
  groupId: z.string().min(1)
});

async function requireEditor(request: Request, documentId: string) {
  const gate = await requireDocumentAccess(request, documentId, "EDIT", {
    shareToken: null,
    requireUser: true,
    forbiddenMessage: "You do not have edit access."
  });
  if (!gate.ok) {
    return { error: gate.response };
  }
  return { user: gate.user, access: gate.access };
}

// List this document's group grants.
export async function GET(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const check = await requireEditor(request, id);
  if ("error" in check) return check.error;
  const grants = await db.documentGroupAccess.findMany({
    where: { documentId: id },
    orderBy: { createdAt: "asc" },
    select: {
      groupId: true,
      permission: true,
      group: { select: { name: true, ownerId: true, _count: { select: { members: true } } } }
    }
  });
  return NextResponse.json({
    grants: grants.map((g) => ({
      groupId: g.groupId,
      groupName: g.group.name,
      permission: g.permission,
      memberCount: g.group._count.members
    }))
  });
}

// Grant (or update) a group's permission on this document.
export async function POST(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const check = await requireEditor(request, id);
  if ("error" in check) return check.error;
  const parsed = grantSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid group grant payload." }, { status: 400 });
  }
  // The granter must belong to (or own) the group — you can't share with a
  // group you can't see.
  const group = await db.group.findFirst({
    where: {
      id: parsed.data.groupId,
      OR: [{ ownerId: check.user.id }, { members: { some: { userId: check.user.id } } }]
    },
    select: { id: true, name: true }
  });
  if (!group) {
    return NextResponse.json({ error: "Group not found." }, { status: 404 });
  }
  await db.documentGroupAccess.upsert({
    where: { documentId_groupId: { documentId: id, groupId: group.id } },
    create: { documentId: id, groupId: group.id, permission: parsed.data.permission },
    update: { permission: parsed.data.permission }
  });
  console.log("[doc-groups] granted", {
    documentId: id,
    groupId: group.id,
    permission: parsed.data.permission,
    userId: check.user.id
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const check = await requireEditor(request, id);
  if ("error" in check) return check.error;
  const parsed = revokeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid group grant payload." }, { status: 400 });
  }
  await db.documentGroupAccess.deleteMany({ where: { documentId: id, groupId: parsed.data.groupId } });
  console.log("[doc-groups] revoked", { documentId: id, groupId: parsed.data.groupId, userId: check.user.id });
  return NextResponse.json({ ok: true });
}
