"use client";

import { useEffect, useState } from "react";

type CredentialChoice = { id: string; label: string; envNames: string[]; model: boolean };

type Props = { manifestUrl: string; credentialChoices?: CredentialChoice[] | null };

type ExtraKey = { name: string; value: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

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
  const [missingCredential, setMissingCredential] = useState(false);
  const [title, setTitle] = useState("external agent");
  const choices = props.credentialChoices ?? null;
  const [picked, setPicked] = useState<Record<string, boolean>>(
    () => Object.fromEntries((choices ?? []).map((choice) => [choice.id, choice.model]))
  );
  const [extraKeys, setExtraKeys] = useState<ExtraKey[]>([]);

  useEffect(() => {
    if (state !== "ready") return;
    const credential = new URLSearchParams(window.location.hash.slice(1)).get("credential");
    if (!credential) {
      setMissingCredential(true);
      setError("This setup link is missing its one-time credential.");
    }
  }, [state]);

  async function provision() {
    const credential = new URLSearchParams(window.location.hash.slice(1)).get("credential");
    if (!credential) return;
    const extras = extraKeys.filter((key) => key.name.trim() || key.value);
    if (extras.some((key) => !ENV_NAME.test(key.name.trim()) || !key.value)) {
      setError("Each extra key needs a name like RUNPOD_API_KEY and a value.");
      return;
    }
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
          environment: { ...manifest.environment, ...Object.fromEntries(extras.map((key) => [key.name.trim(), key.value])) },
          skillMarkdown: manifest.skill_markdown,
          skillName: manifest.skill_name,
          channelLabel: manifest.channel_label,
          callbackUrl: manifest.callback_url,
          callbackCredential: credential,
          callbackBody: manifest.callback_body,
          mcpServers: manifest.mcp_servers,
          // With a picker, the choice becomes the channel's credential ceiling:
          // the ticked keys, the keys typed in here, and the integration's own
          // settings from the manifest. Nothing else of the user's reaches a run.
          credentials: choices
            ? {
                allowEnv: [
                  ...choices.filter((choice) => picked[choice.id]).flatMap((choice) => choice.envNames),
                  ...extras.map((key) => key.name.trim()),
                  ...Object.keys(manifest.environment || {})
                ],
                allowMcpServers: (manifest.mcp_servers || []).map((server) => server.name)
              }
            : undefined
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
        {choices && state !== "done" ? (
          <div style={{ display: "grid", gap: "0.6rem", margin: "1rem 0" }}>
            <h2 style={{ fontSize: "1rem", margin: 0 }}>Keys this agent may use</h2>
            <p style={{ margin: 0 }}>
              The agent follows instructions written by someone else. It gets only the keys you tick or add here.
              Your other keys, your MCP servers and your other documents stay out of reach, and this cannot be widened later.
            </p>
            {choices.length ? choices.map((choice) => (
              <label key={choice.id} style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
                <input
                  type="checkbox"
                  checked={Boolean(picked[choice.id])}
                  onChange={(event) => setPicked({ ...picked, [choice.id]: event.target.checked })}
                />
                <span>{choice.label} <code>{choice.envNames[0]}</code></span>
              </label>
            )) : <p style={{ margin: 0 }}>You have no keys connected in r-docs. Connect a model credential under Settings → AI first, or the run cannot start.</p>}
            {choices.length && !choices.some((choice) => choice.model && picked[choice.id]) ? (
              <p className="auth-error" style={{ margin: 0 }}>No model credential is ticked, so the run cannot start its model.</p>
            ) : null}
            {extraKeys.map((key, index) => (
              <div key={index} style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr) auto", gap: "0.4rem" }}>
                <input
                  aria-label="Key name" placeholder="RUNPOD_API_KEY" value={key.name} autoComplete="off"
                  onChange={(event) => setExtraKeys(extraKeys.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}
                />
                <input
                  aria-label="Key value" placeholder="value" type="password" value={key.value} autoComplete="off"
                  onChange={(event) => setExtraKeys(extraKeys.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
                />
                <button type="button" onClick={() => setExtraKeys(extraKeys.filter((_, i) => i !== index))}>Remove</button>
              </div>
            ))}
            <div>
              <button type="button" onClick={() => setExtraKeys([...extraKeys, { name: "", value: "" }])}>Add another key</button>
            </div>
            <p style={{ margin: 0, opacity: 0.75 }}>Added keys are stored encrypted with the new workspace and are not sent to the other service.</p>
          </div>
        ) : null}
        {error ? <p className="auth-error">{error}</p> : null}
        {state === "done" ? (
          <p><a href={documentUrl}>Open the new agent workspace →</a></p>
        ) : (
          <button type="button" onClick={provision} disabled={state === "working" || missingCredential}>
            {state === "working" ? "Creating agent…" : "Create agent in r-docs"}
          </button>
        )}
      </section>
    </main>
  );
}
