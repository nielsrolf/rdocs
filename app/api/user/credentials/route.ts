import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import {
  deleteUserCredential,
  getUserCredentialsMasked,
  normalizeCredentialInput,
  upsertUserCredential
} from "@/lib/user-credentials";

export const runtime = "nodejs";

// Per-user AI credentials (at most one per provider) connected once and
// inherited by every document the user owns. Mirrors the document environment
// route: values are write-only over the API — listed back masked, never in
// full.

const providerSchema = z.enum(["anthropic", "openai", "openrouter", "litellm", "github"]);

const upsertSchema = z.object({
  provider: providerSchema.optional().nullable(),
  kind: z.enum(["api_key", "oauth"]).optional().nullable(),
  value: z.string().min(1).max(8192),
  label: z.string().max(128).optional().nullable()
});

const deleteSchema = z.object({
  provider: providerSchema.optional().nullable()
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const credentials = await getUserCredentialsMasked(user.id);
  return NextResponse.json({ credentials });
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
      provider: parsed.data.provider ?? null,
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

  const credentials = await getUserCredentialsMasked(user.id);
  return NextResponse.json({ ok: true, credentials });
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid provider." }, { status: 400 });
  }
  await deleteUserCredential(user.id, parsed.data.provider ?? "anthropic");
  const credentials = await getUserCredentialsMasked(user.id);
  return NextResponse.json({ ok: true, credentials });
}
