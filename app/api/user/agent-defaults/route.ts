import { NextResponse } from "next/server";

import {
  isAgentEffort,
  isStorableAgentModel,
  normalizeAgentModel
} from "@/agent-core/agent-config";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Per-user default agent config (User.defaultAgentModel/-Effort) plus personal
// custom instructions (User.agentInstructions). Model/effort are the fallback
// for ALL runs whose document has no explicit agent config — Slack, doc
// conversation, selection edits, and comment replies (see
// resolveAgentConfigForUser in lib/agent-defaults.ts). Instructions are
// injected into the system prompt of EVERY run the user triggers.
// Null clears a field back to the app default (sonnet-5, thinking off, none).

// Custom instructions ride inside every system prompt — keep them bounded so a
// pasted document can't crowd out the run's real context.
const MAX_INSTRUCTIONS_LENGTH = 8000;

function serialize(user: {
  defaultAgentModel: string | null;
  defaultAgentEffort: string | null;
  agentInstructions: string | null;
}) {
  return {
    model: user.defaultAgentModel ? normalizeAgentModel(user.defaultAgentModel) : null,
    effort: user.defaultAgentEffort,
    instructions: user.agentInstructions
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { defaultAgentModel: true, defaultAgentEffort: true, agentInstructions: true }
  });
  return NextResponse.json({
    defaults: serialize(
      row ?? { defaultAgentModel: null, defaultAgentEffort: null, agentInstructions: null }
    )
  });
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as
    | { model?: unknown; effort?: unknown; instructions?: unknown }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const data: {
    defaultAgentModel?: string | null;
    defaultAgentEffort?: string | null;
    agentInstructions?: string | null;
  } = {};
  if ("model" in body) {
    if (body.model === null) {
      data.defaultAgentModel = null;
    } else if (isStorableAgentModel(body.model)) {
      data.defaultAgentModel = normalizeAgentModel(body.model);
    } else {
      return NextResponse.json({ error: "Unknown model." }, { status: 400 });
    }
  }
  if ("effort" in body) {
    if (body.effort === null) {
      data.defaultAgentEffort = null;
    } else if (isAgentEffort(body.effort)) {
      data.defaultAgentEffort = body.effort;
    } else {
      return NextResponse.json({ error: "Unknown effort." }, { status: 400 });
    }
  }
  if ("instructions" in body) {
    if (body.instructions === null) {
      data.agentInstructions = null;
    } else if (typeof body.instructions === "string") {
      const trimmed = body.instructions.trim();
      if (trimmed.length > MAX_INSTRUCTIONS_LENGTH) {
        return NextResponse.json(
          { error: `Custom instructions are limited to ${MAX_INSTRUCTIONS_LENGTH} characters.` },
          { status: 400 }
        );
      }
      data.agentInstructions = trimmed || null;
    } else {
      return NextResponse.json({ error: "Invalid instructions." }, { status: 400 });
    }
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data,
    select: { defaultAgentModel: true, defaultAgentEffort: true, agentInstructions: true }
  });
  console.log("[agent-defaults] updated", {
    userId: user.id,
    model: updated.defaultAgentModel,
    effort: updated.defaultAgentEffort,
    instructionsLength: updated.agentInstructions?.length ?? 0
  });
  return NextResponse.json({ ok: true, defaults: serialize(updated) });
}
