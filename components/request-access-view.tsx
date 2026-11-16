"use client";

import Link from "next/link";
import { useState } from "react";

const MESSAGE_MAX = 500;

/**
 * Shown instead of a 404 when a signed-in user opens a document they cannot
 * read. Deliberately shows nothing about the document itself (no title, no
 * owner) — only that access can be asked for.
 */
export function RequestAccessView({
  documentId,
  userEmail,
  initiallyRequested
}: {
  documentId: string;
  userEmail: string;
  initiallyRequested: boolean;
}) {
  const [requested, setRequested] = useState(initiallyRequested);
  const [message, setMessage] = useState("");
  const [permission, setPermission] = useState<"VIEW" | "COMMENT" | "EDIT">("VIEW");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/access-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() || null, permission })
      });
      const data = (await response.json().catch(() => null)) as { status?: string; error?: string } | null;
      if (!response.ok) {
        setError(data?.error ?? "Could not send the request.");
        return;
      }
      if (data?.status === "has-access") {
        // Access arrived in the meantime (granted, or shared some other way).
        window.location.reload();
        return;
      }
      setRequested(true);
    } catch {
      setError("Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card request-access-card">
        <div className="section-heading">
          <h1>{requested ? "Request sent" : "You need access"}</h1>
          <p>
            {requested
              ? "The owner has been asked to give you access. You can open the document from this link once they do."
              : "This document isn't shared with you. You can ask its owner for permission."}
          </p>
        </div>
        {requested ? null : (
          <div className="stack-form">
            <label>
              <span>Access</span>
              <select
                onChange={(event) => setPermission(event.target.value as "VIEW" | "COMMENT" | "EDIT")}
                value={permission}
              >
                <option value="VIEW">View</option>
                <option value="COMMENT">Comment</option>
                <option value="EDIT">Edit</option>
              </select>
            </label>
            <label>
              <span>Message (optional)</span>
              <textarea
                maxLength={MESSAGE_MAX}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Why you need it"
                rows={3}
                value={message}
              />
            </label>
            {error ? <div className="error-banner" role="alert">{error}</div> : null}
            <button className="primary-button wide-button" disabled={busy} onClick={() => void ask()} type="button">
              {busy ? "Sending…" : "Ask for permission"}
            </button>
          </div>
        )}
        <p className="inline-note">
          You are signed in as {userEmail}. <Link href="/dashboard">Back to your documents</Link>
        </p>
      </section>
    </main>
  );
}
