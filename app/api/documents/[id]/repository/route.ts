import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkRepoAccess } from "@/lib/github-access";
import { resolveGithubAuthForDocument } from "@/lib/github-auth";
import { canEdit, resolveDocumentAccess } from "@/lib/permissions";
import { getWorkspacePath } from "@/lib/research-workspace";

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

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => null);
  const parsed = repositorySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid repository payload." }, { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, null);
  if (!access || !canEdit(access.permission)) {
    return NextResponse.json({ error: "You do not have edit access." }, { status: 403 });
  }

  const repoUrl = parsed.data.repoUrl?.trim() || null;
  const repoBranch = parsed.data.repoBranch?.trim() || null;

  if (
    repoUrl &&
    // SSH URLs are rejected: SSH would authenticate with the host's own keys,
    // which per-user tokens can't scope. HTTPS + PAT is the supported path.
    !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/.test(repoUrl) &&
    !/^https:\/\/huggingface\.co\/(?:datasets\/|spaces\/)?[^/\s]+\/[^/\s]+(?:\.git)?$/.test(repoUrl)
  ) {
    return NextResponse.json(
      {
        error:
          "Use a GitHub HTTPS URL (https://github.com/owner/repo) or a HuggingFace repository URL (https://huggingface.co/datasets/owner/name)."
      },
      { status: 400 }
    );
  }

  // Verify the credential this document's git ops will actually run under
  // (doc env → linking user's PAT → owner PAT → allowlisted host) can reach
  // the repo before the first agent run trips on it. Also auto-accepts a
  // pending collaborator invitation for exactly this repo, so "invite the
  // account, press Save again" is the whole fix flow.
  const githubAuth = repoUrl ? await resolveGithubAuthForDocument(id, user?.id ?? null) : null;
  const repoAccess = repoUrl ? await checkRepoAccess(repoUrl, githubAuth?.token ?? null) : null;
  const accessPayload = repoAccess
    ? { ...repoAccess, tokenSource: githubAuth?.source ?? ("none" as const) }
    : null;
  if (accessPayload && accessPayload.reason !== "not-github") {
    console.log(
      "[repo-access]",
      JSON.stringify({
        documentId: id,
        userId: user?.id ?? null,
        repoUrl,
        ok: accessPayload.ok,
        reason: accessPayload.reason,
        canPush: accessPayload.canPush,
        acceptedInvitation: accessPayload.acceptedInvitation,
        login: accessPayload.login,
        tokenSource: accessPayload.tokenSource
      })
    );
  }

  const updated = await db.document.update({
    where: { id },
    data: {
      repoUrl,
      repoBranch,
      repoWorkspace: repoUrl ? getWorkspacePath(id, repoUrl) : null
    },
    select: {
      repoUrl: true,
      repoBranch: true
    }
  });

  return NextResponse.json({ repository: updated, access: accessPayload });
}
