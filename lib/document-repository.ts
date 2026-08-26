import { db } from "@/lib/db";
import { checkRepoAccess, type RepoAccessResult } from "@/lib/github-access";
import { resolveGithubAuthForDocument, type GithubAuthSource } from "@/lib/github-auth";
import { getWorkspacePath } from "@/lib/research-workspace";

export class DocumentRepositoryError extends Error {}

export type DocumentRepositoryAccess = RepoAccessResult & {
  tokenSource: GithubAuthSource | "none";
};

function unwrapSlackLink(value: string) {
  const match = value.match(/^<([^|>]+)(?:\|[^>]*)?>$/);
  return match?.[1] ?? value;
}

export function normalizeRepositoryUrl(value: string | null | undefined) {
  const raw = unwrapSlackLink(value?.trim() ?? "");
  if (!raw || raw.toLowerCase() === "none") return null;
  return raw.replace(/^http:\/\/(github\.com|huggingface\.co)\//i, "https://$1/");
}

export function normalizeRepositoryBranch(value: string | null | undefined) {
  return value?.trim() || null;
}

export function validateRepositoryInput(repoUrl: string | null, repoBranch: string | null) {
  if (repoUrl && repoUrl.length > 500) {
    throw new DocumentRepositoryError("Repository URL is too long (max 500 characters).");
  }
  if (repoBranch && repoBranch.length > 120) {
    throw new DocumentRepositoryError("Branch name is too long (max 120 characters).");
  }
  if (
    repoUrl &&
    !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/.test(repoUrl) &&
    !/^https:\/\/huggingface\.co\/(?:datasets\/|spaces\/)?[^/\s]+\/[^/\s]+(?:\.git)?$/.test(repoUrl)
  ) {
    throw new DocumentRepositoryError(
      "Use a GitHub HTTPS URL (https://github.com/owner/repo) or a HuggingFace repository URL " +
        "(https://huggingface.co/datasets/owner/name)."
    );
  }
  if (repoBranch && !/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(repoBranch)) {
    throw new DocumentRepositoryError("Branch name contains unsupported characters.");
  }
}

export async function setDocumentRepository(input: {
  documentId: string;
  userId: string | null;
  repoUrl: string | null;
  repoBranch: string | null;
}) {
  validateRepositoryInput(input.repoUrl, input.repoBranch);
  const githubAuth = input.repoUrl
    ? await resolveGithubAuthForDocument(input.documentId, input.userId)
    : null;
  const repoAccess = input.repoUrl
    ? await checkRepoAccess(input.repoUrl, githubAuth?.token ?? null)
    : null;
  const access: DocumentRepositoryAccess | null = repoAccess
    ? { ...repoAccess, tokenSource: githubAuth?.source ?? "none" }
    : null;

  if (access && access.reason !== "not-github") {
    console.log(
      "[repo-access]",
      JSON.stringify({
        documentId: input.documentId,
        userId: input.userId,
        repoUrl: input.repoUrl,
        ok: access.ok,
        reason: access.reason,
        canPush: access.canPush,
        acceptedInvitation: access.acceptedInvitation,
        login: access.login,
        tokenSource: access.tokenSource
      })
    );
  }

  const repository = await db.document.update({
    where: { id: input.documentId },
    data: {
      repoUrl: input.repoUrl,
      repoBranch: input.repoUrl ? input.repoBranch : null,
      repoWorkspace: input.repoUrl ? getWorkspacePath(input.documentId, input.repoUrl) : null,
      ...(input.repoUrl ? { workspaceDocumentId: null } : {})
    },
    select: { repoUrl: true, repoBranch: true }
  });
  return { repository, access };
}
