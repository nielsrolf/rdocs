"use client";

import { useEffect, useState } from "react";

type Props = { manifestUrl: string };

type SetupManifest = {
  title: string;
  markdown: string;
  environment: Record<string, string>;
  skill_name: string;
  skill_markdown: string;
  channel_label?: string;
  callback_url: string;
  callback_body?: Record<string, unknown>;
  mcp_servers?: Array<{ name: string; url: string; authEnvKey?: string | null }>;
};

export function AgentSetupClient(props: Props) {
  const [state, setState] = useState<"ready" | "working" | "done" | "error">("ready");
  const [error, setError] = useState("");
  const [documentUrl, setDocumentUrl] = useState("");
  const [title, setTitle] = useState("external agent");

  useEffect(() => {
    if (state !== "ready") return;
    const credential = new URLSearchParams(window.location.hash.slice(1)).get("credential");
    if (!credential) setError("This setup link is missing its one-time forecasting credential.");
  }, [state]);

  async function provision() {
    const credential = new URLSearchParams(window.location.hash.slice(1)).get("credential");
    if (!credential) return;
    setState("working");
    setError("");
    try {
      const manifestResponse = await fetch("/api/agent-setup-manifests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifestUrl: props.manifestUrl, credential })
      });
      if (!manifestResponse.ok) throw new Error("Could not download the integration setup manifest.");
      const manifest = await manifestResponse.json() as SetupManifest;
      setTitle(manifest.title);
      const response = await fetch("/api/agent-setups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: manifest.title,
          markdown: manifest.markdown,
          environment: manifest.environment,
          skillMarkdown: manifest.skill_markdown,
          skillName: manifest.skill_name,
          channelLabel: manifest.channel_label,
          callbackUrl: manifest.callback_url,
          callbackCredential: credential,
          callbackBody: manifest.callback_body,
          mcpServers: manifest.mcp_servers
        })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Could not create the agent.");

      window.history.replaceState(null, "", window.location.pathname);
      setDocumentUrl(data.documentUrl);
      setState("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Setup failed.");
      setState("error");
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" style={{ maxWidth: 680 }}>
        <h1>Connect {title}</h1>
        <p>This creates a configured r-docs workspace, attaches the integration skill, and gives the external service a narrowly scoped trigger credential.</p>
        {error ? <p className="auth-error">{error}</p> : null}
        {state === "done" ? (
          <p><a href={documentUrl}>Open the new agent workspace →</a></p>
        ) : (
          <button type="button" onClick={provision} disabled={state === "working" || Boolean(error && state === "ready")}>
            {state === "working" ? "Creating agent…" : "Create agent in r-docs"}
          </button>
        )}
      </section>
    </main>
  );
}
