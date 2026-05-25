import { redirect } from "next/navigation";

import { DocumentList } from "@/components/document-list";
import { NewDocumentButton } from "@/components/new-document-button";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/sign-in");
  }

  const [ownedDocuments, sharedDocuments] = await Promise.all([
    db.document.findMany({
      where: { ownerId: user.id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        updatedAt: true
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
            owner: {
              select: {
                name: true
              }
            }
          }
        }
      }
    })
  ]);

  const owned = ownedDocuments.map((d) => ({
    id: d.id,
    title: d.title,
    updatedAt: d.updatedAt.toISOString()
  }));
  const shared = sharedDocuments.map(({ document, permission }) => ({
    id: document.id,
    title: document.title,
    updatedAt: document.updatedAt.toISOString(),
    ownerName: document.owner.name,
    permission
  }));

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

      <DocumentList ownedDocuments={owned} sharedDocuments={shared} />
    </main>
  );
}
