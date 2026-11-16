import { useEffect, useRef, useState } from "react";

import { permissionLevels, type PermissionLevelValue } from "@/lib/contracts";
import { permissionLabel } from "@/lib/utils";

import type { MemberView } from "./types";

type AccessRequestView = {
  id: string;
  message: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
};

/**
 * Share dialog (owner): people who asked for permission on the no-access page.
 * Renders nothing while there are none.
 */
export function AccessRequestsSection({
  documentId,
  onGranted,
  onCountChange
}: {
  documentId: string;
  onGranted: (membership: MemberView) => void;
  onCountChange: (count: number) => void;
}) {
  const [requests, setRequests] = useState<AccessRequestView[]>([]);
  const [permissions, setPermissions] = useState<Record<string, PermissionLevelValue>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  useEffect(() => {
    let alive = true;
    fetch(`/api/documents/${documentId}/access-requests`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!alive || !Array.isArray(data?.requests)) return;
        setRequests(data.requests);
        onCountChangeRef.current(data.requests.length);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [documentId]);

  async function resolve(request: AccessRequestView, action: "grant" | "decline") {
    setBusyId(request.id);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/access-requests/${request.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "grant" ? { action, permission: permissions[request.id] ?? "COMMENT" } : { action }
        )
      });
      const data = (await response.json().catch(() => null)) as
        | { membership?: MemberView; error?: string }
        | null;
      // 404 = answered elsewhere already; drop the row either way.
      if (!response.ok && response.status !== 404) {
        setError(data?.error ?? "Could not answer the request.");
        return;
      }
      if (data?.membership) onGranted(data.membership);
      setRequests((current) => {
        const next = current.filter((entry) => entry.id !== request.id);
        onCountChangeRef.current(next.length);
        return next;
      });
    } catch {
      setError("Could not answer the request.");
    } finally {
      setBusyId(null);
    }
  }

  if (requests.length === 0) return null;

  return (
    <div className="share-modal-section access-requests-section">
      <h3>Access requests</h3>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="member-list">
        {requests.map((request) => (
          <div className="member-row access-request-row" key={request.id}>
            <div>
              <strong>{request.user.name}</strong>
              <span>{request.user.email}</span>
              {request.message ? <p className="access-request-message">{request.message}</p> : null}
            </div>
            <div className="access-request-actions">
              <select
                aria-label={`Permission for ${request.user.name}`}
                disabled={busyId === request.id}
                onChange={(event) =>
                  setPermissions((current) => ({
                    ...current,
                    [request.id]: event.target.value as PermissionLevelValue
                  }))
                }
                value={permissions[request.id] ?? "COMMENT"}
              >
                {permissionLevels.map((permission) => (
                  <option key={permission} value={permission}>
                    {permissionLabel(permission)}
                  </option>
                ))}
              </select>
              <button
                className="primary-button"
                disabled={busyId === request.id}
                onClick={() => void resolve(request, "grant")}
                type="button"
              >
                Give access
              </button>
              <button
                className="ghost-button"
                disabled={busyId === request.id}
                onClick={() => void resolve(request, "decline")}
                type="button"
              >
                Decline
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
