import { useEffect, useState } from "react";

import {
  AGENT_EFFORTS,
  ANTHROPIC_AGENT_MODELS,
  LOCAL_MODEL_PREFIX,
  isLocalAgentModel,
  LITELLM_AGENT_MODELS,
  LITELLM_MODEL_PREFIX,
  OPENROUTER_AGENT_MODELS,
  OPENROUTER_MODEL_PREFIX,
  isLiteLlmAgentModel,
  isOpenRouterAgentModel,
  isStorableAgentModel,
  normalizeAgentModel
} from "@/lib/agent-config";
import { cn, truncate } from "@/lib/utils";

import { AgentTimeline } from "./agent-timeline";
import type { AgentConversation } from "./conversations";
import { MarkdownBody } from "./markdown";
import type { ActiveAiRunView } from "./types";
import { formatRelativeTime } from "./utils";

// The final edit a SUCCEEDED selection-edit run produced. The polled run list
// intentionally omits the (potentially large) replacement payload, so this
// fetches the run detail once per run id and renders it with a copy affordance
// — previously the session view never showed WHAT the agent actually wrote.
function RunResultBlock({
  documentId,
  run,
  shareToken
}: {
  documentId: string;
  run: ActiveAiRunView;
  shareToken?: string | null;
}) {
  const [replacementText, setReplacementText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isEditResult = run.triggerType === "SELECTION_EDIT" && run.status === "SUCCEEDED";

  useEffect(() => {
    let alive = true;
    setReplacementText(null);
    setCopied(false);
    if (!isEditResult) return;
    const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
    fetch(`/api/documents/${documentId}/ai-runs/${run.id}${shareQuery}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!alive) return;
        const text = data?.aiRun?.replacementText;
        setReplacementText(typeof text === "string" && text.trim() ? text : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [documentId, run.id, isEditResult, shareToken]);

  if (!isEditResult || !replacementText) {
    return null;
  }

  return (
    <details className="agent-result" open>
      <summary className="agent-result-header">
        <span className="agent-result-title">Final edit</span>
        <button
          className="ghost-button agent-result-copy"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void navigator.clipboard?.writeText(replacementText).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </summary>
      <MarkdownBody body={replacementText} className="agent-result-body markdown-body" />
    </details>
  );
}

type ComposeMode = "selected" | "new";

type AgentConversationOptions = {
  previousRunId?: string | null;
  rootId?: string | null;
};

export function AgentPanel({
  title,
  documentId,
  shareToken,
  activeAiRuns,
  conversations,
  selectedConversation,
  composeMode,
  agentMessage,
  agentBusy,
  canWriteComments,
  canWriteDocument,
  agentModel,
  agentEffort,
  hasOpenRouterKey,
  hasLiteLlmKey,
  localModel,
  onAgentModelChange,
  onAgentEffortChange,
  onClose,
  onSelectConversation,
  onStartNewConversation,
  onAgentMessageChange,
  onSendAgentMessage,
  onStopRun
}: {
  title: string;
  documentId: string;
  shareToken?: string | null;
  activeAiRuns: ActiveAiRunView[];
  conversations: AgentConversation[];
  selectedConversation: AgentConversation | null;
  composeMode: ComposeMode;
  agentMessage: string;
  agentBusy: boolean;
  canWriteComments: boolean;
  canWriteDocument: boolean;
  agentModel: string;
  agentEffort: string;
  hasOpenRouterKey: boolean;
  hasLiteLlmKey: boolean;
  /** The deployment's free local model ("local/<name>") when configured. */
  localModel: string | null;
  onAgentModelChange: (model: string) => void;
  onAgentEffortChange: (effort: string) => void;
  onClose: () => void;
  onSelectConversation: (rootId: string) => void;
  onStartNewConversation: () => void;
  onAgentMessageChange: (next: string) => void;
  onSendAgentMessage: (options?: AgentConversationOptions) => void;
  onStopRun: (runId: string) => void;
}) {
  // Optimistic "Stopping…" state; cleared when the polled status leaves RUNNING.
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const selectedIsRunning = selectedConversation?.status === "RUNNING";
  useEffect(() => {
    if (!selectedIsRunning) setStoppingRunId(null);
  }, [selectedIsRunning]);
  // Two custom-model flows share one input; the sentinel encodes which
  // provider's prefix gets applied on commit.
  const OPENROUTER_CUSTOM_SENTINEL = "__openrouter_custom__";
  const LITELLM_CUSTOM_SENTINEL = "__litellm_custom__";
  const [customMode, setCustomMode] = useState<"openrouter" | "litellm" | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  // Legacy stored aliases ("sonnet"/"opus") display as their canonical model;
  // the canonical value is what gets PATCHed on the next change.
  const normalizedModel = normalizeAgentModel(agentModel);
  const modelIsOpenRouter = isOpenRouterAgentModel(normalizedModel);
  const modelIsLiteLlm = isLiteLlmAgentModel(normalizedModel);
  const modelIsLocal = isLocalAgentModel(normalizedModel);
  // Keep a stored local selection visible even if the host stops offering it.
  const localModelOptions = localModel
    ? [localModel, ...(modelIsLocal && normalizedModel !== localModel ? [normalizedModel] : [])]
    : modelIsLocal
      ? [normalizedModel]
      : [];
  const modelIsThirdParty = modelIsOpenRouter || modelIsLiteLlm;
  const storedCustomOpenRouterModel =
    modelIsOpenRouter && !OPENROUTER_AGENT_MODELS.some((m) => m.value === normalizedModel)
      ? normalizedModel
      : null;
  const storedCustomLiteLlmModel =
    modelIsLiteLlm && !LITELLM_AGENT_MODELS.some((m) => m.value === normalizedModel)
      ? normalizedModel
      : null;
  // Keep a stored third-party selection visible even if its key was deleted.
  const showOpenRouterGroup = hasOpenRouterKey || modelIsOpenRouter;
  const showLiteLlmGroup = hasLiteLlmKey || modelIsLiteLlm;

  function commitCustomSlug() {
    const raw = customDraft.trim();
    if (!raw || !customMode) return;
    const prefix = customMode === "openrouter" ? OPENROUTER_MODEL_PREFIX : LITELLM_MODEL_PREFIX;
    const value = raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
    if (!isStorableAgentModel(value)) {
      setCustomError(
        customMode === "openrouter"
          ? "Enter an OpenRouter slug like openai/gpt-5.2"
          : "Enter a LiteLLM model name like anthropic/claude-opus-4-8"
      );
      return;
    }
    setCustomError(null);
    setCustomMode(null);
    setCustomDraft("");
    onAgentModelChange(value);
  }

  return (
    <div className="agent-screen" role="region" aria-label="Agents">
      <header className="agent-screen-topbar">
        <button className="agent-back-button" onClick={onClose} type="button">
          ← Back to document
        </button>
        <div className="agent-screen-title">
          <span className="agent-screen-title-eyebrow">Agents</span>
          <span className="agent-screen-title-doc">{title}</span>
        </div>
        <div className="agent-config" role="group" aria-label="Agent configuration">
          <label className="agent-config-field">
            <span className="agent-config-label">Model</span>
            <select
              className="agent-config-select"
              disabled={!canWriteDocument}
              onChange={(event) => {
                const value = event.target.value;
                if (value === OPENROUTER_CUSTOM_SENTINEL || value === LITELLM_CUSTOM_SENTINEL) {
                  setCustomMode(value === OPENROUTER_CUSTOM_SENTINEL ? "openrouter" : "litellm");
                  setCustomError(null);
                  return;
                }
                setCustomMode(null);
                onAgentModelChange(value);
              }}
              title={canWriteDocument ? "Model the agent runs as" : "Only editors can change the model"}
              value={
                customMode === "openrouter"
                  ? OPENROUTER_CUSTOM_SENTINEL
                  : customMode === "litellm"
                    ? LITELLM_CUSTOM_SENTINEL
                    : normalizedModel
              }
            >
              <optgroup label="Anthropic">
                {ANTHROPIC_AGENT_MODELS.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </optgroup>
              {localModelOptions.length > 0 ? (
                <optgroup label="Free (this server)">
                  {localModelOptions.map((value) => (
                    <option key={value} value={value}>
                      {value.slice(LOCAL_MODEL_PREFIX.length)} — free, no credential
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {showOpenRouterGroup ? (
                <optgroup label="OpenRouter">
                  {OPENROUTER_AGENT_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                  {storedCustomOpenRouterModel ? (
                    <option value={storedCustomOpenRouterModel}>
                      {storedCustomOpenRouterModel.slice(OPENROUTER_MODEL_PREFIX.length)}
                    </option>
                  ) : null}
                  <option value={OPENROUTER_CUSTOM_SENTINEL}>Custom slug…</option>
                </optgroup>
              ) : null}
              {showLiteLlmGroup ? (
                <optgroup label="LiteLLM">
                  {LITELLM_AGENT_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                  {storedCustomLiteLlmModel ? (
                    <option value={storedCustomLiteLlmModel}>
                      {storedCustomLiteLlmModel.slice(LITELLM_MODEL_PREFIX.length)}
                    </option>
                  ) : null}
                  <option value={LITELLM_CUSTOM_SENTINEL}>Custom model…</option>
                </optgroup>
              ) : null}
            </select>
          </label>
          <label className="agent-config-field">
            <span className="agent-config-label">Thinking</span>
            <select
              className="agent-config-select"
              disabled={!canWriteDocument || modelIsThirdParty}
              onChange={(event) => onAgentEffortChange(event.target.value)}
              title={
                modelIsThirdParty
                  ? "Extended thinking applies to Anthropic models"
                  : canWriteDocument
                    ? "Extended-thinking effort"
                    : "Only editors can change thinking effort"
              }
              value={agentEffort}
            >
              {AGENT_EFFORTS.map((effort) => (
                <option key={effort.value} value={effort.value}>
                  {effort.label}
                </option>
              ))}
            </select>
          </label>
          {customMode ? (
            <div className="agent-config-field agent-config-custom-model">
              <input
                aria-label={
                  customMode === "openrouter" ? "Custom OpenRouter model slug" : "Custom LiteLLM model name"
                }
                className="agent-config-custom-input"
                onChange={(event) => setCustomDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitCustomSlug();
                  }
                }}
                placeholder={customMode === "openrouter" ? "openai/gpt-5.2" : "anthropic/claude-opus-4-8"}
                value={customDraft}
              />
              <button
                className="ghost-button"
                disabled={!customDraft.trim()}
                onClick={commitCustomSlug}
                type="button"
              >
                Use
              </button>
              {customError ? <span className="agent-config-hint agent-config-error">{customError}</span> : null}
            </div>
          ) : null}
          {modelIsOpenRouter && !hasOpenRouterKey ? (
            <span className="agent-config-hint">
              This model needs an OpenRouter key — add OPENROUTER_API_KEY in the Env menu or connect
              one in AI credentials.
            </span>
          ) : modelIsLiteLlm && !hasLiteLlmKey ? (
            <span className="agent-config-hint">
              This model needs a LiteLLM key — add LITELLM_API_KEY in the Env menu or connect one in
              AI credentials.
            </span>
          ) : !hasOpenRouterKey && !hasLiteLlmKey ? (
            <span className="agent-config-hint">
              For OpenRouter/LiteLLM models, add a key in the Env menu or connect one in AI
              credentials.
            </span>
          ) : null}
        </div>
        <span className="agent-screen-topbar-status">
          {activeAiRuns.length > 0
            ? `${activeAiRuns.length} running`
            : `${conversations.length} ${conversations.length === 1 ? "thread" : "threads"}`}
        </span>
      </header>
      <div className="agent-screen-body">
        <aside className="agent-sidebar" aria-label="Agent conversations">
          {canWriteComments ? (
            <button
              className={cn("agent-new-button", composeMode === "new" && "agent-new-button-active")}
              onClick={onStartNewConversation}
              type="button"
            >
              + New conversation
            </button>
          ) : null}
          <div className="agent-sidebar-list">
            {conversations.length === 0 ? (
              <div className="agent-sidebar-empty">No conversations yet.</div>
            ) : (
              conversations.map((conv) => {
                const firstLine =
                  conv.rootInstruction.split("\n")[0] ||
                  conv.latestRun.triggerType.replace(/_/g, " ").toLowerCase();
                const isActive = composeMode === "selected" && selectedConversation?.rootId === conv.rootId;
                const turnCount = conv.runs.length;
                return (
                  <button
                    aria-current={isActive ? "true" : undefined}
                    className={cn("agent-sidebar-item", isActive && "agent-sidebar-item-active")}
                    key={conv.rootId}
                    onClick={() => onSelectConversation(conv.rootId)}
                    type="button"
                  >
                    <div className="agent-sidebar-item-top">
                      <span className={`agent-status-dot agent-status-dot-${conv.status.toLowerCase()}`} aria-hidden />
                      <span className="agent-sidebar-item-title">{truncate(firstLine, 48)}</span>
                      <span className="agent-sidebar-item-time">{formatRelativeTime(conv.lastActivityAt)}</span>
                    </div>
                    <p className="agent-sidebar-item-snippet">{truncate(conv.rootInstruction, 120)}</p>
                    {turnCount > 1 ? (
                      <span className="agent-sidebar-item-turns">{turnCount} turns</span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="agent-main" aria-label="Selected agent conversation">
          {composeMode === "selected" && selectedConversation ? (
            <>
              <header className="agent-main-header">
                <div className="agent-main-title">
                  <span className={`agent-status agent-status-${selectedConversation.status.toLowerCase()}`}>
                    {selectedConversation.status.toLowerCase()}
                  </span>
                  <h3>{truncate(selectedConversation.rootInstruction.split("\n")[0], 120)}</h3>
                  {selectedConversation.runs.length > 1 ? (
                    <span className="agent-main-turns">{selectedConversation.runs.length} turns</span>
                  ) : null}
                </div>
                <div className="agent-main-meta">
                  {selectedConversation.status === "RUNNING" && canWriteComments ? (
                    <button
                      className="ghost-button agent-stop-button"
                      disabled={stoppingRunId === selectedConversation.latestRun.id}
                      onClick={() => {
                        setStoppingRunId(selectedConversation.latestRun.id);
                        onStopRun(selectedConversation.latestRun.id);
                      }}
                      title="Stop this agent run. Its work so far is committed, and a follow-up message continues the session."
                      type="button"
                    >
                      {stoppingRunId === selectedConversation.latestRun.id ? "Stopping…" : "◼ Stop"}
                    </button>
                  ) : null}
                  {selectedConversation.branchName ? (
                    <span><span className="agent-meta-label">branch</span> {selectedConversation.branchName}</span>
                  ) : null}
                  {selectedConversation.commitUrl ? (
                    <a href={selectedConversation.commitUrl} rel="noopener noreferrer" target="_blank">
                      commit {selectedConversation.commitSha?.slice(0, 7)}
                    </a>
                  ) : selectedConversation.commitSha ? (
                    <span><span className="agent-meta-label">commit</span> {selectedConversation.commitSha.slice(0, 7)}</span>
                  ) : null}
                </div>
              </header>

              <AgentTimeline
                events={selectedConversation.events}
                progress={selectedConversation.progress}
                status={selectedConversation.status}
              />

              <RunResultBlock
                documentId={documentId}
                run={selectedConversation.latestRun}
                shareToken={shareToken}
              />

              {canWriteComments ? (
                (() => {
                  const isEditSession = selectedConversation.runs[0]?.triggerType === "SELECTION_EDIT";
                  const composerBlocked = agentBusy || selectedIsRunning;
                  const placeholder = selectedIsRunning
                    ? "The agent is still running — stop it to send a follow-up."
                    : isEditSession
                      ? "Send a follow-up — the agent continues this edit from its previous work… (⌘/Ctrl + Enter)"
                      : "Reply to the agent… (⌘/Ctrl + Enter to send)";
                  const send = () => {
                    if (!composerBlocked && agentMessage.trim()) {
                      onSendAgentMessage({
                        previousRunId: selectedConversation.latestRun.id,
                        rootId: selectedConversation.rootId
                      });
                    }
                  };
                  return (
                    <form
                      className="agent-compose"
                      onSubmit={(event) => {
                        event.preventDefault();
                        send();
                      }}
                    >
                      <textarea
                        disabled={selectedIsRunning}
                        onChange={(event) => onAgentMessageChange(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            send();
                          }
                        }}
                        placeholder={placeholder}
                        rows={2}
                        value={agentMessage}
                      />
                      <button
                        className="primary-button"
                        disabled={composerBlocked || !agentMessage.trim()}
                        type="submit"
                      >
                        {agentBusy ? "Sending…" : isEditSession ? "Continue" : "Reply"}
                      </button>
                    </form>
                  );
                })()
              ) : null}
            </>
          ) : (
            <div className="agent-main-empty">
              <h3>Start a new conversation</h3>
              <p>Ask Claude to inspect the document, run code in the linked repo, or answer a question. Each thread keeps its own history so you can follow up.</p>
              {canWriteComments ? (
                <form
                  className="agent-compose agent-compose-standalone"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!agentBusy && agentMessage.trim()) {
                      onSendAgentMessage();
                    }
                  }}
                >
                  <textarea
                    autoFocus
                    onChange={(event) => onAgentMessageChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        if (!agentBusy && agentMessage.trim()) {
                          onSendAgentMessage();
                        }
                      }
                    }}
                    placeholder="What should Claude do? (⌘/Ctrl + Enter to send)"
                    rows={3}
                    value={agentMessage}
                  />
                  <button
                    className="primary-button"
                    disabled={agentBusy || !agentMessage.trim()}
                    type="submit"
                  >
                    {agentBusy ? "Sending…" : "Send"}
                  </button>
                </form>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
