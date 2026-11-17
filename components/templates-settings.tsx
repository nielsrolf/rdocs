"use client";

import Link from "next/link";
import { useState } from "react";

import { saveTemplateStatus } from "@/components/template-offers";

type TemplateRow = {
  id: string;
  title: string;
  ownerName: string;
  isOwner: boolean;
  status: "added" | "dismissed" | null;
};

// Settings → Templates: which templates show up under "New document".
export function TemplatesSettings({ initialTemplates }: { initialTemplates: TemplateRow[] }) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(template: TemplateRow, status: "added" | "dismissed") {
    setBusyId(template.id);
    setError(null);
    const ok = await saveTemplateStatus(template.id, status).catch(() => false);
    setBusyId(null);
    if (!ok) {
      setError("Could not save. The template may no longer be shared with you — reload the page.");
      return;
    }
    setTemplates((current) =>
      current.map((entry) => (entry.id === template.id ? { ...entry, status } : entry))
    );
  }

  const added = templates.filter((template) => template.status === "added");
  const available = templates.filter((template) => template.status !== "added");

  const row = (template: TemplateRow) => (
    <div className="env-var-row template-row" key={template.id}>
      <Link className="template-row-title" href={`/documents/${template.id}`}>
        {template.title || "Untitled"}
      </Link>
      <span className="env-var-value">{template.isOwner ? "Yours" : `By ${template.ownerName}`}</span>
      <button
        className="ghost-button"
        disabled={busyId === template.id}
        onClick={() => void setStatus(template, template.status === "added" ? "dismissed" : "added")}
        type="button"
      >
        {template.status === "added" ? "Remove" : "Add"}
      </button>
    </div>
  );

  return (
    <>
      <section className="credentials-section">
        <strong className="credentials-section-title">Your templates</strong>
        <p className="muted-copy">
          These are offered whenever you click “New document”. Removing one only takes it out of your
          list; the document itself is not touched.
        </p>
        <div className="env-var-list">
          {added.length > 0 ? added.map(row) : <div className="env-empty">No templates in your list.</div>}
        </div>
      </section>
      <section className="credentials-section">
        <strong className="credentials-section-title">Available templates</strong>
        <p className="muted-copy">
          Templates you removed or declined, and templates of people who shared the document with you.
        </p>
        <div className="env-var-list">
          {available.length > 0 ? (
            available.map(row)
          ) : (
            <div className="env-empty">Nothing else is available.</div>
          )}
        </div>
        {error ? <span className="subtle-pill env-error">{error}</span> : null}
      </section>
    </>
  );
}
