"use client";

import { useEffect, useMemo, useState } from "react";

import {
  AGENT_EFFORTS,
  ANTHROPIC_AGENT_MODELS,
  CODEX_CHATGPT_AGENT_MODELS,
  CODEX_LITELLM_AGENT_MODELS,
  CODEX_OPENAI_AGENT_MODELS,
  LITELLM_AGENT_MODELS,
  OPENROUTER_AGENT_MODELS,
  agentHarnessForModel,
  type AgentModelOption
} from "@/agent-core/agent-config";

type CredentialChoice = { id: string; label: string; envNames: string[]; model: boolean };
type BudgetProvisioner = { id: string; title: string };
type LibrarySkill = { name: string; description: string | null };

// Mirrors AgentPresetConfig in lib/agent-presets.ts (a server module).
type PresetConfig = {
  agentModel: string | null;
  agentEffort: string | null;
  skills: string[];
  credentialIds: string[];
  budget: { provisionerDocumentId: string; budgetUsd: number; costProjectParent: string | null } | null;
};
type Preset = { id: string; name: string; config: PresetConfig };

type Props = {
  manifestUrl: string;
  credentialChoices?: CredentialChoice[] | null;
  /** Documents the user may give out compute budgets from (empty: no budget section). */
  budgetProvisioners?: BudgetProvisioner[];
  presets?: Preset[];
  librarySkills?: LibrarySkill[];
  /** What "my default" means right now, for the labels. */
  defaults?: { model: string; effort: string };
};

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

// The scaffold (harness) is a property of the model value: Codex models start with "codex/".
const SCAFFOLDS: Array<{ id: "claude-code" | "codex"; label: string; groups: Array<{ label: string; models: readonly AgentModelOption[] }> }> = [
  {
    id: "claude-code",
    label: "Claude Code",
    groups: [
      { label: "Anthropic", models: ANTHROPIC_AGENT_MODELS },
      { label: "Through LiteLLM", models: LITELLM_AGENT_MODELS },
      { label: "Through OpenRouter", models: OPENROUTER_AGENT_MODELS }
    ]
  },
  {
    id: "codex",
    label: "Codex",
    groups: [
      { label: "OpenAI API key", models: CODEX_OPENAI_AGENT_MODELS },
      { label: "ChatGPT subscription", models: CODEX_CHATGPT_AGENT_MODELS },
      { label: "Through LiteLLM", models: CODEX_LITELLM_AGENT_MODELS }
    ]
  }
];

const modelLabel = (value: string) =>
  SCAFFOLDS.flatMap((scaffold) => scaffold.groups.flatMap((group) => group.models)).find((model) => model.value === value)?.label ?? value;
