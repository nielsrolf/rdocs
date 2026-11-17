import { NextResponse } from "next/server";

import { deleteAgentPreset } from "@/lib/agent-presets";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;
  if (!(await deleteAgentPreset(user.id, id))) return NextResponse.json({ error: "Preset not found." }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
