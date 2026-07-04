import { useState } from "react";

import {
  AGENT_EFFORTS,
  ANTHROPIC_AGENT_MODELS,
  OPENROUTER_AGENT_MODELS,
  OPENROUTER_MODEL_PREFIX,
  isOpenRouterAgentModel,
  isStorableAgentModel,
  normalizeAgentModel
} from "@/lib/agent-config";
import { cn, truncate } from "@/lib/utils";

import { AgentTimeline } from "./agent-timeline";
import type { AgentConversation } from "./conversations";
import type { ActiveAiRunView } from "./types";
import { formatRelativeTime } from "./utils";

type ComposeMode = "selected" | "new";

type AgentConversationOptions = {
  previousRunId?: string | null;
  rootId?: string | null;
};

export function AgentPanel({
  title,
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
  onAgentModelChange,
  onAgentEffortChange,
  onClose,
  onSelectConversation,
  onStartNewConversation,
  onAgentMessageChange,
  onSendAgentMessage
}: {
  title: string;
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
  onAgentModelChange: (model: string) => void;
  onAgentEffortChange: (effort: string) => void;
  onClose: () => void;
  onSelectConversation: (rootId: string) => void;
  onStartNewConversation: () => void;
  onAgentMessageChange: (next: string) => void;
  onSendAgentMessage: (options?: AgentConversationOptions) => void;
}) {
  const CUSTOM_SENTINEL = "__openrouter_custom__";
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  // Legacy stored aliases ("sonnet"/"opus") display as their canonical model;
  // the canonical value is what gets PATCHed on the next change.
  const normalizedModel = normalizeAgentModel(agentModel);
  const modelIsOpenRouter = isOpenRouterAgentModel(normalizedModel);
  const storedCustomModel =
    modelIsOpenRouter && !OPENROUTER_AGENT_MODELS.some((m) => m.value === normalizedModel)
      ? normalizedModel
      : null;
  // Keep a stored OpenRouter selection visible even if the key was deleted.
  const showOpenRouterGroup = hasOpenRouterKey || modelIsOpenRouter;

  function commitCustomSlug() {
    const raw = customDraft.trim();
    if (!raw) return;
    const value = raw.startsWith(OPENROUTER_MODEL_PREFIX) ? raw : `${OPENROUTER_MODEL_PREFIX}${raw}`;
    if (!isStorableAgentModel(value)) {
      setCustomError("Enter an OpenRouter slug like openai/gpt-5.2");
      return;
    }
    setCustomError(null);
    setCustomMode(false);
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
                if (value === CUSTOM_SENTINEL) {
                  setCustomMode(true);
                  setCustomError(null);
                  return;
                }
                setCustomMode(false);
                onAgentModelChange(value);
              }}
              title={canWriteDocument ? "Model the agent runs as" : "Only editors can change the model"}
              value={customMode ? CUSTOM_SENTINEL : normalizedModel}
            >
              <optgroup label="Anthropic">
                {ANTHROPIC_AGENT_MODELS.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </optgroup>
              {showOpenRouterGroup ? (
                <optgroup label="OpenRouter">
                  {OPENROUTER_AGENT_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                  {storedCustomModel ? (
                    <option value={storedCustomModel}>
                      {storedCustomModel.slice(OPENROUTER_MODEL_PREFIX.length)}
                    </option>
                  ) : null}
                  <option value={CUSTOM_SENTINEL}>Custom slug…</option>
                </optgroup>
              ) : null}
            </select>
          </label>
          <label className="agent-config-field">
            <span className="agent-config-label">Thinking</span>
            <select
              className="agent-config-select"
              disabled={!canWriteDocument || modelIsOpenRouter}
              onChange={(event) => onAgentEffortChange(event.target.value)}
              title={
                modelIsOpenRouter
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
                aria-label="Custom OpenRouter model slug"
                className="agent-config-custom-input"
                onChange={(event) => setCustomDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitCustomSlug();
                  }
                }}
                placeholder="openai/gpt-5.2"
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
          {!hasOpenRouterKey ? (
            <span className="agent-config-hint">
              {modelIsOpenRouter
                ? "This model needs OPENROUTER_API_KEY — add it in the Env menu."
                : "Add OPENROUTER_API_KEY in the Env menu to use OpenRouter models."}
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

              {canWriteComments ? (
                <form
                  className="agent-compose"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!agentBusy && agentMessage.trim()) {
                      onSendAgentMessage({
                        previousRunId: selectedConversation.latestRun.id,
                        rootId: selectedConversation.rootId
                      });
                    }
                  }}
                >
                  <textarea
                    onChange={(event) => onAgentMessageChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        if (!agentBusy && agentMessage.trim()) {
                          onSendAgentMessage({
                            previousRunId: selectedConversation.latestRun.id,
                            rootId: selectedConversation.rootId
                          });
                        }
                      }
                    }}
                    placeholder="Reply to the agent… (⌘/Ctrl + Enter to send)"
                    rows={2}
                    value={agentMessage}
                  />
                  <button
                    className="primary-button"
                    disabled={agentBusy || !agentMessage.trim()}
                    type="submit"
                  >
                    {agentBusy ? "Sending…" : "Reply"}
                  </button>
                </form>
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
