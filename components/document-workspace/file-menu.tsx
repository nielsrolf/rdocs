"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { formatDateTime, truncate } from "@/lib/utils";

type RecentDoc = {
  id: string;
  title: string;
  updatedAt: string;
  source: "owned" | "shared";
};

export function FileMenu({
  currentDocumentId,
  onOpenVersionHistory
}: {
  currentDocumentId: string;
  onOpenVersionHistory: () => void;
}) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [recent, setRecent] = useState<RecentDoc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function loadRecent() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/documents", { cache: "no-store" });
      if (!response.ok) {
        setError("Failed to load documents.");
        return;
      }
      const data = (await response.json()) as { documents: RecentDoc[] };
      setRecent(data.documents);
    } catch {
      setError("Failed to load documents.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const node = detailsRef.current;
    if (!node) return;
    const handler = () => {
      if (node.open && recent === null && !loading) {
        void loadRecent();
      }
    };
    node.addEventListener("toggle", handler);
    return () => node.removeEventListener("toggle", handler);
  }, [recent, loading]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const response = await fetch("/api/documents", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.id) {
        router.push(`/documents/${data.id}`);
        return;
      }
      setError("Failed to create document.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <details className="header-menu header-menu-file" ref={detailsRef}>
      <summary>File</summary>
      <div className="header-menu-panel file-menu-panel">
        <button
          className="file-menu-item file-menu-item-primary"
          disabled={creating}
          onClick={handleCreate}
          type="button"
        >
          <span className="file-menu-item-label">{creating ? "Creating..." : "New document"}</span>
          <span className="file-menu-item-hint">Blank</span>
        </button>
        <Link className="file-menu-item" href="/dashboard">
          <span className="file-menu-item-label">All documents</span>
          <span className="file-menu-item-hint">Dashboard</span>
        </Link>
        <button
          className="file-menu-item"
          onClick={() => {
            if (detailsRef.current) detailsRef.current.open = false;
            onOpenVersionHistory();
          }}
          type="button"
        >
          <span className="file-menu-item-label">Version history</span>
          <span className="file-menu-item-hint">This doc</span>
        </button>
        <div className="file-menu-section-label">Recent</div>
        <div className="file-menu-list">
          {loading ? (
            <div className="file-menu-empty">Loading...</div>
          ) : error ? (
            <div className="file-menu-empty">{error}</div>
          ) : recent && recent.length > 0 ? (
            recent
              .filter((doc) => doc.id !== currentDocumentId)
              .map((doc) => (
                <Link className="file-menu-item" href={`/documents/${doc.id}`} key={doc.id}>
                  <span className="file-menu-item-label">{truncate(doc.title || "Untitled", 48)}</span>
                  <span className="file-menu-item-hint">
                    {doc.source === "shared" ? "Shared • " : ""}
                    {formatDateTime(doc.updatedAt)}
                  </span>
                </Link>
              ))
          ) : recent ? (
            <div className="file-menu-empty">No other documents yet.</div>
          ) : null}
        </div>
      </div>
    </details>
  );
}
