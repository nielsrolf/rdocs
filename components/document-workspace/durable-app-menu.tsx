"use client";

import { useEffect, useState } from "react";

type DurableAppState = {
  workspaceDocumentId: string;
  enabled: boolean;
  hostname: string | null;
  appPort: number;
  hostPort: number | null;
  running: boolean;
  startedAt: string | null;
  innerDocker: boolean;
  allowed: boolean;
  domainSuffix: string;
  publicUrl: string | null;
};

// Durable app + docker-in-docker toggles (lib/durable-apps.ts). Owner-only
// controls; collaborators see a pill when the workspace runs as a durable app.
export function DurableAppMenu({ documentId, isOwner }: { documentId: string; isOwner: boolean }) {
  const [state, setState] = useState<DurableAppState | null>(null);
  const [hostnameLabel, setHostnameLabel] = useState("");
  const [appPort, setAppPort] = useState("3000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/documents/${documentId}/durable-app`)
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data?.app) return;
        applyState(data.app as DurableAppState);
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  function applyState(app: DurableAppState) {
    setState(app);
    setAppPort(String(app.appPort));
    if (app.hostname) {
      const suffix = `.${app.domainSuffix}`;
      setHostnameLabel(app.hostname.endsWith(suffix) ? app.hostname.slice(0, -suffix.length) : app.hostname);
    }
  }

  async function patch(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/durable-app`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Update failed.");
        return;
      }
      applyState(data.app as DurableAppState);
    } catch {
      setError("Update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/durable-app/restart`, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error ?? "Restart failed.");
        return;
      }
      applyState(data.app as DurableAppState);
    } catch {
      setError("Restart failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  if (!isOwner) {
    return state.enabled ? (
      <span
        className="subtle-pill"
        title="Agent sessions on this workspace run inside one long-lived container that also hosts the workspace's public app."
      >
        Durable app{state.publicUrl ? ` · ${state.hostname}` : ""}
      </span>
    ) : null;
  }

  const fullHostname = hostnameLabel.trim() ? `${hostnameLabel.trim()}.${state.domainSuffix}` : "";

  return (
    <details className="header-menu header-menu-env">
      <summary>{state.enabled ? "Durable app ✓" : "Durable app"}</summary>
      <div className="header-menu-panel env-panel">
        <div>
          <strong>Durable app container</strong>
          <p>
            One long-lived sandboxed container per workspace: every agent session runs inside it, the
            base checkout is mounted directly, background processes survive between sessions, and one
            port is published at <code>https://&lt;name&gt;.{state.domainSuffix}</code>. The agent is told the port and URL.
          </p>
          {!state.allowed ? (
            <p className="env-note env-note-error">
              Publishing apps is not enabled for your account on this deployment (ask the operator to add
              your email to <code>DURABLE_APP_ALLOWED_EMAILS</code>).
            </p>
          ) : null}
        </div>

        <label className="env-add-row" style={{ alignItems: "center" }}>
          <input
            aria-label="Docker inside agent containers"
            checked={state.innerDocker}
            disabled={busy}
            onChange={(event) => void patch({ innerDocker: event.target.checked })}
            type="checkbox"
          />
          <span>Docker inside agent containers (gVisor sandbox; off = lighter hardened container)</span>
        </label>

        <div className="env-add-row">
          <input
            aria-label="Public hostname label"
            disabled={busy || !state.allowed}
            onChange={(event) => setHostnameLabel(event.target.value)}
            placeholder="my-app"
            value={hostnameLabel}
          />
          <span>.{state.domainSuffix}</span>
          <input
            aria-label="App port inside the container"
            disabled={busy || !state.allowed}
            inputMode="numeric"
            onChange={(event) => setAppPort(event.target.value)}
            style={{ width: "5.5em" }}
            value={appPort}
          />
        </div>

        <label className="env-add-row" style={{ alignItems: "center" }}>
          <input
            aria-label="Enable durable app"
            checked={state.enabled}
            disabled={busy || !state.allowed || (!state.enabled && !fullHostname)}
            onChange={(event) =>
              void patch({
                enabled: event.target.checked,
                hostname: fullHostname || null,
                appPort: Number(appPort) || 3000
              })
            }
            type="checkbox"
          />
          <span>Run this workspace&apos;s agent sessions in a durable app container</span>
        </label>

        {state.enabled ? (
          <>
            <button
              className="ghost-button"
              disabled={busy || !state.allowed}
              onClick={() => void patch({ hostname: fullHostname || null, appPort: Number(appPort) || 3000 })}
              type="button"
            >
              Save hostname / port
            </button>
            <div className="env-var-list">
              <div className="env-var-row">
                <span className="env-var-key">Public URL</span>
                <span className="env-var-value">
                  {state.publicUrl ? (
                    <a href={state.publicUrl} rel="noreferrer" target="_blank">
                      {state.publicUrl}
                    </a>
                  ) : (
                    "—"
                  )}
                </span>
              </div>
              <div className="env-var-row">
                <span className="env-var-key">Container</span>
                <span className="env-var-value">
                  {state.running
                    ? `running since ${state.startedAt ? new Date(state.startedAt).toLocaleString() : "?"}`
                    : "not running (starts with the next agent session)"}
                </span>
              </div>
            </div>
            <button className="ghost-button" disabled={busy || !state.running} onClick={() => void restart()} type="button">
              {busy ? "Working…" : "Stop container (next session recreates it)"}
            </button>
          </>
        ) : null}

        {error ? <span className="subtle-pill env-error">{error}</span> : null}
      </div>
    </details>
  );
}
