import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { permissionLevels } from "@/lib/contracts";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

const grantSchema = z.object({
  groupId: z.string().min(1),
  permission: z.enum(permissionLevels)
});

const revokeSchema = z.object({
  groupId: z.string().min(1)
});

type RouteContext = { params: Promise<{ id: string }> };

async function requireEditor(documentId: string) {
  const user = await getCurrentUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  }
  const access = await resolveDocumentAccess(documentId, user.id, null);
  if (!access || !canEdit(access.permission)) {
    return { error: NextResponse.json({ error: "You do not have edit access." }, { status: 403 }) };
  }
  return { user, access };
}

// List this document's group grants.
export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const check = await requireEditor(id);
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
export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const check = await requireEditor(id);
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

export async function DELETE(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const check = await requireEditor(id);
  if ("error" in check) return check.error;
  const parsed = revokeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid group grant payload." }, { status: 400 });
  }
  await db.documentGroupAccess.deleteMany({ where: { documentId: id, groupId: parsed.data.groupId } });
  console.log("[doc-groups] revoked", { documentId: id, groupId: parsed.data.groupId, userId: check.user.id });
  return NextResponse.json({ ok: true });
}
