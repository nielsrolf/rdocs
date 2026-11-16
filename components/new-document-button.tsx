"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { TEMPLATES_CHANGED_EVENT } from "@/components/template-offers";

type TemplateOption = { id: string; title: string; ownerName: string; isOwner: boolean; status: string | null };

// "New document". With no templates in the user's list it creates a blank
// document right away (as it always did); with templates it opens a small
// menu: Blank document + one entry per template.
export function NewDocumentButton() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    try {
      const response = await fetch("/api/user/templates", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { templates: TemplateOption[] };
      setTemplates(data.templates.filter((template) => template.status === "added"));
    } catch {
      // No templates is a fine fallback: the button still creates a blank doc.
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
    const reload = () => void loadTemplates();
    window.addEventListener(TEMPLATES_CHANGED_EVENT, reload);
    return () => window.removeEventListener(TEMPLATES_CHANGED_EVENT, reload);
  }, [loadTemplates]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  async function handleCreate(templateId?: string) {
    setIsCreating(true);
    setError(null);
    const response = await fetch("/api/documents", {
      method: "POST",
      ...(templateId
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId }) }
        : {})
    }).catch(() => null);

    const data = response ? await response.json().catch(() => null) : null;

    if (response?.ok && data?.id) {
      router.push(`/documents/${data.id}`);
      router.refresh();
      return;
    }

    setError(typeof data?.error === "string" ? data.error : "Could not create the document.");
    setIsCreating(false);
    // A template that vanished (unshared, unmarked) should drop out of the menu.
    if (templateId) void loadTemplates();
  }

  const hasTemplates = templates.length > 0;

  return (
    <div className="new-document" ref={rootRef}>
      <button
        aria-expanded={hasTemplates ? menuOpen : undefined}
        aria-haspopup={hasTemplates ? "menu" : undefined}
        className="primary-button"
        data-tour="new-doc"
        disabled={isCreating}
        onClick={() => (hasTemplates ? setMenuOpen((open) => !open) : void handleCreate())}
        type="button"
      >
        {isCreating ? "Creating..." : hasTemplates ? "New document ▾" : "New document"}
      </button>
      {hasTemplates && menuOpen ? (
        <div className="new-document-menu" role="menu">
          <button
            className="file-menu-item file-menu-item-primary"
            disabled={isCreating}
            onClick={() => void handleCreate()}
            role="menuitem"
            type="button"
          >
            <span className="file-menu-item-label">Blank document</span>
          </button>
          <div className="file-menu-section-label">From a template</div>
          {templates.map((template) => (
            <button
              className="file-menu-item"
              disabled={isCreating}
              key={template.id}
              onClick={() => void handleCreate(template.id)}
              role="menuitem"
              type="button"
            >
              <span className="file-menu-item-label">{template.title || "Untitled"}</span>
              {template.isOwner ? null : <span className="file-menu-item-hint">{template.ownerName}</span>}
            </button>
          ))}
          {error ? <div className="file-menu-empty">{error}</div> : null}
        </div>
      ) : error ? (
        <span className="subtle-pill env-error">{error}</span>
      ) : null}
    </div>
  );
}
