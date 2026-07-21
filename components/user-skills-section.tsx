"use client";

import { useEffect, useRef, useState } from "react";

import { buildSkillFormData } from "@/components/skill-upload";

type CatalogSkillEntry = {
  name: string;
  description: string | null;
};

export type UserSkillEntry = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

// Personal agent-skill library, rendered inside the AI-credentials panel.
// Skills marked as default are copied into every document the user creates;
// any skill can also be attached to individual documents via the document's
// Skills menu. State is owned by the parent so it loads with the panel.
export function UserSkillsSection({
  skills,
  onSkillsChanged
}: {
  skills: UserSkillEntry[];
  onSkillsChanged: (skills: UserSkillEntry[]) => void;
}) {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkillEntry[]>([]);

  // Curated one-click catalog; a fetch failure simply hides the section.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/skill-catalog", { cache: "no-store" });
        const data = await response.json().catch(() => null);
        if (!cancelled && response.ok) setCatalog(data?.skills ?? []);
      } catch {
        // ignore — catalog is optional
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInstallFromCatalog(catalogName: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogName })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to install skill.");
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    const response = await fetch("/api/user/skills", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      onSkillsChanged(data?.skills ?? []);
    }
  }

  async function handleUpload(files: File[]) {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user/skills", {
        method: "POST",
        body: buildSkillFormData(files)
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to upload skill.");
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleDefault(skill: UserSkillEntry) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/user/skills/${skill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: !skill.isDefault })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to update skill.");
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(skill: UserSkillEntry) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/user/skills/${skill.id}`, { method: "DELETE" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Failed to delete skill.");
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="credentials-section">
      <strong className="credentials-section-title">Agent skills</strong>
      <p>
        Reusable skills (folders with a <code>SKILL.md</code>) for the agents working on your
        documents. Skills marked <em>default</em> are added to every document you create; any
        skill can be attached to a single document via its Skills menu.
      </p>

      {skills.length > 0 ? (
        <div className="env-var-list">
          {skills.map((skill) => (
            <div className="env-var-row skill-row" key={skill.id}>
              <span className="env-var-key">{skill.name}</span>
              <span className="env-var-value" title={skill.description ?? undefined}>
                {skill.description ?? "No description"}
              </span>
              <label className="skill-default-toggle">
                <input
                  checked={skill.isDefault}
                  disabled={busy}
                  onChange={() => handleToggleDefault(skill)}
                  type="checkbox"
                />
                default
              </label>
              <button
                aria-label={`Delete skill ${skill.name}`}
                className="env-var-delete"
                disabled={busy}
                onClick={() => handleDelete(skill)}
                title="Delete"
                type="button"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="env-empty">No skills uploaded.</div>
      )}

      {catalog.filter((entry) => !skills.some((skill) => skill.name === entry.name)).length > 0 ? (
        <div className="env-var-list">
          <strong className="credentials-section-title">Skill catalog</strong>
          {catalog
            .filter((entry) => !skills.some((skill) => skill.name === entry.name))
            .map((entry) => (
              <div className="env-var-row" key={`catalog-${entry.name}`}>
                <span className="env-var-key">{entry.name}</span>
                <span className="env-var-value" title={entry.description ?? undefined}>
                  {entry.description ?? "No description"}
                </span>
                <button
                  className="ghost-button"
                  disabled={busy}
                  onClick={() => handleInstallFromCatalog(entry.name)}
                  type="button"
                >
                  Install
                </button>
              </div>
            ))}
        </div>
      ) : null}

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

      {error ? <p className="env-note env-note-error">{error}</p> : null}
    </section>
  );
}
