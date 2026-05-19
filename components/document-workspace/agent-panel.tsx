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
  onClose: () => void;
  onSelectConversation: (rootId: string) => void;
  onStartNewConversation: () => void;
  onAgentMessageChange: (next: string) => void;
  onSendAgentMessage: (options?: AgentConversationOptions) => void;
}) {
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
