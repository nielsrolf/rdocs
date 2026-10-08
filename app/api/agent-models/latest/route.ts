import { NextResponse } from "next/server";

import {
  ANTHROPIC_LATEST_MODEL_ALIASES,
  resolveLatestAnthropicAlias
} from "@/agent-core/agent-config";
import { refreshLatestAnthropicModels } from "@/lib/anthropic-model-catalog";
import { getCurrentUser } from "@/lib/auth";
import { getUserCredential } from "@/lib/user-credentials";

export const runtime = "nodejs";

// What each "latest" alias in the model picker resolves to right now, so the
// UI can say "Opus (latest) · Opus 5.5". Refreshes a stale catalog with the
// VIEWER's own Anthropic credential (read-only Models API call); without one
// the last discovered answer, or the built-in fallback, is returned.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const credential = await getUserCredential(user.id, "anthropic").catch(() => null);
  const latest = await refreshLatestAnthropicModels(credential);
  const aliases = Object.fromEntries(
    Object.entries(ANTHROPIC_LATEST_MODEL_ALIASES).map(([alias, { family, fallbackLabel }]) => [
      alias,
      {
        id: resolveLatestAnthropicAlias(alias, latest),
        label: latest[family]?.label ?? fallbackLabel,
        discovered: Boolean(latest[family])
      }
    ])
  );
  return NextResponse.json({ aliases });
}
