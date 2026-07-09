"use client";

import { useEffect, useRef, useState } from "react";

import { buildSkillFormData } from "@/components/skill-upload";

type DocumentSkillEntry = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
};

type LibrarySkillEntry = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
};

// Document-level agent skills menu (topbar). Anyone with edit access can
// attach skills — uploaded directly (a skill folder or single SKILL.md) or
// copied from their personal library (managed under AI credentials). Attached
// skills are available to every agent run on this document.
export function SkillsMenu({
  documentId,
  shareToken
}: {
  documentId: string;
  shareToken: string | null;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [skills, setSkills] = useState<DocumentSkillEntry[] | null>(null);
  const [library, setLibrary] = useState<LibrarySkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
      const response = await fetch(`/api/documents/${documentId}/skills${query}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to load skills.");
        return;
      }
      setSkills(data.skills ?? []);
      // Library is unavailable for anonymous share-link editors — that's fine.
      const libraryResponse = await fetch("/api/user/skills", { cache: "no-store" });
      const libraryData = await libraryResponse.json().catch(() => null);
      setLibrary(libraryResponse.ok ? libraryData?.skills ?? [] : []);
    } catch {
      setError("Failed to load skills.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const node = detailsRef.current;
    if (!node) return;
    const handler = () => {
      if (node.open && skills === null && !loading) {
        void load();
      }
    };
    node.addEventListener("toggle", handler);
    return () => node.removeEventListener("toggle", handler);
  }, [skills, loading]);

  async function handleUpload(files: File[]) {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const formData = buildSkillFormData(files, shareToken ? { share: shareToken } : {});
      const response = await fetch(`/api/documents/${documentId}/skills`, {
        method: "POST",
        body: formData
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to upload skill.");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleAddFromLibrary(userSkillId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userSkillId, ...(shareToken ? { share: shareToken } : {}) })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to add skill.");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(skillId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
      const response = await fetch(`/api/documents/${documentId}/skills/${skillId}${query}`, {
        method: "DELETE"
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to remove skill.");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const attachedNames = new Set((skills ?? []).map((skill) => skill.name));
  const addableLibrary = library.filter((skill) => !attachedNames.has(skill.name));

  return (
    <details className="header-menu header-menu-env" ref={detailsRef}>
      <summary>Skills</summary>
      <div className="header-menu-panel env-panel">
        <div>
          <strong>Agent skills</strong>
          <p>
            Skills (folders with a <code>SKILL.md</code>) that agents can use on this document.
            Upload a skill folder or a single <code>SKILL.md</code>, or add one from your library
            under <em>AI credentials</em>.
          </p>
        </div>

        <div className="env-var-list">
          {loading ? (
            <div className="env-empty">Loading…</div>
          ) : skills && skills.length > 0 ? (
            skills.map((skill) => (
              <div className="env-var-row" key={skill.id}>
                <span className="env-var-key">{skill.name}</span>
                <span className="env-var-value" title={skill.description ?? undefined}>
                  {skill.description ?? "No description"}
                </span>
                <button
                  aria-label={`Remove skill ${skill.name}`}
                  className="env-var-delete"
                  disabled={busy}
                  onClick={() => handleDelete(skill.id)}
                  title="Remove"
                  type="button"
                >
                  ✕
                </button>
              </div>
            ))
          ) : skills ? (
            <div className="env-empty">No skills attached.</div>
          ) : null}
        </div>

        <div className="credentials-actions">
          <button
            className="ghost-button"
            disabled={busy}
            onClick={() => folderInputRef.current?.click()}
            type="button"
          >
            {busy ? "Working…" : "Upload skill folder"}
          </button>
          <button
            className="ghost-button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            Upload SKILL.md
          </button>
        </div>

        {addableLibrary.length > 0 ? (
          <div className="env-var-list">
            {addableLibrary.map((skill) => (
              <div className="env-var-row" key={skill.id}>
                <span className="env-var-key">{skill.name}</span>
                <span className="env-var-value" title={skill.description ?? undefined}>
                  from your library
                </span>
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() => handleAddFromLibrary(skill.id)}
                  type="button"
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <input
          hidden
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void handleUpload(files);
          }}
          ref={folderInputRef}
          type="file"
          // Non-standard but universally supported directory picker.
          {...({ webkitdirectory: "" } as Record<string, string>)}
        />
        <input
          accept=".md"
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void handleUpload(files);
          }}
          ref={fileInputRef}
          type="file"
        />

        {error ? <span className="subtle-pill env-error">{error}</span> : null}
      </div>
    </details>
  );
}
