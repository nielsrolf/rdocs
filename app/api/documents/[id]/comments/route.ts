import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canComment, resolveDocumentAccess } from "@/lib/permissions";

const createThreadSchema = z.object({
  body: z.string().min(1).max(4000),
  anchorText: z.string().min(1).max(1000),
  anchorContext: z.string().max(2000).optional().nullable(),
  fromPos: z.number().int().optional().nullable(),
  toPos: z.number().int().optional().nullable(),
  shareToken: z.string().optional().nullable()
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You must be signed in to comment." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createThreadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid comment payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user.id, parsed.data.shareToken ?? null);
  if (!access || !canComment(access.permission)) {
    return NextResponse.json({ error: "You do not have comment access." }, { status: 403 });
  }

  const thread = await db.commentThread.create({
    data: {
      documentId: id,
      createdById: user.id,
      anchorText: parsed.data.anchorText,
      anchorContext: parsed.data.anchorContext,
      fromPos: parsed.data.fromPos,
      toPos: parsed.data.toPos,
      comments: {
        create: {
          body: parsed.data.body,
          authorId: user.id
        }
      }
    },
    select: {
      id: true,
      anchorText: true,
      anchorContext: true,
      fromPos: true,
      toPos: true,
      status: true,
      createdAt: true,
      createdBy: {
        select: {
          id: true,
          name: true
        }
      },
      comments: {
        orderBy: {
          createdAt: "asc"
        },
        select: {
          id: true,
          body: true,
          aiModel: true,
          createdAt: true,
          author: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }
    }
  });

  return NextResponse.json({ thread });
}
