import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { agentSetupSchema, provisionAgentSetup } from "@/lib/agent-setup";

export const runtime = "nodejs";

// Generic one-click provisioning for an externally integrated agent. The browser
// must be signed in; the integration supplies initial content, env and one skill.
// The returned channel credential can trigger only this newly created document.
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const parsed = agentSetupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent setup payload." }, { status: 400 });

  try {
    return NextResponse.json(await provisionAgentSetup(user.id, parsed.data), { status: 201 });
  } catch (error) {
    console.error("[agent-setup] provisioning failed", {
      userId: user.id,
      error: error instanceof Error ? error.message : error
    });
    return NextResponse.json({ error: "Could not provision the agent document." }, { status: 500 });
  }
}
