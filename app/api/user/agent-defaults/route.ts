import { NextResponse } from "next/server";

import {
  isAgentEffort,
  isStorableAgentModel,
  normalizeAgentModel
} from "@/agent-core/agent-config";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Per-user default agent config (User.defaultAgentModel/-Effort). Used as the
// fallback for runs whose document has no explicit agent config — today that
// is Slack channel/DM runs (see resolveSlackAgentConfig in lib/slack/events.ts).
// Null clears a field back to the app default (sonnet-5, thinking off).

function serialize(user: { defaultAgentModel: string | null; defaultAgentEffort: string | null }) {
  return {
    model: user.defaultAgentModel ? normalizeAgentModel(user.defaultAgentModel) : null,
    effort: user.defaultAgentEffort
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { defaultAgentModel: true, defaultAgentEffort: true }
  });
  return NextResponse.json({ defaults: serialize(row ?? { defaultAgentModel: null, defaultAgentEffort: null }) });
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as
    | { model?: unknown; effort?: unknown }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const data: { defaultAgentModel?: string | null; defaultAgentEffort?: string | null } = {};
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
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data,
    select: { defaultAgentModel: true, defaultAgentEffort: true }
  });
  console.log("[agent-defaults] updated", { userId: user.id, ...serialize(updated) });
  return NextResponse.json({ ok: true, defaults: serialize(updated) });
}
