import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { permissionLevels } from "@/lib/contracts";
import { db } from "@/lib/db";

const createMembershipSchema = z.object({
  documentId: z.string().min(1),
  email: z.string().email(),
  permission: z.enum(permissionLevels)
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createMembershipSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid collaborator payload." }, { status: 400 });
  }

  const [document, collaborator] = await Promise.all([
    db.document.findUnique({
      where: { id: parsed.data.documentId },
      select: { ownerId: true }
    }),
    db.user.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
      select: {
        id: true,
        name: true,
        email: true
      }
    })
  ]);

  if (!document || document.ownerId !== user.id) {
    return NextResponse.json({ error: "Only the owner can add collaborators." }, { status: 403 });
  }

  if (!collaborator) {
    return NextResponse.json(
      { error: "That user does not exist yet. Ask them to sign up first." },
      { status: 404 }
    );
  }

  if (collaborator.id === user.id) {
    return NextResponse.json(
      { error: "You already own this document." },
      { status: 400 }
    );
  }

  const membership = await db.documentMembership.upsert({
    where: {
      documentId_userId: {
        documentId: parsed.data.documentId,
        userId: collaborator.id
      }
    },
    update: {
      permission: parsed.data.permission
    },
    create: {
      documentId: parsed.data.documentId,
      userId: collaborator.id,
      permission: parsed.data.permission
    },
    select: {
      id: true,
      permission: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  });

  return NextResponse.json({ membership });
}
