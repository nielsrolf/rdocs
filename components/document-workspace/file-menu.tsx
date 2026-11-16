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

type TemplateOption = { id: string; title: string; ownerName: string; isOwner: boolean; status: string | null };

export function FileMenu({
  currentDocumentId,
  onOpenVersionHistory,
  canMakeTemplate = false,
  initialIsTemplate = false
}: {
  currentDocumentId: string;
  onOpenVersionHistory: () => void;
  // Owner of a regular document: shows the "This doc is a template" toggle.
  canMakeTemplate?: boolean;
  initialIsTemplate?: boolean;
}) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [recent, setRecent] = useState<RecentDoc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [isTemplate, setIsTemplate] = useState(initialIsTemplate);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // The user's "New document" templates. Best-effort: without them the menu
  // still offers a blank document.
  async function loadTemplates() {
    try {
      const response = await fetch("/api/user/templates", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { templates: TemplateOption[] };
      setTemplates(data.templates.filter((template) => template.status === "added"));
    } catch {
      // keep whatever we had
    }
  }

  async function handleToggleTemplate() {
    if (savingTemplate) return;
    const next = !isTemplate;
    setSavingTemplate(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${currentDocumentId}/template`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isTemplate: next })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setError(typeof data?.error === "string" ? data.error : "Failed to update the template setting.");
        return;
      }
      setIsTemplate(next);
      void loadTemplates();
    } catch {
      setError("Failed to update the template setting.");
    } finally {
      setSavingTemplate(false);
    }
  }

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
        void loadTemplates();
      }
    };
    node.addEventListener("toggle", handler);
    return () => node.removeEventListener("toggle", handler);
  }, [recent, loading]);

  async function handleCreate(templateId?: string) {
    if (creating) return;
    setCreating(true);
    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        ...(templateId
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId }) }
          : {})
      });
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
          onClick={() => void handleCreate()}
          type="button"
        >
          <span className="file-menu-item-label">{creating ? "Creating..." : "New document"}</span>
          <span className="file-menu-item-hint">Blank</span>
        </button>
        {templates.map((template) => (
          <button
            className="file-menu-item"
            disabled={creating}
            key={template.id}
            onClick={() => void handleCreate(template.id)}
            type="button"
          >
            <span className="file-menu-item-label">New: {truncate(template.title || "Untitled", 40)}</span>
            <span className="file-menu-item-hint">Template</span>
          </button>
        ))}
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
        {canMakeTemplate ? (
          <button
            aria-checked={isTemplate}
            className="file-menu-item"
            disabled={savingTemplate}
            onClick={() => void handleToggleTemplate()}
            role="menuitemcheckbox"
            title="Templates show up as options under “New document”. People you share this document with are asked whether they want it in their list."
            type="button"
          >
            <span className="file-menu-item-label">This doc is a template</span>
            <span className="file-menu-item-hint">{isTemplate ? "✓ On" : "Off"}</span>
          </button>
        ) : null}
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
