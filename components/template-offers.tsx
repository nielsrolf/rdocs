"use client";

import { useState } from "react";

// "Someone shared a template with you — add it to your templates?" Shown on
// the dashboard (every open offer) and inside the template document itself.
// Either answer is stored (UserTemplate), so each template asks once; the
// choice can be changed under Settings → Templates.

export type TemplateOffer = { id: string; title: string; ownerName: string };

// Other mounted pieces (the "New document" button) reload their list on this.
export const TEMPLATES_CHANGED_EVENT = "rdocs:templates-changed";

export async function saveTemplateStatus(documentId: string, status: "added" | "dismissed") {
  const response = await fetch(`/api/user/templates/${documentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });
  if (response.ok) {
    window.dispatchEvent(new Event(TEMPLATES_CHANGED_EVENT));
  }
  return response.ok;
}

export function TemplateOffers({
  offers,
  variant
}: {
  offers: TemplateOffer[];
  variant: "dashboard" | "document";
}) {
  const [open, setOpen] = useState(offers);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(offer: TemplateOffer, status: "added" | "dismissed") {
    setBusyId(offer.id);
    setError(null);
    const ok = await saveTemplateStatus(offer.id, status).catch(() => false);
    setBusyId(null);
    if (!ok) {
      setError("Could not save your choice. Try again.");
      return;
    }
    setOpen((current) => current.filter((entry) => entry.id !== offer.id));
  }

  if (open.length === 0) return null;

  return (
    <div className={`template-offers template-offers-${variant}`} role="region" aria-label="Shared templates">
      {open.map((offer) => (
        <div className="template-offer" key={offer.id}>
          <p className="template-offer-text">
            {variant === "document" ? (
              <>
                <strong>{offer.ownerName}</strong> shared this template with you. Add it to your
                templates, so it shows up when you click “New document”?
              </>
            ) : (
              <>
                <strong>{offer.ownerName}</strong> shared the template{" "}
                <a href={`/documents/${offer.id}`}>{offer.title || "Untitled"}</a> with you. Add it
                to your templates, so it shows up when you click “New document”?
              </>
            )}
          </p>
          <div className="template-offer-actions">
            <button
              className="primary-button"
              disabled={busyId === offer.id}
              onClick={() => void answer(offer, "added")}
              type="button"
            >
              Add to my templates
            </button>
            <button
              className="ghost-button"
              disabled={busyId === offer.id}
              onClick={() => void answer(offer, "dismissed")}
              type="button"
            >
              No thanks
            </button>
          </div>
        </div>
      ))}
      {error ? <span className="subtle-pill env-error">{error}</span> : null}
    </div>
  );
}
