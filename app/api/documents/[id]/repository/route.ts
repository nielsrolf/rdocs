import { NextResponse } from "next/server";
import { z } from "zod";

import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import {
  DocumentRepositoryError,
  normalizeRepositoryBranch,
  normalizeRepositoryUrl,
  setDocumentRepository
} from "@/lib/document-repository";

export const runtime = "nodejs";

const repositorySchema = z.object({
  repoUrl: z.string().trim().max(500).optional().nullable(),
  repoBranch: z
    .string()
    .trim()
    .max(120)
    // Restrict to a git-ref-safe charset and forbid a leading dash so the value
    // can never be interpreted as an option by the git commands it flows into
    // (clone --branch, worktree add origin/<branch>). Empty string clears it.
    .refine(
      (v) => v === "" || /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(v),
      "Branch name contains unsupported characters."
    )
    .optional()
    .nullable()
});

export async function PATCH(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = repositorySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid repository payload." }, { status: 400 });
  }

  // Share tokens deliberately don't grant repository changes.
  const gate = await requireDocumentAccess(request, id, "EDIT", { shareToken: null });
  if (!gate.ok) {
    return gate.response;
  }
  const { user } = gate;

  const repoUrl = normalizeRepositoryUrl(parsed.data.repoUrl);
  const repoBranch = normalizeRepositoryBranch(parsed.data.repoBranch);
  try {
    const result = await setDocumentRepository({
      documentId: id,
      userId: user?.id ?? null,
      repoUrl,
      repoBranch
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DocumentRepositoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
