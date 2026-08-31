import { EnvironmentMenu } from "./environment-menu";
import { SelfHostedMenu } from "./self-hosted-menu";
import { SkillsMenu } from "./skills-menu";
import { useEffect, useState } from "react";

import {
  AGENT_EFFORTS,
  ANTHROPIC_AGENT_MODELS,
  CODEX_CHATGPT_AGENT_MODELS,
  CODEX_CHATGPT_MODEL_PREFIX,
  CODEX_LITELLM_AGENT_MODELS,
  CODEX_LITELLM_MODEL_PREFIX,
  CODEX_OPENAI_AGENT_MODELS,
  CODEX_OPENAI_MODEL_PREFIX,
  DEFAULT_AGENT_MODEL,
  defaultCodexAgentModelForCredentials,
  LOCAL_MODEL_PREFIX,
  isLocalAgentModel,
  LITELLM_AGENT_MODELS,
  LITELLM_MODEL_PREFIX,
  OPENROUTER_AGENT_MODELS,
  OPENROUTER_MODEL_PREFIX,
  isLiteLlmAgentModel,
  isOpenRouterAgentModel,
  isStorableAgentModel,
  agentHarnessForModel,
  normalizeAgentModel
} from "@/lib/agent-config";
import { cn, truncate } from "@/lib/utils";

import { AgentTimeline, agentDisplayName } from "./agent-timeline";
import { AgentTodoOutline } from "./agent-todo-outline";
import type { AgentConversation } from "./conversations";
import { MarkdownBody } from "./markdown";
import {
  classifyRunArtifacts,
  hasRenderableRunArtifacts,
  type RunArtifactComment,
  type RunArtifactSuggestion
} from "./run-result";
import type { ActiveAiRunView, AiRunEventView, ThreadView } from "./types";
import { formatRelativeTime } from "./utils";

