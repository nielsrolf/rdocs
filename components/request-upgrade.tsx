"use client";

import { useState } from "react";

import type { PermissionLevelValue } from "@/lib/contracts";

const LEVEL_WORD: Record<PermissionLevelValue, string> = { VIEW: "view", COMMENT: "comment", EDIT: "edit" };

/**
 * For a signed-in reader who can view (or comment) but not edit: ask the owner
 * for a higher level. Sits in the read-only banner under the document. Once
 * asked it only says so — a declined request looks the same (not disclosed).
 */
export function RequestUpgrade({
  documentId,
  currentPermission,
  initiallyRequested
}: {
  documentId: string;
  currentPermission: "VIEW" | "COMMENT";
  initiallyRequested: PermissionLevelValue | null;
}) {
  const [requested, setRequested] = useState<PermissionLevelValue | null>(initiallyRequested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options: PermissionLevelValue[] = currentPermission === "VIEW" ? ["COMMENT", "EDIT"] : ["EDIT"];

  async function ask(permission: PermissionLevelValue) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/access-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission })
      });
      const data = (await response.json().catch(() => null)) as { status?: string; error?: string } | null;
      if (!response.ok) {
        setError(data?.error ?? "Could not send the request.");
        return;
      }
      if (data?.status === "has-access") {
        // The level arrived in the meantime.
        window.location.reload();
        return;
      }
      setRequested(permission);
    } catch {
      setError("Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  if (requested) {
    return (
      <span className="request-upgrade">
        You asked the owner for {LEVEL_WORD[requested]} access.
        {requested === "COMMENT" ? (
          <button className="link-button" disabled={busy} onClick={() => void ask("EDIT")} type="button">
            Ask for edit access instead
          </button>
        ) : null}
        {error ? <span role="alert"> {error}</span> : null}
      </span>
    );
  }

  return (
    <span className="request-upgrade">
      {options.map((permission) => (
        <button
          className="ghost-button"
          disabled={busy}
          key={permission}
          onClick={() => void ask(permission)}
          type="button"
        >
          Ask for {LEVEL_WORD[permission]} access
        </button>
      ))}
      {error ? <span role="alert">{error}</span> : null}
    </span>
  );
}
