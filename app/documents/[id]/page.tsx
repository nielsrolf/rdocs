import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DocumentWorkspace } from "@/components/document-workspace";
import { getCurrentUser } from "@/lib/auth";
import { listDocumentThreads } from "@/lib/document-data";
import { parseDocumentContent } from "@/lib/content";
import { getCollaborationVersion } from "@/lib/collaboration";
import { PermissionLevelValue, ThreadStatusValue } from "@/lib/contracts";
import { db } from "@/lib/db";
import { resolveDocumentAccess } from "@/lib/permissions";

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
  const normalizedShareLinks = shareLinks.map((link) => ({
    ...link,
    permission: link.permission as PermissionLevelValue
  }));
  const normalizedMembers = members.map((member) => ({
    ...member,
    permission: member.permission as PermissionLevelValue
  }));
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
        initialRepoBranch={access.document.repoBranch}
        initialRepoUrl={access.document.repoUrl}
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
