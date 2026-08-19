"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { formatDateTime, permissionLabel, truncate } from "@/lib/utils";

export type DashboardDoc = {
  id: string;
  title: string;
  kind: string;
  updatedAt: string;
  isOwner: boolean;
  ownerId: string;
  ownerName: string;
  permission: string;
  unreadCount: number;
  mentionCount: number;
  lastCommentAt: string | null;
};

type SortKey = "updated" | "unread" | "title";

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "updated", label: "Recently updated" },
  { value: "unread", label: "New comments" },
  { value: "title", label: "Title" }
];

export function DocumentList({
  documents
}: {
  documents: DashboardDoc[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filteredSorted = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? documents.filter(
          (d) =>
            d.title.toLowerCase().includes(needle) ||
            d.ownerName.toLowerCase().includes(needle)
        )
      : documents.slice();

    const updatedMs = (value: string) => new Date(value).getTime();
    const lastSignal = (d: DashboardDoc) =>
      Math.max(
        updatedMs(d.updatedAt),
        d.lastCommentAt ? updatedMs(d.lastCommentAt) : 0
      );

    filtered.sort((a, b) => {
      if (sort === "title") {
        return a.title.localeCompare(b.title);
      }
      if (sort === "unread") {
        if (a.unreadCount !== b.unreadCount) {
          return b.unreadCount - a.unreadCount;
        }
        return lastSignal(b) - lastSignal(a);
      }
      return lastSignal(b) - lastSignal(a);
    });

    return filtered;
  }, [documents, query, sort]);

  async function handleDelete(doc: DashboardDoc) {
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
      <div className="dashboard-toolbar">
        <input
          className="dashboard-search-input"
          type="search"
          placeholder="Search documents..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search documents"
        />
        <label className="dashboard-sort">
          <span>Sort by</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="dashboard-list surface-card">
        <div className="doc-list">
          {filteredSorted.length === 0 ? (
            <div className="empty-state">
              <p>{query.trim() ? "No matches." : "No documents yet."}</p>
            </div>
          ) : (
            filteredSorted.map((document) => {
              const ownerLabel = document.isOwner
                ? "You"
                : document.ownerName;
              const pillLabel = document.isOwner
                ? "Owner"
                : permissionLabel(document.permission);
              return (
                <div
                  className={`doc-row doc-row-unified${
                    document.unreadCount > 0 || document.mentionCount > 0 ? " doc-row-has-unread" : ""
                  }`}
                  key={document.id}
                >
                  <Link className="doc-row-main" href={`/documents/${document.id}`}>
                    <div className="doc-row-text">
                      <strong>{truncate(document.title, 80)}</strong>
                      <span className="doc-row-meta">
                        <span className="doc-row-owner">{ownerLabel}</span>
                        <span aria-hidden="true">•</span>
                        <span>Updated {formatDateTime(document.updatedAt)}</span>
                      </span>
                    </div>
                    <div className="doc-row-aside">
                      {document.kind === "slack_channel" ? (
                        <span className="slack-pill" title="Backed by a Slack channel — the claudex bot's per-channel workspace and config">
                          Slack
                        </span>
                      ) : null}
                      {document.mentionCount > 0 ? (
                        <span
                          className="mention-badge"
                          title={`${document.mentionCount} unacknowledged mention${
                            document.mentionCount === 1 ? "" : "s"
                          }`}
                        >
                          @ {document.mentionCount}
                        </span>
                      ) : null}
                      {document.unreadCount > 0 ? (
                        <span
                          className="unread-badge"
                          title={`${document.unreadCount} unread comment${
                            document.unreadCount === 1 ? "" : "s"
                          }`}
                        >
                          {document.unreadCount} new
                        </span>
                      ) : null}
                      <span className="permission-pill">{pillLabel}</span>
                    </div>
                  </Link>
                  {document.isOwner ? (
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
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>
    </>
  );
}