// Structured outputs are persisted separately from the streaming transcript.
// Render those application artifacts directly: this recovers historical
// comment runs whose event stream contains only a terse summary, and gives
// edits, review comments, and tracked suggestions first-class presentations.
function RunResultBlock({
  documentId,
  events,
  run,
  shareToken
}: {
  documentId: string;
  events: AiRunEventView[];
  run: ActiveAiRunView;
  shareToken?: string | null;
}) {
  const [payload, setPayload] = useState<{
    replacementText: string | null;
    comments: RunArtifactComment[];
    suggestions: RunArtifactSuggestion[];
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const commentVersion = run.agentComments?.length ?? 0;

  useEffect(() => {
    let alive = true;
    setPayload(null);
    setCopied(false);
    const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
    fetch(`/api/documents/${documentId}/ai-runs/${run.id}${shareQuery}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!alive) return;
        const detail = data?.aiRun;
        setPayload({
          replacementText:
            typeof detail?.replacementText === "string" && detail.replacementText.trim()
              ? detail.replacementText
              : null,
          comments: Array.isArray(detail?.comments) ? detail.comments : [],
          suggestions: Array.isArray(detail?.suggestions) ? detail.suggestions : []
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [documentId, run.id, run.status, commentVersion, shareToken]);

  if (!payload) {
    return null;
  }

  const artifacts = classifyRunArtifacts({
    triggerType: run.triggerType,
    triggerId: run.triggerId ?? null,
    replacementText: payload.replacementText,
    comments: payload.comments,
    suggestions: payload.suggestions
  });
  // New runs also record the real final reply in the event timeline. Suppress
  // that duplicate; historical runs whose event contains only the summary keep
  // the persisted comment reply here.
  const eventMessages = new Set(events.map((event) => event.message.trim()));
  const finalReplies = artifacts.finalReplies.filter(
    (comment) => !eventMessages.has(comment.body.trim())
  );
  const visible = { ...artifacts, finalReplies };
  if (!hasRenderableRunArtifacts(visible)) return null;

  return (
    <section className="agent-run-artifacts" aria-label="Run results">
      {visible.finalEdit ? (
        <details className="agent-result" open>
          <summary className="agent-result-header">
            <span className="agent-tool-caret" aria-hidden />
            <span className="agent-result-title">Final edit</span>
            <span className="agent-result-hint">{`${visible.finalEdit.split("\n").length} lines`}</span>
            <button
              className="ghost-button agent-result-copy"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void navigator.clipboard?.writeText(visible.finalEdit!).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
              type="button"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </summary>
          <MarkdownBody body={visible.finalEdit} className="agent-result-body markdown-body" />
        </details>
      ) : null}

      {visible.finalReplies.map((comment) => (
        <div className="agent-artifact agent-artifact-reply" key={comment.id}>
          <div className="agent-artifact-header"><strong>Final comment reply</strong></div>
          <MarkdownBody body={comment.body} className="agent-result-body markdown-body" />
        </div>
      ))}

      {visible.standaloneComments.map((comment) => (
        <div className="agent-artifact agent-artifact-comment" key={comment.id}>
          <div className="agent-artifact-header">
            <strong>Comment</strong>
            {comment.anchorText ? <span>on “{truncate(comment.anchorText, 90)}”</span> : null}
          </div>
          <MarkdownBody body={comment.body} className="agent-result-body markdown-body" />
        </div>
      ))}

      {visible.suggestions.map((suggestion, index) => (
        <details className="agent-artifact agent-artifact-suggestion" key={`${suggestion.findText}-${index}`}>
          <summary className="agent-artifact-header">
            <span className="agent-tool-caret" aria-hidden />
            <strong>Suggestion {index + 1}</strong>
            {suggestion.reason ? <span>{truncate(suggestion.reason, 100)}</span> : null}
          </summary>
          {suggestion.reason ? <p className="agent-artifact-reason">{suggestion.reason}</p> : null}
          <div className="agent-artifact-diff">
            <pre className="agent-artifact-before"><span>−</span>{suggestion.findText}</pre>
            <pre className="agent-artifact-after"><span>+</span>{suggestion.replacementText || "(delete)"}</pre>
          </div>
        </details>
      ))}
    </section>
  );
}

// Long text with a local "Show more" toggle. Poll re-renders preserve the
// expansion because the state lives in the component, not the run payload.
function ExpandableText({ text, limit, className }: { text: string; limit: number; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsToggle = text.length > limit;
  const shown = expanded || !needsToggle ? text : `${text.slice(0, limit).trimEnd()}…`;
  return (
    <div className={className}>
      <span style={{ whiteSpace: "pre-wrap" }}>{shown}</span>
      {needsToggle ? (
        <button className="agent-context-toggle" onClick={() => setExpanded((v) => !v)} type="button">
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

// What kicked this conversation off. The sidebar and header only have room for
// a truncated first line, and for selection edits / comment replies the
// instruction alone doesn't tell you WHERE the run was aimed — this card shows
// the full prompt, the selected text the edit targeted, or the comment thread
// (with a jump back to it in the document).
function ConversationContextCard({
  conversation,
  threads,
  onOpenThread
}: {
  conversation: AgentConversation;
  threads: ThreadView[];
  onOpenThread?: (thread: ThreadView) => void;
}) {
  const root = conversation.runs[0];
  if (!root) return null;

  if (root.triggerType === "SELECTION_EDIT") {
    return (
      <div className="agent-context">
        <div className="agent-context-kind">Edit request on a selection</div>
        <ExpandableText className="agent-context-prompt" limit={420} text={conversation.rootInstruction} />
        {root.selectedText ? (
          <>
            <div className="agent-context-label">Selected text</div>
            <ExpandableText className="agent-context-quote" limit={360} text={root.selectedText} />
          </>
        ) : null}
      </div>
    );
  }

  if (root.triggerType === "COMMENT_THREAD") {
    const thread = root.triggerId ? threads.find((t) => t.id === root.triggerId) ?? null : null;
    return (
      <div className="agent-context">
        <div className="agent-context-kind">
          <span>Reply for a comment thread</span>
          {thread && onOpenThread ? (
            <button className="ghost-button agent-context-open" onClick={() => onOpenThread(thread)} type="button">
              Open thread
            </button>
          ) : null}
        </div>
        {thread ? (
          <>
            <div className="agent-context-label">Anchored to</div>
            <ExpandableText className="agent-context-quote" limit={360} text={thread.anchorText} />
            <div className="agent-context-meta">
              {thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}
              {thread.comments[0]
                ? ` · ${thread.comments[0].author?.name ?? thread.comments[0].guestName ?? "Claude"}: ${thread.comments[0].body.slice(0, 120)}${thread.comments[0].body.length > 120 ? "…" : ""}`
                : ""}
            </div>
          </>
        ) : (
          <div className="agent-context-meta">The comment thread no longer exists.</div>
        )}
      </div>
    );
  }

  // Plain conversations open with the full first message as a user bubble
  // right below — no card needed.
  return null;
}

type ComposeMode = "selected" | "new";

type AgentConversationOptions = {
  previousRunId?: string | null;
  rootId?: string | null;
};

export function AgentPanel({
  canManageAutomation,
  onEnvKeysChanged,
  title,
  documentId,
  shareToken,
  activeAiRuns,
  conversations,
  threads,
  onOpenThread,
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
  hasOpenAiKey,
  hasChatgptAuth,
  localModel,
  anthropicFreeFallback,
  runnerMode,
  isOwner,
  onAgentModelChange,
  onAgentEffortChange,
  onRunnerModeChange,
  onClose,
  onSelectConversation,
  onStartNewConversation,
  onAgentMessageChange,
  onSendAgentMessage,
  onSendLiveAgentMessage,
  agentEditMode,
  onAgentEditModeChange,
  onStopRun
}: {
  title: string;
  documentId: string;
  shareToken?: string | null;
  activeAiRuns: ActiveAiRunView[];
  conversations: AgentConversation[];
  /** Comment threads of the document — used to show what a COMMENT_THREAD run was triggered by. */
  threads: ThreadView[];
  /** Jump back to the triggering comment thread in the document. */
  onOpenThread?: (thread: ThreadView) => void;
  selectedConversation: AgentConversation | null;
  composeMode: ComposeMode;
  agentMessage: string;
  agentBusy: boolean;
  canWriteComments: boolean;
  canWriteDocument: boolean;
  canManageAutomation: boolean;
  onEnvKeysChanged: (keys: string[]) => void;
  agentModel: string;
  agentEffort: string;
  hasOpenRouterKey: boolean;
  hasLiteLlmKey: boolean;
  hasOpenAiKey: boolean;
  /** ChatGPT-subscription Codex auth is connected (doc env blob or a linked
   * "openai-chatgpt" credential). Presence only. */
  hasChatgptAuth: boolean;
  /** The deployment's free local model ("local/<name>") when configured. */
  localModel: string | null;
  /** No Anthropic credential anywhere: Anthropic-model runs would actually
   * execute on the free local model. Never display an Anthropic name as if it
   * will run. */
  anthropicFreeFallback: boolean;
  /** "managed" (default) or "selfHosted" — see Document.runnerMode. */
  runnerMode: string;
  isOwner: boolean;
  onAgentModelChange: (model: string) => void;
  onAgentEffortChange: (effort: string) => void;
  onRunnerModeChange: (mode: "managed" | "selfHosted") => void;
  onClose: () => void;
  onSelectConversation: (rootId: string) => void;
  onStartNewConversation: () => void;
  onAgentMessageChange: (next: string) => void;
  onSendAgentMessage: (options?: AgentConversationOptions) => void;
  onSendLiveAgentMessage: (runId: string) => void;
  agentEditMode: "suggest" | "edit";
  onAgentEditModeChange: (mode: "suggest" | "edit") => void;
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
  const CODEX_OPENAI_CUSTOM_SENTINEL = "__codex_openai_custom__";
  const CODEX_LITELLM_CUSTOM_SENTINEL = "__codex_litellm_custom__";
  const [customMode, setCustomMode] = useState<"openrouter" | "litellm" | "codex-openai" | "codex-litellm" | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  // Legacy stored aliases ("sonnet"/"opus") display as their canonical model;
  // the canonical value is what gets PATCHed on the next change.
  const normalizedModel = normalizeAgentModel(agentModel);
  const harness = agentHarnessForModel(normalizedModel);
  const isCodex = harness === "codex";
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
  const modelIsAnthropic = !modelIsThirdParty && !modelIsLocal;
  // Without a credential, an "Anthropic" selection actually runs the free
  // local model — say so in the option labels and below the selector.
  const anthropicSuffix = anthropicFreeFallback ? " — no credential, runs free local model" : "";
  const fallbackModelName = localModel ? localModel.slice(LOCAL_MODEL_PREFIX.length) : null;
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
  const codexModelIsLiteLlm = normalizedModel.startsWith(CODEX_LITELLM_MODEL_PREFIX);
  const codexModelIsChatgpt = normalizedModel.startsWith(CODEX_CHATGPT_MODEL_PREFIX);
  // Keep a stored subscription selection visible even if the auth was removed.
  const showChatgptGroup = hasChatgptAuth || codexModelIsChatgpt;
  const storedCustomCodexOpenAiModel =
    normalizedModel.startsWith(CODEX_OPENAI_MODEL_PREFIX) &&
    !CODEX_OPENAI_AGENT_MODELS.some((m) => m.value === normalizedModel)
      ? normalizedModel
      : null;
  const storedCustomCodexLiteLlmModel =
    codexModelIsLiteLlm && !CODEX_LITELLM_AGENT_MODELS.some((m) => m.value === normalizedModel)
      ? normalizedModel
      : null;
  const storedCustomCodexChatgptModel =
    codexModelIsChatgpt && !CODEX_CHATGPT_AGENT_MODELS.some((m) => m.value === normalizedModel)
      ? normalizedModel
      : null;

  function commitCustomSlug() {
    const raw = customDraft.trim();
    if (!raw || !customMode) return;
    const prefix = customMode === "openrouter"
      ? OPENROUTER_MODEL_PREFIX
      : customMode === "litellm"
        ? LITELLM_MODEL_PREFIX
        : customMode === "codex-openai"
          ? CODEX_OPENAI_MODEL_PREFIX
          : CODEX_LITELLM_MODEL_PREFIX;
    const value = raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
    if (!isStorableAgentModel(value)) {
      setCustomError(
        customMode === "openrouter"
          ? "Enter an OpenRouter slug like openai/gpt-5.2"
          : customMode === "codex-openai"
            ? "Enter an OpenAI model name like gpt-5.6-terra"
            : "Enter a LiteLLM model name like anthropic/claude-opus-5"
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
          {canManageAutomation ? (
            <>
              <EnvironmentMenu documentId={documentId} shareToken={shareToken ?? null} onKeysChanged={onEnvKeysChanged} />
              <SkillsMenu documentId={documentId} shareToken={shareToken ?? null} />
            </>
          ) : null}
          <SelfHostedMenu
            documentId={documentId}
            runnerMode={runnerMode}
            isOwner={isOwner}
            onRunnerModeChange={onRunnerModeChange}
          />
          <label className="agent-config-field">
            <span className="agent-config-label">Harness</span>
            <select
              className="agent-config-select"
              disabled={!canWriteDocument}
              onChange={(event) => {
                setCustomMode(null);
                onAgentModelChange(
                  event.target.value === "codex"
                    ? defaultCodexAgentModelForCredentials({ hasOpenAiKey, hasLiteLlmKey, hasChatgptAuth })
                    : DEFAULT_AGENT_MODEL
                );
              }}
              title="Agent execution harness"
              value={harness}
            >
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="agent-config-field">
            <span className="agent-config-label">Model</span>
            <select
              className="agent-config-select"
              disabled={!canWriteDocument}
              onChange={(event) => {
                const value = event.target.value;
                if ([OPENROUTER_CUSTOM_SENTINEL, LITELLM_CUSTOM_SENTINEL, CODEX_OPENAI_CUSTOM_SENTINEL, CODEX_LITELLM_CUSTOM_SENTINEL].includes(value)) {
                  setCustomMode(
                    value === OPENROUTER_CUSTOM_SENTINEL ? "openrouter" :
                    value === LITELLM_CUSTOM_SENTINEL ? "litellm" :
                    value === CODEX_OPENAI_CUSTOM_SENTINEL ? "codex-openai" : "codex-litellm"
                  );
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
                    : customMode === "codex-openai"
                      ? CODEX_OPENAI_CUSTOM_SENTINEL
                      : customMode === "codex-litellm"
                        ? CODEX_LITELLM_CUSTOM_SENTINEL
                    : normalizedModel
              }
            >
              {!isCodex ? <>
              <optgroup label="Anthropic">
                {ANTHROPIC_AGENT_MODELS.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                    {anthropicSuffix}
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
              </> : <>
                <optgroup label={hasOpenAiKey ? "OpenAI" : "OpenAI (requires API key)"}>
                  {CODEX_OPENAI_AGENT_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>{model.label}</option>
                  ))}
                  {storedCustomCodexOpenAiModel ? (
                    <option value={storedCustomCodexOpenAiModel}>{storedCustomCodexOpenAiModel.slice(CODEX_OPENAI_MODEL_PREFIX.length)}</option>
                  ) : null}
                  <option value={CODEX_OPENAI_CUSTOM_SENTINEL}>Custom OpenAI model…</option>
                </optgroup>
                {showChatgptGroup ? (
                  <optgroup label="ChatGPT subscription">
                    {CODEX_CHATGPT_AGENT_MODELS.map((model) => (
                      <option key={model.value} value={model.value}>{model.label}</option>
                    ))}
                    {storedCustomCodexChatgptModel ? (
                      <option value={storedCustomCodexChatgptModel}>{storedCustomCodexChatgptModel.slice(CODEX_CHATGPT_MODEL_PREFIX.length)}</option>
                    ) : null}
                  </optgroup>
                ) : null}
                {hasLiteLlmKey || codexModelIsLiteLlm ? (
                  <optgroup label="LiteLLM (OpenAI Responses)">
                    {CODEX_LITELLM_AGENT_MODELS.map((model) => (
                      <option key={model.value} value={model.value}>{model.label}</option>
                    ))}
                    {storedCustomCodexLiteLlmModel ? (
                      <option value={storedCustomCodexLiteLlmModel}>{storedCustomCodexLiteLlmModel.slice(CODEX_LITELLM_MODEL_PREFIX.length)}</option>
                    ) : null}
                    <option value={CODEX_LITELLM_CUSTOM_SENTINEL}>Custom LiteLLM model…</option>
                  </optgroup>
                ) : null}
              </>}
            </select>
          </label>
          <label className="agent-config-field">
            <span className="agent-config-label">Thinking</span>
            <select
              className="agent-config-select"
              disabled={!canWriteDocument || modelIsLocal}
              onChange={(event) => onAgentEffortChange(event.target.value)}
              title={
                modelIsLocal
                  ? "Thinking control is not available for the free local model"
                  : canWriteDocument
                    ? "Extended-thinking effort (thinking budget for non-Claude models)"
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
          {canWriteDocument ? (
            <label className="agent-config-field">
              <span className="agent-config-label">Document changes</span>
              <select
                className="agent-config-select"
                onChange={(event) => onAgentEditModeChange(event.target.value as "suggest" | "edit")}
                title="Choose whether document changes need review"
                value={agentEditMode}
              >
                <option value="suggest">Suggest (default)</option>
                <option value="edit">Edit directly</option>
              </select>
            </label>
          ) : null}
          {customMode ? (
            <div className="agent-config-field agent-config-custom-model">
              <input
                aria-label={
                  customMode === "openrouter" ? "Custom OpenRouter model slug" :
                  customMode === "codex-openai" ? "Custom OpenAI model name" : "Custom LiteLLM model name"
                }
                className="agent-config-custom-input"
                onChange={(event) => setCustomDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitCustomSlug();
                  }
                }}
                placeholder={customMode === "openrouter" ? "openai/gpt-5.2" : customMode === "codex-openai" ? "gpt-5.6-terra" : "anthropic/claude-opus-5"}
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
          {!isCodex && modelIsAnthropic && anthropicFreeFallback ? (
            <span className="agent-config-hint agent-config-error">
              No AI credential connected — agents run on the free local model
              {fallbackModelName ? ` ${fallbackModelName}` : ""} (very slow), not{" "}
              {ANTHROPIC_AGENT_MODELS.find((m) => m.value === normalizedModel)?.label ?? "Claude"}.
              Connect a credential under Settings (topbar) to use Claude.
            </span>
          ) : isCodex && codexModelIsChatgpt && !hasChatgptAuth ? (
            <span className="agent-config-hint">
              This model runs on a ChatGPT subscription — connect one (paste ~/.codex/auth.json)
              under Settings, or add CODEX_CHATGPT_AUTH_JSON in the Env menu.
            </span>
          ) : isCodex && codexModelIsLiteLlm && !hasLiteLlmKey ? (
            <span className="agent-config-hint">Codex via LiteLLM needs LITELLM_API_KEY and an OpenAI-compatible Responses endpoint.</span>
          ) : isCodex && !codexModelIsChatgpt && !codexModelIsLiteLlm && !hasOpenAiKey ? (
            <span className="agent-config-hint">Native Codex needs an OpenAI API key. Select a LiteLLM or ChatGPT-subscription model to use another credential.</span>
          ) : modelIsOpenRouter && !hasOpenRouterKey ? (
            <span className="agent-config-hint">
              This model needs an OpenRouter key — add OPENROUTER_API_KEY in the Env menu or connect
              one under Settings.
            </span>
          ) : modelIsLiteLlm && !hasLiteLlmKey ? (
            <span className="agent-config-hint">
              This model needs a LiteLLM key — add LITELLM_API_KEY in the Env menu or connect one
              under Settings.
            </span>
          ) : !hasOpenRouterKey && !hasLiteLlmKey ? (
            <span className="agent-config-hint">
              For OpenRouter/LiteLLM models, add a key in the Env menu or connect one under AI
              settings.
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
                agentName={agentDisplayName(selectedConversation.latestRun.model)}
                documentId={documentId}
                events={selectedConversation.events}
                progress={selectedConversation.progress}
                status={selectedConversation.status}
                intro={
                  <ConversationContextCard
                    conversation={selectedConversation}
                    key={`context-${selectedConversation.rootId}`}
                    onOpenThread={onOpenThread}
                    threads={threads}
                  />
                }
                outro={
                  <div className="agent-run-artifact-list">
                    {selectedConversation.runs.map((run) => (
                      <RunResultBlock
                        documentId={documentId}
                        events={selectedConversation.events}
                        key={`result-${run.id}`}
                        run={run}
                        shareToken={shareToken}
                      />
                    ))}
                  </div>
                }
              />

              <AgentTodoOutline events={selectedConversation.events} />

              {canWriteComments ? (
                (() => {
                  const isEditSession = selectedConversation.runs[0]?.triggerType === "SELECTION_EDIT";
                  const composerBlocked = selectedIsRunning ? false : agentBusy;
                  const placeholder = selectedIsRunning
                    ? "Send an update to the running agent… (⌘/Ctrl + Enter)"
                    : isEditSession
                      ? "Send a follow-up — the agent continues this edit from its previous work… (⌘/Ctrl + Enter)"
                      : "Reply to the agent… (⌘/Ctrl + Enter to send)";
                  const send = () => {
                    if (!composerBlocked && agentMessage.trim()) {
                      if (selectedIsRunning) {
                        onSendLiveAgentMessage(selectedConversation.latestRun.id);
                        return;
                      }
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
                        {selectedIsRunning ? "Send update" : agentBusy ? "Sending…" : isEditSession ? "Continue" : "Reply"}
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
                <>
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
                </>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
