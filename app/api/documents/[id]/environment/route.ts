import { NextResponse } from "next/server";
import { z } from "zod";

import { isValidEnvKey } from "@/lib/agent-env";
import { getCurrentUser } from "@/lib/auth";
import {
  deleteDocumentEnv,
  listDocumentEnvMasked,
  upsertDocumentEnv
} from "@/lib/document-env";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const upsertSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(8192),
  shareToken: z.string().optional().nullable()
});

const deleteSchema = z.object({
  key: z.string().min(1).max(128),
  shareToken: z.string().optional().nullable()
});

// Only contributors with edit access may read (even masked) or change the
// document's environment — these are secrets, so view/comment access is not
// enough.
async function requireEditAccess(id: string, shareToken: string | null) {
  const user = await getCurrentUser();
  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return { error: NextResponse.json({ error: "Document not found." }, { status: 404 }) };
  }
  if (!canEdit(access.permission)) {
    return { error: NextResponse.json({ error: "You do not have edit access." }, { status: 403 }) };
  }
  return { access };
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const shareToken = new URL(request.url).searchParams.get("share");
  const { error } = await requireEditAccess(id, shareToken);
  if (error) return error;

  const vars = await listDocumentEnvMasked(id);
  return NextResponse.json({ vars });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid environment variable payload." }, { status: 400 });
  }

  const { error } = await requireEditAccess(id, parsed.data.shareToken ?? null);
  if (error) return error;

  const key = parsed.data.key.trim();
  if (!isValidEnvKey(key)) {
    return NextResponse.json(
      { error: "Key must start with a letter or underscore and contain only letters, digits, and underscores." },
      { status: 400 }
    );
  }

  await upsertDocumentEnv(id, key, parsed.data.value);
  const vars = await listDocumentEnvMasked(id);
  return NextResponse.json({ ok: true, vars });
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { error } = await requireEditAccess(id, parsed.data.shareToken ?? null);
  if (error) return error;

  await deleteDocumentEnv(id, parsed.data.key.trim());
  const vars = await listDocumentEnvMasked(id);
  return NextResponse.json({ ok: true, vars });
}
