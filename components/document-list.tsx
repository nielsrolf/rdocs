"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { formatDateTime, permissionLabel, truncate } from "@/lib/utils";

type OwnedDoc = {
  id: string;
  title: string;
  updatedAt: string;
};

type SharedDoc = {
  id: string;
  title: string;
  updatedAt: string;
  ownerName: string;
  permission: string;
};

export function DocumentList({
  ownedDocuments,
  sharedDocuments
}: {
  ownedDocuments: OwnedDoc[];
  sharedDocuments: SharedDoc[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const filteredOwned = useMemo(
    () => (needle ? ownedDocuments.filter((d) => d.title.toLowerCase().includes(needle)) : ownedDocuments),
    [ownedDocuments, needle]
  );
  const filteredShared = useMemo(
    () =>
      needle
        ? sharedDocuments.filter(
            (d) => d.title.toLowerCase().includes(needle) || d.ownerName.toLowerCase().includes(needle)
          )
        : sharedDocuments,
    [sharedDocuments, needle]
  );

  async function handleDelete(doc: OwnedDoc) {
    const ok = window.confirm(`Delete "${doc.title}"? This cannot be undone.`);
    if (!ok) return;
    setDeletingId(doc.id);
    try {
      const response = await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        window.alert(data?.error ?? "Failed to delete document.");
        return;
      }
      router.refresh();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <div className="dashboard-search">
        <input
          type="search"
          placeholder="Search documents..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search documents"
        />
      </div>
      <section className="dashboard-grid">
        <div className="surface-card">
          <div className="section-heading">
            <h2>Owned by you</h2>
          </div>
          <div className="doc-list">
            {filteredOwned.length === 0 ? (
              <div className="empty-state">
                <p>{needle ? "No matches." : "No documents yet."}</p>
              </div>
            ) : (
              filteredOwned.map((document) => (
                <div className="doc-row doc-row-deletable" key={document.id}>
                  <Link className="doc-row-main" href={`/documents/${document.id}`}>
                    <div>
                      <strong>{truncate(document.title, 60)}</strong>
                      <span>Updated {formatDateTime(document.updatedAt)}</span>
                    </div>
                    <span className="permission-pill">Owner</span>
                  </Link>
                  <button
                    aria-label={`Delete ${document.title}`}
                    className="doc-row-delete"
                    disabled={deletingId === document.id}
                    onClick={() => handleDelete(document)}
                    title="Delete document"
                    type="button"
                  >
                    {deletingId === document.id ? "..." : "✕"}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="surface-card">
          <div className="section-heading">
            <h2>Shared with you</h2>
          </div>
          <div className="doc-list">
            {filteredShared.length === 0 ? (
              <div className="empty-state">
                <p>{needle ? "No matches." : "No shared documents yet."}</p>
              </div>
            ) : (
              filteredShared.map((document) => (
                <Link className="doc-row" href={`/documents/${document.id}`} key={document.id}>
                  <div>
                    <strong>{truncate(document.title, 60)}</strong>
                    <span>
                      Shared by {document.ownerName} • Updated {formatDateTime(document.updatedAt)}
                    </span>
                  </div>
                  <span className="permission-pill">{permissionLabel(document.permission)}</span>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>
    </>
  );
}
