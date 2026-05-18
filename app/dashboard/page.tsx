import Link from "next/link";
import { redirect } from "next/navigation";

import { NewDocumentButton } from "@/components/new-document-button";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime, permissionLabel, truncate } from "@/lib/utils";

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

      <section className="dashboard-grid">
        <div className="surface-card">
          <div className="section-heading">
            <h2>Owned by you</h2>
          </div>
          <div className="doc-list">
            {ownedDocuments.length === 0 ? (
              <div className="empty-state">
                <p>No documents yet.</p>
              </div>
            ) : (
              ownedDocuments.map((document) => (
                <Link className="doc-row" href={`/documents/${document.id}`} key={document.id}>
                  <div>
                    <strong>{truncate(document.title, 60)}</strong>
                    <span>Updated {formatDateTime(document.updatedAt)}</span>
                  </div>
                  <span className="permission-pill">Owner</span>
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="surface-card">
          <div className="section-heading">
            <h2>Shared with you</h2>
          </div>
          <div className="doc-list">
            {sharedDocuments.length === 0 ? (
              <div className="empty-state">
                <p>No shared documents yet.</p>
              </div>
            ) : (
              sharedDocuments.map(({ document, permission }) => (
                <Link className="doc-row" href={`/documents/${document.id}`} key={document.id}>
                  <div>
                    <strong>{truncate(document.title, 60)}</strong>
                    <span>
                      Shared by {document.owner.name} • Updated {formatDateTime(document.updatedAt)}
                    </span>
                  </div>
                  <span className="permission-pill">{permissionLabel(permission)}</span>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
