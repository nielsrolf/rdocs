import { redirect } from "next/navigation";

import { DocumentList } from "@/components/document-list";
import { NewDocumentButton } from "@/components/new-document-button";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDocumentCommentStats } from "@/lib/document-data";
import { getDocumentMentionStats } from "@/lib/mention-data";

export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/sign-in");
  }

  const [ownedDocuments, memberships] = await Promise.all([
    db.document.findMany({
      where: { ownerId: user.id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        updatedAt: true,
        owner: { select: { id: true, name: true } }
      }
    }),
    db.documentMembership.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      select: {
        permission: true,
        document: {
          select: {
            id: true,
            title: true,
            updatedAt: true,
            owner: { select: { id: true, name: true } }
          }
        }
      }
    })
  ]);

  const docIds = [
    ...ownedDocuments.map((d) => d.id),
    ...memberships.map((m) => m.document.id)
  ];

  // Aggregated in SQL rather than loading every comment for every document.
  const [{ unreadByDoc, lastCommentByDoc }, mentionByDoc] = await Promise.all([
    getDocumentCommentStats(user.id, docIds),
    getDocumentMentionStats(user.id, docIds)
  ]);

  const owned = ownedDocuments.map((d) => ({
    id: d.id,
    title: d.title,
    updatedAt: d.updatedAt.toISOString(),
    isOwner: true,
    ownerId: d.owner.id,
    ownerName: d.owner.name,
    permission: "EDIT",
    unreadCount: unreadByDoc.get(d.id) ?? 0,
    mentionCount: mentionByDoc.get(d.id) ?? 0,
    lastCommentAt: lastCommentByDoc.get(d.id)?.toISOString() ?? null
  }));
  const shared = memberships.map(({ document, permission }) => ({
    id: document.id,
    title: document.title,
    updatedAt: document.updatedAt.toISOString(),
    isOwner: false,
    ownerId: document.owner.id,
    ownerName: document.owner.name,
    permission,
    unreadCount: unreadByDoc.get(document.id) ?? 0,
    mentionCount: mentionByDoc.get(document.id) ?? 0,
    lastCommentAt: lastCommentByDoc.get(document.id)?.toISOString() ?? null
  }));

  const documents = [...owned, ...shared];

  return (
    <main className="dashboard-shell">
      <section className="dashboard-header">
        <div>
          <span className="eyebrow">Workspace</span>
          <h1>Your documents</h1>
          <p>Create new docs, open shared work, and manage collaboration from a single dashboard.</p>
        </div>
        <NewDocumentButton />
      </section>

      <DocumentList documents={documents} currentUserId={user.id} />
    </main>
  );
}
