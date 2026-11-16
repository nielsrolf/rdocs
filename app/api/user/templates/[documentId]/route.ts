import { NextResponse } from "next/server";
import { z } from "zod";

import { notSignedIn, type RouteContext } from "@/lib/api-helpers";
import { getCurrentUser } from "@/lib/auth";
import { setUserTemplateStatus, TemplateError } from "@/lib/templates";

const putSchema = z.object({ status: z.enum(["added", "dismissed"]) });

// Add a template to my "New document" list, or remove / decline it.
export async function PUT(request: Request, { params }: RouteContext<{ documentId: string }>) {
  const { documentId } = await params;
  const user = await getCurrentUser();
  if (!user) return notSignedIn();
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Expected { status: "added" | "dismissed" }.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await setUserTemplateStatus(user.id, documentId, parsed.data.status));
  } catch (error) {
    if (error instanceof TemplateError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
