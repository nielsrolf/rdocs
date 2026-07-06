import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { DocumentWorkspace } from "@/components/document-workspace";
import { getCurrentUser } from "@/lib/auth";
import { listDocumentThreads } from "@/lib/document-data";
import {
  acknowledgeDocumentMentions,
  listUnacknowledgedMentionCommentIds,
  loadMentionCandidates
} from "@/lib/mention-data";
import { parseDocumentContent } from "@/lib/content";
import { getCollaborationVersion } from "@/lib/collaboration";
import { hasDocumentEnvKey } from "@/lib/document-env";
import { PermissionLevelValue, ThreadStatusValue } from "@/lib/contracts";
import { db } from "@/lib/db";
import { resolveDocumentAccess } from "@/lib/permissions";
import { hasUserCredential } from "@/lib/user-credentials";
import { getPublicOrigin } from "@/lib/request-origin";

type PageProps = {
  params: Promise<{
    id: string;
  }>;
  searchParams?: Promise<{
    share?: string;
  }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const doc = await db.document.findUnique({
    where: { id },
    select: { title: true }
  });
  const title = doc?.title?.trim();
  return { title: title ? `${title} — r-docs` : "r-docs" };
}

export default async function DocumentPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const user = await getCurrentUser();
  const shareToken = resolvedSearchParams?.share ?? null;

  if (!user && !shareToken) {
    redirect("/sign-in");
  }

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    notFound();
  }

  // The list of who can be @mentioned (owner + collaborators) is shown to every
  // viewer for autocomplete + highlighting.
  const mentionMembers = await loadMentionCandidates(id);

  // Capture which comments mention the current user BEFORE acknowledging, so we
  // can deep-link + flash-highlight them, then clear the dashboard badge.
  let initialMentionedCommentIds: string[] = [];
  if (user) {
    initialMentionedCommentIds = await listUnacknowledgedMentionCommentIds(user.id, id).catch(
      () => []
    );
    // Fire-and-forget so it never blocks the page render.
    void acknowledgeDocumentMentions(user.id, id).catch(() => undefined);
  }

  const [threads, shareLinks, members] = await Promise.all([
    listDocumentThreads(id, user?.id ?? null),
    user && access.document.ownerId === user.id
      ? db.shareLink.findMany({
          where: {
            documentId: id,
            revokedAt: null
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            token: true,
            permission: true,
            createdAt: true
          }
        })
      : Promise.resolve([]),
    user && access.document.ownerId === user.id
      ? db.documentMembership.findMany({
          where: {
            documentId: id
          },
          orderBy: {
            createdAt: "asc"
          },
          select: {
            id: true,
            permission: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true
              }
            }
          }
        })
      : Promise.resolve([])
  ]);

  const normalizedThreads = threads.map((thread) => ({
    ...thread,
    status: thread.status as ThreadStatusValue
  }));
  const shareOrigin = getPublicOrigin(await headers());
  const normalizedShareLinks = shareLinks.map((link) => ({
    ...link,
    permission: link.permission as PermissionLevelValue,
    url: `${shareOrigin}/share/${link.token}`
  }));
  const normalizedMembers = members.map((member) => ({
    ...member,
    permission: member.permission as PermissionLevelValue
  }));
  // Third-party model gating: a document env key OR a per-user credential
  // that would back a run — the current viewer's (their runs bill their key)
  // or the document owner's (owner keys apply to every doc they own).
  const viewerId = user?.id && user.id !== access.document.ownerId ? user.id : null;
  const [
    envHasOpenRouterKey,
    envHasLiteLlmKey,
    ownerHasOpenRouterKeyOnly,
    ownerHasLiteLlmKeyOnly,
    viewerHasOpenRouterKey,
    viewerHasLiteLlmKey
  ] = await Promise.all([
    hasDocumentEnvKey(id, "OPENROUTER_API_KEY"),
    hasDocumentEnvKey(id, "LITELLM_API_KEY"),
    hasUserCredential(access.document.ownerId, "openrouter"),
    hasUserCredential(access.document.ownerId, "litellm"),
    viewerId ? hasUserCredential(viewerId, "openrouter") : Promise.resolve(false),
    viewerId ? hasUserCredential(viewerId, "litellm") : Promise.resolve(false)
  ]);
  const credentialHasOpenRouterKey = ownerHasOpenRouterKeyOnly || viewerHasOpenRouterKey;
  const credentialHasLiteLlmKey = ownerHasLiteLlmKeyOnly || viewerHasLiteLlmKey;
  const initialHasOpenRouterKey = envHasOpenRouterKey || credentialHasOpenRouterKey;
  const initialHasLiteLlmKey = envHasLiteLlmKey || credentialHasLiteLlmKey;
  const initialCollaborationVersion = await getCollaborationVersion(
    access.document.id,
    access.document.content,
    access.document.updatedAt
  );

  return (
    <main className="document-page-shell">
      <DocumentWorkspace
        currentUserId={user?.id ?? null}
        currentUserName={user?.name ?? "Guest"}
        documentId={access.document.id}
        initialCollaborationVersion={initialCollaborationVersion}
        initialContent={parseDocumentContent(access.document.content)}
        initialDocumentUpdatedAt={access.document.updatedAt.toISOString()}
        initialPermission={access.permission}
        initialShareLinks={normalizedShareLinks}
        initialMembers={normalizedMembers}
        mentionMembers={mentionMembers}
        initialMentionedCommentIds={initialMentionedCommentIds}
        initialRepoBranch={access.document.repoBranch}
        initialRepoUrl={access.document.repoUrl}
        initialAgentModel={access.document.agentModel}
        initialAgentEffort={access.document.agentEffort}
        initialHasOpenRouterKey={initialHasOpenRouterKey}
        initialHasLiteLlmKey={initialHasLiteLlmKey}
        credentialHasOpenRouterKey={credentialHasOpenRouterKey}
        credentialHasLiteLlmKey={credentialHasLiteLlmKey}
        initialThreads={normalizedThreads}
        initialTitle={access.document.title}
        isAuthenticated={Boolean(user)}
        isOwner={user?.id === access.document.ownerId}
        shareToken={access.shareToken}
        viaShareLink={access.viaShareLink}
      />
      {access.permission !== "EDIT" && !(access.viaShareLink && access.permission === "VIEW") && (
        <div className="read-only-banner">
          {access.permission === "COMMENT"
            ? "You can comment, but not edit, in this document."
            : "This share link is view-only."}
        </div>
      )}
    </main>
  );
}
