import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import {
  deleteUserCredential,
  getUserCredentialMasked,
  normalizeCredentialInput,
  upsertUserCredential
} from "@/lib/user-credentials";

export const runtime = "nodejs";

// Per-user Anthropic credential connected once and inherited by every document
// the user owns. Mirrors the document environment route: values are write-only
// over the API — listed back masked, never in full.

const upsertSchema = z.object({
  kind: z.enum(["api_key", "oauth"]).optional().nullable(),
  value: z.string().min(1).max(8192),
  label: z.string().max(128).optional().nullable()
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const credential = await getUserCredentialMasked(user.id);
  return NextResponse.json({ credential });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid credential payload." }, { status: 400 });
  }

  let normalized;
  try {
    normalized = normalizeCredentialInput({
      kind: parsed.data.kind ?? null,
      value: parsed.data.value
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid credential." },
      { status: 400 }
    );
  }

  try {
    await upsertUserCredential(user.id, normalized, parsed.data.label ?? null);
  } catch (error) {
    // Most likely CREDENTIAL_ENCRYPTION_KEY is missing/malformed on the server.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to store credential." },
      { status: 500 }
    );
  }

  const credential = await getUserCredentialMasked(user.id);
  return NextResponse.json({ ok: true, credential });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  await deleteUserCredential(user.id);
  return NextResponse.json({ ok: true, credential: null });
}