const effortLabel = (value: string) => AGENT_EFFORTS.find((effort) => effort.value === value)?.label ?? value;

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
  const provisioners = props.budgetProvisioners ?? [];
  const [provisionerId, setProvisionerId] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [costParent, setCostParent] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  // Agent configuration. "" = the user's default.
  const librarySkills = props.librarySkills ?? [];
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [presets, setPresets] = useState<Preset[]>(props.presets ?? []);
  const [presetId, setPresetId] = useState("");
  const [saveName, setSaveName] = useState("");
  const [notice, setNotice] = useState("");
  // "" as the model means the user's default, which belongs to one of the two scaffolds.
  const defaultScaffold = props.defaults ? agentHarnessForModel(props.defaults.model) : "claude-code";
  const scaffold = model ? agentHarnessForModel(model) : defaultScaffold;
  const selectedPreset = presets.find((preset) => preset.id === presetId) ?? null;

  useEffect(() => {
    if (state !== "ready") return;
    const credential = new URLSearchParams(window.location.hash.slice(1)).get("credential");
    if (!credential) {
      setMissingCredential(true);
      setError("This setup link is missing its one-time credential.");
    }
  }, [state]);

  // The form as a preset config: what is saved, and what tells whether a chosen preset was changed.
  const currentConfig = useMemo<PresetConfig>(() => {
    const amount = Number(budgetUsd);
    return {
      agentModel: model || null,
      agentEffort: effort || null,
      skills: [...skills].sort(),
      credentialIds: (choices ?? []).filter((choice) => picked[choice.id]).map((choice) => choice.id).sort(),
      budget:
        provisionerId && Number.isFinite(amount) && amount > 0
          ? { provisionerDocumentId: provisionerId, budgetUsd: amount, costProjectParent: costParent.trim() || null }
          : null
    };
  }, [model, effort, skills, choices, picked, provisionerId, budgetUsd, costParent]);
  const presetUnchanged = Boolean(
    selectedPreset &&
      JSON.stringify({ ...selectedPreset.config, skills: [...selectedPreset.config.skills].sort(), credentialIds: [...selectedPreset.config.credentialIds].sort() }) ===
        JSON.stringify(currentConfig)
  );

  function applyPreset(id: string) {
    setPresetId(id);
    setNotice("");
    const preset = presets.find((candidate) => candidate.id === id);
    if (!preset) {
      setSaveName("");
      return;
    }
    const config = preset.config;
    setSaveName(preset.name);
    setModel(config.agentModel ?? "");
    setEffort(config.agentEffort ?? "");
    const known = config.skills.filter((name) => librarySkills.some((skill) => skill.name === name));
    setSkills(known);
    if (choices) setPicked(Object.fromEntries(choices.map((choice) => [choice.id, config.credentialIds.includes(choice.id)])));
    const dropped: string[] = [];
    if (known.length < config.skills.length) dropped.push("a skill that is no longer in your library");
    if (config.budget && provisioners.some((provisioner) => provisioner.id === config.budget!.provisionerDocumentId)) {
      setProvisionerId(config.budget.provisionerDocumentId);
      setBudgetUsd(String(config.budget.budgetUsd));
      setCostParent(config.budget.costProjectParent ?? "");
    } else {
      if (config.budget) dropped.push("its budget (you can no longer give out budgets from that document)");
      setProvisionerId("");
      setBudgetUsd("");
      setCostParent("");
    }
    if (dropped.length) setNotice(`This preset was saved with ${dropped.join(" and ")}; that part was left out.`);
  }

  async function deletePreset() {
    if (!selectedPreset) return;
    const response = await fetch(`/api/user/agent-presets/${selectedPreset.id}`, { method: "DELETE" });
    if (!response.ok) {
      setError("Could not delete the preset.");
      return;
    }
    setPresets(presets.filter((preset) => preset.id !== selectedPreset.id));
    setPresetId("");
    setSaveName("");
  }

  async function provision() {
    const credential = new URLSearchParams(window.location.hash.slice(1)).get("credential");
    if (!credential) return;
    const extras = extraKeys.filter((key) => key.name.trim() || key.value);
    if (extras.some((key) => !ENV_NAME.test(key.name.trim()) || !key.value)) {
      setError("Each extra key needs a name like RUNPOD_API_KEY and a value.");
      return;
    }
    const budgetAmount = Number(budgetUsd);
    if (provisionerId && !(Number.isFinite(budgetAmount) && budgetAmount > 0)) {
      setError("Enter the budget in USD, e.g. 50.");
      return;
    }
    setState("working");
    setError("");
    try {
      // The name the integration is told: the preset being saved, or the chosen one if it was not changed.
      let presetName: string | null = presetUnchanged && selectedPreset ? selectedPreset.name : null;
      if (saveName.trim() && !(presetUnchanged && selectedPreset?.name === saveName.trim())) {
        const saved = await fetch("/api/user/agent-presets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: saveName.trim(), config: currentConfig })
        });
        const savedData = await saved.json().catch(() => null);
        if (!saved.ok) throw new Error(savedData?.error || "Could not save the preset.");
        presetName = savedData.preset.name;
        setPresets([...presets.filter((preset) => preset.id !== savedData.preset.id), savedData.preset]);
        setPresetId(savedData.preset.id);
      }
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
          agentModel: model || undefined,
          agentEffort: effort || undefined,
          skills,
          presetName: presetName ?? undefined,
          budget: provisionerId
            ? { provisionerDocumentId: provisionerId, budgetUsd: budgetAmount, costProjectParent: costParent.trim() || undefined }
            : undefined,
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
      setWarnings(Array.isArray(data.budget?.warnings) ? data.budget.warnings : []);
      setState("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Setup failed.");
      setState("error");
    }
  }

  const defaults = props.defaults;
  const groups = SCAFFOLDS.find((candidate) => candidate.id === scaffold)?.groups ?? [];
  const modelListed = groups.some((group) => group.models.some((option) => option.value === model));

  return (
    <main className="auth-shell">
      <section className="auth-card agent-setup-card">
        <h1>Connect {title}</h1>
        <p>This creates a configured r-docs workspace, attaches the integration skill, and gives the external service a narrowly scoped trigger credential.</p>
        {state !== "done" ? (
          <div className="agent-setup-keys">
            <h2>Agent</h2>
            <div className="agent-setup-fields">
              <label htmlFor="agent-setup-preset">Preset</label>
              <div className="agent-setup-field-row">
                <select id="agent-setup-preset" value={presetId} onChange={(event) => applyPreset(event.target.value)}>
                  <option value="">{presets.length ? "None: configure below" : "None yet: configure below and save one"}</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                  ))}
                </select>
                {selectedPreset ? <button className="ghost-button" type="button" onClick={deletePreset}>Delete</button> : null}
              </div>

              <label htmlFor="agent-setup-scaffold">Scaffold</label>
              <select
                id="agent-setup-scaffold"
                value={scaffold}
                onChange={(event) => {
                  // Back on the default's scaffold the model returns to "my default"; the other scaffold starts at its first model.
                  const next = SCAFFOLDS.find((candidate) => candidate.id === event.target.value) ?? SCAFFOLDS[0];
                  setModel(next.id === defaultScaffold ? "" : next.groups[0].models[0].value);
                }}
              >
                {SCAFFOLDS.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                ))}
              </select>

              <label htmlFor="agent-setup-model">Model</label>
              <select id="agent-setup-model" value={model} onChange={(event) => setModel(event.target.value)}>
                {scaffold === defaultScaffold ? (
                  <option value="">My default{defaults ? ` (${modelLabel(defaults.model)})` : ""}</option>
                ) : null}
                {model && !modelListed ? <option value={model}>{model}</option> : null}
                {groups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <label htmlFor="agent-setup-effort">Thinking</label>
              <select id="agent-setup-effort" value={effort} onChange={(event) => setEffort(event.target.value)}>
                <option value="">My default{defaults ? ` (${effortLabel(defaults.effort)})` : ""}</option>
                {AGENT_EFFORTS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            {notice ? <p className="agent-setup-hint">{notice}</p> : null}
            <p className="agent-setup-hint">
              The model needs a credential it can run on: one of your keys ticked below, or a compute budget, whose LiteLLM key runs Claude models.
            </p>

            <h2>Skills</h2>
            {librarySkills.length ? (
              <div className="agent-setup-key-list">
                {librarySkills.map((skill) => (
                  <label className="agent-setup-key" key={skill.name}>
                    <input
                      type="checkbox"
                      checked={skills.includes(skill.name)}
                      onChange={(event) =>
                        setSkills(event.target.checked ? [...skills, skill.name] : skills.filter((name) => name !== skill.name))
                      }
                    />
                    <span className="agent-setup-key-text">
                      <span>{skill.name}</span>
                      {skill.description ? <code>{skill.description.slice(0, 140)}</code> : null}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            <p className="agent-setup-hint">
              The integration&apos;s own skill is always attached.{" "}
              {librarySkills.length
                ? "Ticked skills from your library are copied into the workspace as well."
                : "Skills in your library (Settings → AI) can be added here."}
            </p>
          </div>
        ) : null}
        {choices && state !== "done" ? (
          <div className="agent-setup-keys">
            <h2>Keys this agent may use</h2>
            <p className="agent-setup-hint">
              The agent follows instructions written by someone else. It gets only the keys you tick or add here.
              Your other keys, your MCP servers and your other documents stay out of reach, and this cannot be widened later.
            </p>
            {choices.length ? (
              <div className="agent-setup-key-list">
                {choices.map((choice) => (
                  <label className="agent-setup-key" key={choice.id}>
                    <input
                      type="checkbox"
                      checked={Boolean(picked[choice.id])}
                      onChange={(event) => setPicked({ ...picked, [choice.id]: event.target.checked })}
                    />
                    <span className="agent-setup-key-text">
                      <span>{choice.label}</span>
                      <code>{choice.envNames[0]}</code>
                    </span>
                  </label>
                ))}
              </div>
            ) : <p>You have no keys connected in r-docs. Connect a model credential under Settings → AI first, or the run cannot start.</p>}
            {choices.length && !provisionerId && !choices.some((choice) => choice.model && picked[choice.id]) ? (
              <p className="auth-error">No model credential is ticked, so the run cannot start its model.</p>
            ) : null}
            {extraKeys.map((key, index) => (
              <div className="agent-setup-extra-key" key={index}>
                <input
                  aria-label="Key name" placeholder="RUNPOD_API_KEY" value={key.name} autoComplete="off"
                  onChange={(event) => setExtraKeys(extraKeys.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}
                />
                <input
                  aria-label="Key value" placeholder="value" type="password" value={key.value} autoComplete="off"
                  onChange={(event) => setExtraKeys(extraKeys.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
                />
                <button className="ghost-button" type="button" onClick={() => setExtraKeys(extraKeys.filter((_, i) => i !== index))}>Remove</button>
              </div>
            ))}
            <button className="ghost-button agent-setup-add-key" type="button" onClick={() => setExtraKeys([...extraKeys, { name: "", value: "" }])}>
              + Add another key
            </button>
            <p className="agent-setup-hint">Added keys are stored encrypted with the new workspace and are not sent to the other service. They are not part of a preset.</p>
          </div>
        ) : null}
        {provisioners.length && state !== "done" ? (
          <div className="agent-setup-keys">
            <h2>Compute budget</h2>
            <p className="agent-setup-hint">
              Optional. The workspace gets its own keys for LLM calls, OpenWeights, Tinker and Modal, paid by the document you pick
              and limited to this total. Its spend shows up per provider in the cost dashboard, and the run is stopped when the budget is used up.
              {choices ? " Untick your own model key above if the agent's own LLM usage should come out of the budget too." : ""}
            </p>
            <div className="agent-setup-fields">
              <label htmlFor="agent-setup-provisioner">Paid by</label>
              <select id="agent-setup-provisioner" value={provisionerId} onChange={(event) => setProvisionerId(event.target.value)}>
                <option value="">No budget</option>
                {provisioners.map((provisioner) => (
                  <option key={provisioner.id} value={provisioner.id}>{provisioner.title}</option>
                ))}
              </select>
              {provisionerId ? (
                <>
                  <label htmlFor="agent-setup-budget">Budget (USD)</label>
                  <input
                    id="agent-setup-budget" placeholder="e.g. 50" inputMode="decimal" value={budgetUsd} autoComplete="off"
                    onChange={(event) => setBudgetUsd(event.target.value)}
                  />
                  <label htmlFor="agent-setup-cost-parent">Cost project</label>
                  <input
                    id="agent-setup-cost-parent" placeholder="Optional: existing dashboard project to file this under" value={costParent} autoComplete="off"
                    onChange={(event) => setCostParent(event.target.value)}
                  />
                </>
              ) : null}
            </div>
          </div>
        ) : null}
        {state !== "done" ? (
          <div className="agent-setup-keys">
            <div className="agent-setup-fields">
              <label htmlFor="agent-setup-save">Save as preset</label>
              <input
                id="agent-setup-save" placeholder="Optional: a name, e.g. Careful Opus, $50" value={saveName} maxLength={60} autoComplete="off"
                onChange={(event) => setSaveName(event.target.value)}
              />
            </div>
            <p className="agent-setup-hint">
              {saveName.trim()
                ? presets.some((preset) => preset.name === saveName.trim())
                  ? presetUnchanged && selectedPreset?.name === saveName.trim()
                    ? "Runs as this preset."
                    : "Updates this preset with the settings above, then runs it."
                  : "Saves the settings above under this name, so the next run is one pick. The integration is told the name."
                : "With a name, these settings are kept as a pre-configured agent you can pick next time."}
            </p>
          </div>
        ) : null}
        {error ? <p className="auth-error">{error}</p> : null}
        {warnings.map((warning) => <p className="agent-setup-hint" key={warning}>{warning}</p>)}
        {state === "done" ? (
          <p><a className="primary-button" href={documentUrl}>Open the new agent workspace →</a></p>
        ) : (
          <button className="primary-button wide-button" type="button" onClick={provision} disabled={state === "working" || missingCredential}>
            {state === "working" ? "Creating agent…" : "Create agent in r-docs"}
          </button>
        )}
      </section>
    </main>
  );
}
