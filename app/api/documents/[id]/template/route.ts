import { NextResponse } from "next/server";
import { z } from "zod";

import { notSignedIn, type RouteContext } from "@/lib/api-helpers";
import { getCurrentUser } from "@/lib/auth";
import { setUserTemplateStatus, TemplateError } from "@/lib/templates";

const patchSchema = z.object({ isTemplate: z.boolean() });

// "Use this doc as a template" (File menu): the signed-in user's own choice
// for this document, for anyone who can open it.
export async function PATCH(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return notSignedIn();
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { isTemplate: boolean }." }, { status: 400 });
  }
  try {
    const { status } = await setUserTemplateStatus(id, user.id, parsed.data.isTemplate ? "added" : "dismissed");
    return NextResponse.json({ isTemplate: status === "added" });
  } catch (error) {
    if (error instanceof TemplateError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
