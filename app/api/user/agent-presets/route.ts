import { NextResponse } from "next/server";
import { z } from "zod";

import {
  AgentPresetError,
  agentPresetConfigSchema,
  agentPresetNameSchema,
  listAgentPresets,
  saveAgentPreset
} from "@/lib/agent-presets";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

// The signed-in user's agent presets (lib/agent-presets.ts). POST creates one
// or replaces the one of the same name.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json({ presets: await listAgentPresets(user.id) });
}

const bodySchema = z.object({ name: agentPresetNameSchema, config: agentPresetConfigSchema });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid preset." }, { status: 400 });
  }
  try {
    return NextResponse.json({ preset: await saveAgentPreset(user.id, parsed.data.name, parsed.data.config) });
  } catch (error) {
    if (error instanceof AgentPresetError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
