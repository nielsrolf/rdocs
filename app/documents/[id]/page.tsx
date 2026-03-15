import { notFound, redirect } from "next/navigation";

import { DocumentWorkspace } from "@/components/document-workspace";
import { getCurrentUser } from "@/lib/auth";
import { parseDocumentContent } from "@/lib/content";
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
    db.commentThread.findMany({
      where: { documentId: id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        anchorText: true,
        anchorContext: true,
        fromPos: true,
        toPos: true,
        status: true,
        createdAt: true,
        createdBy: {
          select: {
            id: true,
            name: true
          }
        },
        comments: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            body: true,
            aiModel: true,
            createdAt: true,
            author: {
              select: {
                id: true,
                name: true
              }
            }
          }
        }
      }
    }),
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

  return (
    <main className="document-page-shell">
      <DocumentWorkspace
        currentUserId={user?.id ?? null}
        currentUserName={user?.name ?? "Guest"}
        documentId={access.document.id}
        initialContent={parseDocumentContent(access.document.content)}
        initialPermission={access.permission}
        initialShareLinks={normalizedShareLinks}
        initialMembers={normalizedMembers}
        initialThreads={normalizedThreads}
        initialTitle={access.document.title}
        isAuthenticated={Boolean(user)}
        isOwner={user?.id === access.document.ownerId}
        shareToken={access.shareToken}
        viaShareLink={access.viaShareLink}
      />
      {access.permission !== "EDIT" && (
        <div className="read-only-banner">
          {access.permission === "COMMENT"
            ? "You can comment, but not edit, in this document."
            : "This share link is view-only."}
        </div>
      )}
    </main>
  );
}
