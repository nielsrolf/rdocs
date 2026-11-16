import { NextResponse } from "next/server";
import { z } from "zod";

import { notSignedIn, type RouteContext } from "@/lib/api-helpers";
import { getCurrentUser } from "@/lib/auth";
import { setDocumentTemplate, TemplateError } from "@/lib/templates";

const patchSchema = z.object({ isTemplate: z.boolean() });

// "This doc is a template" (File menu). Owner-only, enforced in
// setDocumentTemplate.
export async function PATCH(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return notSignedIn();
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { isTemplate: boolean }." }, { status: 400 });
  }
  try {
    return NextResponse.json(await setDocumentTemplate(id, user.id, parsed.data.isTemplate));
  } catch (error) {
    if (error instanceof TemplateError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
