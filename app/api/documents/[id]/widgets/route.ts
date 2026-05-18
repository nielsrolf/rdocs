import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

export const runtime = "nodejs";

const widgetSchema = z.object({
  label: z.string().trim().min(1).max(120),
  buildCmd: z.string().trim().min(1).max(1000),
  embedSource: z.string().trim().min(1).max(500)
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = widgetSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid widget payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, null);
  if (!access || !canEdit(access.permission)) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  const widget = await db.embeddedWidget.create({
    data: {
      documentId: id,
      label: parsed.data.label,
      buildCmd: parsed.data.buildCmd,
      embedSource: parsed.data.embedSource
    }
  });

  return NextResponse.json({ widget });
}
