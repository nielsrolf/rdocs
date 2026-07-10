"use client";

import ImageExtension from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskList from "@tiptap/extension-task-list";
import Underline from "@tiptap/extension-underline";
import { getVersion, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import { NodeSelection } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import type { Mapping } from "@tiptap/pm/transform";
import { EditorContent, JSONContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_AGENT_EFFORT, DEFAULT_AGENT_MODEL } from "@/lib/agent-config";
import type { PermissionLevelValue, ThreadStatusValue } from "@/lib/contracts";
import { toggleReactionLocal, type ReactionSummary } from "@/lib/reactions";

import { AgentPanel } from "./document-workspace/agent-panel";
import { ToolbarButton, insertImagesAtPosition } from "./document-workspace/atoms";
import {
  aiEditRunHasApplicableContent,
  buildAiEditInsertContent,
  normalizeWidgetsOutsideTables,
  type ExistingWidget
} from "./document-workspace/ai-edit-insert";
import {
  AiEditSelections,
  cleanupStaleAiEditRangeMarksAfterRunsLoaded,
  describeAiEditSelectionPresence,
  getAiEditSelectionRange,
  removeAiEditSelection,
  reseedAiEditSelectionsFromDoc,
  resolveAiEditApplyRange,
  syncAiEditSelectionRuns,
  upsertAiEditSelection
} from "./document-workspace/ai-edit-selections";
import { buildAiEditRemountTransaction } from "./document-workspace/ai-edit-remount";
import { resolveSuggestionRange, type AgentSuggestionInput } from "./document-workspace/ai-suggestions";
import { submitPendingReplyThenAskAi } from "./document-workspace/ask-ai-flow";
import {
  Suggestions,
  acceptAllSuggestions,
  acceptSuggestion,
  collectSuggestionRanges,
  createSuggestionId,
  markExplicitSuggestion,
  rejectAllSuggestions,
  rejectSuggestion,
  setSuggestionMode,
  suggestionPluginKey,
  type SuggestionAuthor,
  type SuggestionSummary
} from "./document-workspace/suggestions";
import { CommentRail } from "./document-workspace/comment-rail";
import { DocOutline, OUTLINE_MAX_WIDTH, OUTLINE_MIN_WIDTH } from "./document-workspace/doc-outline";
import { MoveBlock, SlashTab, StrikeShortcut, TaskItem } from "./document-workspace/editor-extras";
import { EnvironmentMenu } from "./document-workspace/environment-menu";
import { SkillsMenu } from "./document-workspace/skills-menu";
import { ExportMenu } from "./document-workspace/export-menu";
import { FileMenu } from "./document-workspace/file-menu";
import { SelectionPopover } from "./document-workspace/selection-popover";
import { createSerialQueue } from "./document-workspace/serial-queue";
import { deferToForeground } from "./document-workspace/remote-update-guard";
import { LinkPopover } from "./document-workspace/link-popover";
import { HeadingCopyOverlay } from "./document-workspace/heading-copy-overlay";
import {
  buildCommentAnchorTransaction,
  CommentAnchor,
  createCommentHighlightExtension,
  resolveCommentAnchorRange
} from "./document-workspace/comment-anchors";
import {
  buildMentionInsertTransaction,
  createMentionDecorationExtension,
  Mention
} from "./document-workspace/mention";
import {
  filterMentionCandidates,
  findActiveMentionQuery,
  mentionHandle,
  type MentionCandidate
} from "@/lib/mentions";
import {
  createCollaborationExtension,
  createRemotePresenceExtension,
  planCollaborationPush,
  planDivergenceRecovery,
  type CollaborationStepResponse,
  type ReceivedMappingEntry,
  type RemotePresenceView
} from "./document-workspace/collaboration";
import { DivergenceMergeDialog } from "./document-workspace/divergence-merge-dialog";
import type { DocNode } from "@/lib/document-merge";
import { useCollaborationStream } from "./document-workspace/use-collaboration-stream";
import { usePresence } from "./document-workspace/use-presence";
import { FindBar } from "./document-workspace/find-bar";
import { SearchExtension } from "./document-workspace/search";
import { aiRunsFingerprint, buildConversations } from "./document-workspace/conversations";
import { createLatexRenderExtension } from "./document-workspace/latex";
import { AttachmentChip, EmbeddedWidget, RepoImage, TabBreak } from "./document-workspace/nodes";
import {
  createTabId,
  createTabsVisibilityExtension,
  ensureTabsHaveContent,
  listTabs,
  normalizePreludeTab,
  setActiveTab,
  type TabSummary
} from "./document-workspace/tabs";
import { aiEditSelectionIdsAttributeSpec, commentThreadIdsAttributeSpec } from "@/lib/document-schema-nodes";

// Upper bound on a single collaboration push. A push that never settles (e.g.
// the laptop sleeping mid-request) must not be allowed to wedge the in-flight
// lock forever — that silently disables every future save. Well under
// Cloudflare's ~100s origin cutoff; pushes are tiny and normally finish in ms.
const COLLAB_PUSH_TIMEOUT_MS = 45_000;
// After a network failure / timed-out push, wait this long before retrying so a
// transient outage recovers on its own without hammering the server.
const COLLAB_PUSH_RETRY_DELAY_MS = 3_000;

const Image = ImageExtension.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...commentThreadIdsAttributeSpec,
      ...aiEditSelectionIdsAttributeSpec
    };
  }
});
import { ShareModal } from "./document-workspace/share-modal";
import { TableInlineControls } from "./document-workspace/table-inline-controls";
import { useAgentNotifications } from "./document-workspace/use-agent-notifications";
import { VersionHistoryModal } from "./document-workspace/version-history-modal";
import { WidgetDialog } from "./document-workspace/widget-dialog";
import {
  DEFAULT_COMMENT_TAGS,
  type ActiveAiRunView,
  type ActiveAiTarget,
  type AiEditImage,
  type AiEditWidget,
  type CommentTagFilterValue,
  type DocumentWorkspaceProps,
  type HighlightThread,
  type MemberView,
  type SelectionPopoverMode,
  type SelectionState,
  type ShareLinkView,
  type ThreadView,
  type VersionView,
  type WidgetDraft
} from "./document-workspace/types";
import {
  describeNodeSelection,
  buildAiRunSelectionTriggerId,
  getSelectionContext,
  getSelectionContextFromEditor,
  getSelectionMarkdownFromEditor,
  getThreadTags,
  isThreadUnread,
  logClientEvent,
  parseAiRunSelectionId
} from "./document-workspace/utils";
import { OnboardingTour, emitTourEvent } from "@/components/onboarding-tour";

function createCollaborationClientId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createAiEditSelectionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `selection-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createPresenceColor(input: string) {
  const colors = ["#1a73e8", "#188038", "#d93025", "#9334e6", "#e8710a", "#00796b", "#c5221f"];
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }

  return colors[hash % colors.length];
}

function computeDocStats(text: string) {
  const trimmed = text.trim();
  return {
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    characters: text.length
  };
}

export function DocumentWorkspace({
  currentUserId,
  currentUserName,
  documentId,
  initialTitle,
  initialContent,
  initialCollaborationVersion,
  initialDocumentUpdatedAt,
  initialPermission,
  initialMembers,
  mentionMembers,
  initialMentionedCommentIds,
  initialThreads,
  initialShareLinks,
  initialRepoUrl,
  initialRepoBranch,
  initialAgentModel,
  initialAgentEffort,
  initialHasOpenRouterKey,
  initialHasLiteLlmKey,
  localAgentModel,
  credentialHasOpenRouterKey,
  credentialHasLiteLlmKey,
  isAuthenticated,
  isOwner,
  shareToken,
  viaShareLink
}: DocumentWorkspaceProps) {
  const isPublicView = viaShareLink && initialPermission === "VIEW";
  const [title, setTitle] = useState(initialTitle);
  const [members, setMembers] = useState<MemberView[]>(initialMembers);
  const [threads, setThreads] = useState<ThreadView[]>(initialThreads);
  const [shareLinks, setShareLinks] = useState<ShareLinkView[]>(initialShareLinks);
  const [repoUrl, setRepoUrl] = useState(initialRepoUrl ?? "");
  const [repoBranch, setRepoBranch] = useState(initialRepoBranch ?? "");
  const [agentModel, setAgentModel] = useState(initialAgentModel ?? DEFAULT_AGENT_MODEL);
  const [agentEffort, setAgentEffort] = useState(initialAgentEffort ?? DEFAULT_AGENT_EFFORT);
  const [hasOpenRouterKey, setHasOpenRouterKey] = useState(initialHasOpenRouterKey);
  const [hasLiteLlmKey, setHasLiteLlmKey] = useState(initialHasLiteLlmKey);
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoNotice, setRepoNotice] = useState<string | null>(null);
  const [repoAccessIssue, setRepoAccessIssue] = useState<{
    login: string | null;
    tokenSource: string;
  } | null>(null);
  // Bumped on every doc-changing transaction (local or remote) so anchor-derived
  // memos (e.g. visibleThreads) recompute when content — and its comment anchors —
  // is deleted. Keeps orphaned comments from lingering after a select-all delete.
  const [docRevision, setDocRevision] = useState(0);
  // Comment ids to briefly flash-highlight (arrived via a mention notification).
  const [flashCommentIds, setFlashCommentIds] = useState<Set<string>>(
    () => new Set(initialMentionedCommentIds)
  );
  // In-editor @mention autocomplete (doc body). Null when not active.
  const [docMention, setDocMention] = useState<{
    query: string;
    from: number;
    to: number;
    items: MentionCandidate[];
    index: number;
    left: number;
    top: number;
  } | null>(null);
  const docMentionRef = useRef<typeof docMention>(null);
  docMentionRef.current = docMention;
  const [documentUpdatedAt, setDocumentUpdatedAt] = useState(initialDocumentUpdatedAt);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [selectionPopoverMode, setSelectionPopoverMode] = useState<SelectionPopoverMode | null>(null);
  const [composerBody, setComposerBody] = useState("");
  const [editInstruction, setEditInstruction] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [docStats, setDocStats] = useState<{ words: number; characters: number }>({ words: 0, characters: 0 });
  const [globalError, setGlobalError] = useState<string | null>(null);
  const reportClientError = useCallback(
    (message: string, scope: string, data?: unknown) => {
      setGlobalError(message);
      logClientEvent({
        scope,
        level: "error",
        message,
        data: data === undefined ? null : data
      });
    },
    []
  );
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreads[0]?.id ?? null);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [creatingLink, setCreatingLink] = useState<PermissionLevelValue | null>(null);
  const [aiBusyThreadId, setAiBusyThreadId] = useState<string | null>(null);
  const [replyBusyThreadId, setReplyBusyThreadId] = useState<string | null>(null);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentTagFilters, setCommentTagFilters] = useState<Record<string, CommentTagFilterValue>>({
    resolved: "no"
  });
  const [activeAiRun, setActiveAiRun] = useState<ActiveAiRunView | null>(null);
  const [activeAiRuns, setActiveAiRuns] = useState<ActiveAiRunView[]>([]);
  const [aiRuns, setAiRuns] = useState<ActiveAiRunView[]>([]);
  // False until the first server-derived run list arrives (applyRemoteSnapshot).
  // Gates the mount-time stale-mark sweep: sweeping before then would strip the
  // anchors of runs we simply haven't heard about yet.
  const [aiRunsLoaded, setAiRunsLoaded] = useState(false);
  // A SELECTION_EDIT run that FAILED but whose selection marker is still alive,
  // so the user can retry without re-selecting. Cleared on retry success or when
  // the user dismisses it (which also removes the marker). See Item 4 / retryFailedAiEdit.
  const [failedAiEdit, setFailedAiEdit] = useState<{
    selectionId: string;
    aiRunId: string;
    instruction: string;
    error: string;
  } | null>(null);
  const aiEditRunStateRef = useRef<Map<string, "applying" | "applied" | "failed">>(new Map());
  // Serializes AI-run applies. Two runs finishing in the same poll cycle must not
  // apply concurrently: each apply ends by remounting the editor via setContent of a
  // snapshot taken mid-apply, so an overlapping apply would reset the doc to a stale
  // snapshot and drop the other run's content. See serial-queue.ts.
  const aiApplyQueueRef = useRef(createSerialQueue());
  // The async ask-ai / agent-conversation run ids we're waiting on (cleared when
  // they reach a terminal state in the polled aiRuns; see the completion effect).
  const askAiRunIdRef = useRef<string | null>(null);
  const agentRunIdRef = useRef<string | null>(null);
  const mountedAtRef = useRef<number>(Date.now());
  const [, setActiveAiTarget] = useState<ActiveAiTarget | null>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [composeMode, setComposeMode] = useState<"selected" | "new">("selected");
  const [agentMessage, setAgentMessage] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePermission, setInvitePermission] = useState<PermissionLevelValue>("COMMENT");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [deleteBusyCommentId, setDeleteBusyCommentId] = useState<string | null>(null);
  const [editBusyCommentId, setEditBusyCommentId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [formatBarOpen, setFormatBarOpen] = useState(false);
  const [chromeMenuOpen, setChromeMenuOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<VersionView[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [restoringVersion, setRestoringVersion] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [widgetDialogOpen, setWidgetDialogOpen] = useState(false);
  const [widgetDraft, setWidgetDraft] = useState<WidgetDraft>({
    label: "",
    buildCmd: "",
    embedSource: ""
  });
  const [widgetBusy, setWidgetBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);
  // Set when an unrecoverable divergence is detected with another client present
  // (so the sole-client force-push is off the table): drives the manual merge
  // dialog. `localContent` is this tab's copy at detection time.
  const [mergeState, setMergeState] = useState<{ localContent: JSONContent } | null>(null);
  const [remotePresence, setRemotePresence] = useState<RemotePresenceView[]>([]);
  const [threadOffsets, setThreadOffsets] = useState<Record<string, number>>({});
  const [railHeight, setRailHeight] = useState(640);
  const [newTagThreadId, setNewTagThreadId] = useState<string | null>(null);
  const [newTagDraft, setNewTagDraft] = useState("");
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [outlineWidth, setOutlineWidth] = useState(220);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TabSummary[]>([]);
  const [tableControlsActive, setTableControlsActive] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const collaborationFlushTimerRef = useRef<number | null>(null);
  const collaborationPushBusyRef = useRef(false);
  const collaborationPushQueuedRef = useRef(false);
  const collaborationPullBusyRef = useRef(false);
  // Guards the sole-client force-push recovery so a divergence can't fire it
  // concurrently or repeatedly while a previous attempt is still in flight.
  const forcePushBusyRef = useRef(false);
  // Latched once an unrecoverable divergence is being handled. Every divergence-
  // detection site funnels through handleUnrecoverableDivergence(); this stops the
  // SSE/poll loop from re-triggering recovery (and hammering the server) while a
  // force-push reload is pending or the merge dialog is open.
  const divergenceHandlingRef = useRef(false);
  const typingClearTimerRef = useRef<number | null>(null);
  const isApplyingRemoteUpdateRef = useRef(false);
  const hasUnsavedChangesRef = useRef(false);
  // One-shot version metadata attached to the NEXT collaboration step push.
  // The AI-edit apply path sets this and then flushes so the agent's
  // commit/sources/run id land on the post-edit version, without a separate
  // full-content PATCH (which would write Document.content out-of-band and
  // desync the live collaboration room).
  const pendingCollabVersionMetaRef = useRef<{
    forceVersion?: boolean;
    sourceLinks?: string[];
    commitSha?: string | null;
    commitUrl?: string | null;
    aiRunId?: string | null;
  } | null>(null);
  const titleRef = useRef(initialTitle);
  const documentUpdatedAtRef = useRef(initialDocumentUpdatedAt);
  const replyDraftsRef = useRef<Record<string, string>>({});
  const [replyDraftTick, setReplyDraftTick] = useState(0);
  const editorPageRef = useRef<HTMLDivElement | null>(null);
  const threadsRef = useRef<HighlightThread[]>(initialThreads);
  const activeThreadIdRef = useRef<string | null>(initialThreads[0]?.id ?? null);
  const previousAiRunsRef = useRef<Record<string, string>>({});
  const lastAiRunsFingerprintRef = useRef<string>("");
  const remotePresenceRef = useRef<RemotePresenceView[]>([]);
  const receivedMappingsRef = useRef<ReceivedMappingEntry[]>([]);
  const currentUserIdRef = useRef<string | null>(currentUserId);
  currentUserIdRef.current = currentUserId;
  const collabClientIdRef = useRef(createCollaborationClientId());
  const collabColorRef = useRef(createPresenceColor(collabClientIdRef.current));
  // Last time the SSE stream delivered anything (incl. the 15s keepalive ping).
  // While the stream is live, server pushes make the 500ms step/presence polls
  // redundant, so we skip them — see SSE_HEALTHY_WINDOW_MS below.
  const lastSseAtRef = useRef(0);
  const {
    ensurePermission: ensureAgentNotificationPermission,
    notifyDone: notifyAgentDone,
    notifyCompleted: notifyAgentCompleted,
    agentToast,
    dismissToast: dismissAgentToast
  } = useAgentNotifications();
  // Anonymous visitors holding a COMMENT/EDIT share link can comment too — the
  // server resolves their access from the token, like collab pushes and AI edits.
  const canWriteComments = (isAuthenticated || Boolean(shareToken)) && initialPermission !== "VIEW";
  const canWriteDocument = initialPermission === "EDIT";
  // Mirrors canManageDocumentAutomation server-side: signed-in edit access,
  // including edit gained via a share link.
  const canManageAutomation = canWriteDocument && isAuthenticated;
  // Comment-access users (can comment but not edit) are locked into suggesting
  // mode: the editor is interactive for them, but every change is forced into a
  // tracked-change suggestion. Editors default to direct editing and can toggle.
  const suggestOnlyUser = canWriteComments && !canWriteDocument;
  const canPersistEdits = canWriteDocument || canWriteComments;
  const [suggestingMode, setSuggestingMode] = useState(suggestOnlyUser);
  const suggestingModeRef = useRef(suggestingMode);
  suggestingModeRef.current = suggestingMode;
  const suggestionAuthor = useMemo<SuggestionAuthor>(
    () => ({ authorId: currentUserId, authorLabel: currentUserName ?? null }),
    [currentUserId, currentUserName]
  );
  // Pending suggestions present in the document, recomputed as the doc changes
  // (docRevision bumps on every doc-changing transaction).
  const [suggestionSummaries, setSuggestionSummaries] = useState<SuggestionSummary[]>([]);
  const [suggestionPanelOpen, setSuggestionPanelOpen] = useState(false);
  // Inline Accept/Reject affordance shown when the caret sits inside a suggestion.
  const [suggestionPopover, setSuggestionPopover] = useState<{
    id: string;
    label: string;
    authorLabel: string | null;
    top: number;
    left: number;
  } | null>(null);
  // Distinct suggestions (a find/replace shares one id across its delete+insert
  // parts), ordered by document position, for the review panel.
  const distinctSuggestions = useMemo(() => {
    const byId = new Map<string, { id: string; authorLabel: string | null; from: number; kinds: Set<string> }>();
    for (const summary of suggestionSummaries) {
      const existing = byId.get(summary.suggestionId);
      if (existing) {
        existing.kinds.add(summary.kind);
        existing.from = Math.min(existing.from, summary.from);
      } else {
        byId.set(summary.suggestionId, {
          id: summary.suggestionId,
          authorLabel: summary.author.authorLabel,
          from: summary.from,
          kinds: new Set([summary.kind])
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.from - b.from);
  }, [suggestionSummaries]);

  const commentHighlightExtension = useMemo(
    () =>
      createCommentHighlightExtension(threadsRef, activeThreadIdRef, (threadId) => {
        setActiveThreadId(threadId);
        setSelectionPopoverMode(null);
      }),
    []
  );
  const mentionDecorationExtension = useMemo(
    () => createMentionDecorationExtension(currentUserIdRef),
    []
  );
  const mentionViewer = useMemo(
    () => ({ members: mentionMembers, currentUserId }),
    [mentionMembers, currentUserId]
  );
  const latexRenderExtension = useMemo(() => createLatexRenderExtension(), []);
  const collaborationExtension = useMemo(
    () => createCollaborationExtension(initialCollaborationVersion, collabClientIdRef.current),
    [initialCollaborationVersion]
  );
  const remotePresenceExtension = useMemo(
    () => createRemotePresenceExtension(remotePresenceRef, receivedMappingsRef),
    []
  );
  const tabsVisibilityExtension = useMemo(
    () => createTabsVisibilityExtension(null),
    []
  );
  const handleCreateTabRef = useRef<(() => void) | null>(null);
  const slashTabExtension = useMemo(
    () =>
      SlashTab.configure({
        onInsertTab: () => {
          handleCreateTabRef.current?.();
          return true;
        }
      }),
    []
  );

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  // Arrived from a mention notification: open the mentioning thread, scroll the
  // flashed comment into view, then fade the highlight after a few seconds.
  useEffect(() => {
    if (initialMentionedCommentIds.length === 0) return;
    const ids = new Set(initialMentionedCommentIds);
    const targetThread = threads.find((thread) =>
      thread.comments.some((comment) => ids.has(comment.id))
    );
    if (targetThread) {
      setActiveThreadId(targetThread.id);
      window.requestAnimationFrame(() => {
        document
          .querySelector(".comment-bubble-mention-flash")
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    const timer = window.setTimeout(() => setFlashCommentIds(new Set()), 6000);
    return () => window.clearTimeout(timer);
    // Mount-only: the notification context is fixed for this page load.
  }, []);

  useEffect(() => {
    const trimmed = title.trim();
    document.title = trimmed ? `${trimmed} — r-docs` : "r-docs";
  }, [title]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("r-docs:outline-collapsed");
      if (stored === "true") {
        setOutlineCollapsed(true);
      }
      const storedWidth = window.localStorage.getItem("r-docs:outline-width");
      if (storedWidth) {
        const parsed = Number.parseInt(storedWidth, 10);
        if (Number.isFinite(parsed)) {
          setOutlineWidth(Math.min(OUTLINE_MAX_WIDTH, Math.max(OUTLINE_MIN_WIDTH, parsed)));
        }
      }
    } catch {
      // Storage unavailable; keep default.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "r-docs:outline-collapsed",
        outlineCollapsed ? "true" : "false"
      );
    } catch {
      // Ignore quota / privacy errors.
    }
  }, [outlineCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem("r-docs:outline-width", String(Math.round(outlineWidth)));
    } catch {
      // Ignore quota / privacy errors.
    }
  }, [outlineWidth]);

  useEffect(() => {
    documentUpdatedAtRef.current = documentUpdatedAt;
  }, [documentUpdatedAt]);

  useEffect(() => {
    if (!globalError) return;
    const timeout = window.setTimeout(() => setGlobalError(null), 8000);
    return () => window.clearTimeout(timeout);
  }, [globalError]);

  useEffect(() => {
    if (!isPublicView) return;
    document.body.classList.add("public-view-shell");
    return () => {
      document.body.classList.remove("public-view-shell");
    };
  }, [isPublicView]);

  useEffect(() => {
    function closeOpenHeaderMenus(exception: Element | null) {
      const openMenus = document.querySelectorAll<HTMLDetailsElement>("details.header-menu[open]");
      openMenus.forEach((node) => {
        if (exception && node.contains(exception)) return;
        node.open = false;
      });
    }
    function handlePointerDown(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target : null;
      const insideMenu = target ? target.closest("details.header-menu") : null;
      closeOpenHeaderMenus(insideMenu);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeOpenHeaderMenus(null);
    }
    function handleClickInside(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const ownMenu = target.closest("details.header-menu");
      if (!ownMenu) return;
      if (target.closest("summary")) return;
      const link = target.closest("a");
      if (link) {
        closeOpenHeaderMenus(null);
        return;
      }
      closeOpenHeaderMenus(ownMenu);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("click", handleClickInside);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("click", handleClickInside);
    };
  }, []);

  function syncAiRuns(nextRuns: ActiveAiRunView[]) {
    // No-op polls (identical content, fresh object identities) must not
    // re-set state: the resulting re-render disturbs text selection and
    // auto-scroll in the agent view.
    const fingerprint = aiRunsFingerprint(nextRuns);
    if (fingerprint === lastAiRunsFingerprintRef.current) {
      return;
    }
    lastAiRunsFingerprintRef.current = fingerprint;

    const previous = previousAiRunsRef.current;

    nextRuns.forEach((run) => {
      const previousStatus = previous[run.id];
      if (previousStatus === "RUNNING" && run.status !== "RUNNING") {
        notifyAgentDone(run);
      }
      previous[run.id] = run.status;
    });

    previousAiRunsRef.current = previous;
    setAiRuns(nextRuns);
    setActiveAiRuns(nextRuns.filter((run) => run.status === "RUNNING"));
    setActiveAiRun(nextRuns.find((run) => run.status === "RUNNING") ?? null);
  }

  function updateThreadOffsets() {
    if (!editor || !editorPageRef.current) {
      return;
    }

    const pageRect = editorPageRef.current.getBoundingClientRect();
    const nextOffsets = threads
      .map((thread) => {
        try {
          const range = resolveCommentAnchorRange(editor.state.doc, thread);
          const top = range ? editor.view.coordsAtPos(range.fromPos).top - pageRect.top : 0;
          return { id: thread.id, top: Math.max(16, top) };
        } catch {
          return { id: thread.id, top: 16 };
        }
      })
      .sort((left, right) => left.top - right.top);

    let cursor = 16;
    const normalized: Record<string, number> = {};

    nextOffsets.forEach((item) => {
      const top = Math.max(item.top, cursor);
      normalized[item.id] = top;
      cursor = top + (item.id === activeThreadId ? 264 : 152);
    });

    setThreadOffsets(normalized);
    setRailHeight(Math.max(editorPageRef.current.offsetHeight, cursor + 32));
  }

  function markCollaborationSavedIfSettled() {
    if (!editor || sendableSteps(editor.state)) {
      return;
    }

    hasUnsavedChangesRef.current = false;
    setSaveState("saved");
  }

  const RECEIVED_MAPPING_BUFFER_LIMIT = 500;
  function recordReceivedMapping(versionBefore: number, mapping: Mapping) {
    const buffer = receivedMappingsRef.current;
    buffer.push({ versionBefore, mapping });
    if (buffer.length > RECEIVED_MAPPING_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - RECEIVED_MAPPING_BUFFER_LIMIT);
    }
  }

  function applyCollaborationPayload(payload: CollaborationStepResponse) {
    if (!editor || !Array.isArray(payload.steps) || payload.steps.length === 0) {
      markCollaborationSavedIfSettled();
      return true;
    }

    const clientIds = Array.isArray(payload.clientIds) ? payload.clientIds : [];
    if (clientIds.length !== payload.steps.length) {
      return false;
    }

    if (typeof payload.fromVersion === "number") {
      const currentVersion = getVersion(editor.state);
      if (payload.fromVersion < currentVersion) {
        markCollaborationSavedIfSettled();
        return true;
      }

      if (payload.fromVersion > currentVersion) {
        void pullCollaborationSteps();
        return true;
      }
    }

    try {
      const steps = payload.steps.map((step) => Step.fromJSON(editor.schema, step));
      isApplyingRemoteUpdateRef.current = true;
      const versionBefore = getVersion(editor.state);
      const receiveTr = receiveTransaction(editor.state, steps, clientIds, {
        mapSelectionBackward: true
      });
      // Tell the suggestions interceptor to ignore this apply — foreign steps
      // already carry their author's marks; we must not re-mark them as ours.
      receiveTr.setMeta(suggestionPluginKey, { type: "skip" });
      recordReceivedMapping(versionBefore, receiveTr.mapping);
      editor.view.dispatch(receiveTr);
      if (typeof payload.updatedAt === "string") {
        setDocumentUpdatedAt(payload.updatedAt);
      }
      setRemoteNotice(null);
      markCollaborationSavedIfSettled();
      return true;
    } catch {
      setRemoteNotice("Live collaboration lost sync. Refresh this document to reconnect.");
      return false;
    } finally {
      // Reset the guard via a microtask, NOT requestAnimationFrame: rAF is
      // frozen in backgrounded tabs, which previously left this guard stuck
      // `true` and silently disabled saving ("forever Saving"). The layout-only
      // updateThreadOffsets can stay on rAF.
      deferToForeground(() => {
        isApplyingRemoteUpdateRef.current = false;
      });
      window.requestAnimationFrame(() => {
        updateThreadOffsets();
      });
    }
  }

  async function flushCollaborationSteps() {
    if (!editor || collaborationPushBusyRef.current) {
      collaborationPushQueuedRef.current = true;
      return;
    }

    const sendable = sendableSteps(editor.state);
    if (!sendable || sendable.steps.length === 0) {
      hasUnsavedChangesRef.current = false;
      setSaveState("saved");
      return;
    }

    collaborationPushBusyRef.current = true;
    collaborationPushQueuedRef.current = false;

    // Chunk a large flush. A single AI reformat or a big paste can produce many
    // hundreds of steps, but the server rejects any push above its cap with a
    // non-recoverable 400 ("steps:too_big"), which used to strand the tab on
    // "Save failed" forever. Send at most one batch now; once it's confirmed the
    // collab plugin advances its version and the re-flush queued below drains
    // the rest, so an edit of any size eventually saves.
    const { batch, isFinalBatch } = planCollaborationPush(sendable.steps);

    // Attach any one-shot AI-edit version metadata ONLY to the batch that drains
    // the buffer, so the version snapshot records the complete post-edit content
    // (with commit attribution) rather than an intermediate chunk. Kept until
    // accepted (a 409 rebase + re-flush, or a later batch, must still carry it).
    const versionMeta = isFinalBatch ? pendingCollabVersionMetaRef.current : null;

    // Bound the push so a never-settling request cannot leave
    // collaborationPushBusyRef stuck `true` forever (which silently disables
    // every future save). AbortController guarantees the fetch promise settles,
    // so the finally below always releases the lock.
    const pushAbort = new AbortController();
    const pushTimeout = window.setTimeout(() => pushAbort.abort(), COLLAB_PUSH_TIMEOUT_MS);

    try {
      const response = await fetch(`/api/documents/${documentId}/collaboration`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          version: sendable.version,
          steps: batch.map((step) => step.toJSON()),
          clientId: collabClientIdRef.current,
          shareToken,
          ...(versionMeta ? { versionMeta } : {})
        }),
        signal: pushAbort.signal
      });
      const data = (await response.json().catch(() => null)) as
        | (CollaborationStepResponse & { error?: string })
        | null;

      if (!response.ok || !data || !Array.isArray(data.steps) || !Array.isArray(data.clientIds)) {
        logClientEvent({
          scope: "collaboration-push",
          level: "error",
          message: "collaboration POST rejected",
          data: {
            documentId,
            status: response.status,
            sentVersion: sendable.version,
            sentStepCount: batch.length,
            pendingStepCount: sendable.steps.length,
            serverError: typeof data?.error === "string" ? data.error : null
          }
        });

        // A 409 with missing steps is the protocol's "you're stale, here's
        // what you missed" reply. Apply those steps locally — receiveTransaction
        // rebases our sendable over them — and queue a re-flush so the rebased
        // steps push immediately. Without this, the tab stays stuck on
        // "Save failed" until the user edits again.
        if (response.status === 409 && data && Array.isArray(data.steps) && Array.isArray(data.clientIds)) {
          if (applyCollaborationPayload(data)) {
            collaborationPushQueuedRef.current = true;
            setSaveState(sendableSteps(editor.state) ? "saving" : "saved");
            return;
          }
          // The rebase failed — fall through to the sole-client force-push below.
        }

        // Unrecoverable: a push the server won't accept and we can't rebase away
        // — a failed 409 rebase, OR a hard 4xx/5xx the server rejected outright
        // (a malformed/oversized/un-appliable step payload). A 422 (corrupt step
        // / schema mismatch) fails identically on retry, so it's unrecoverable
        // too. Route through the shared handler: sole client → force-push (git
        // push --force semantics — your local doc IS the source of truth so a
        // desync must never strand you on "Save failed"); collaborator present →
        // manual merge so we never clobber concurrent edits. A normal 409 that
        // already rebased returned above, so this never clobbers recoverable work.
        collaborationPushQueuedRef.current = false;
        await handleUnrecoverableDivergence();
        return;
      }

      // Push accepted — the version metadata (if any) was consumed by this
      // commit, so don't re-attach it to subsequent pushes.
      if (versionMeta && pendingCollabVersionMetaRef.current === versionMeta) {
        pendingCollabVersionMetaRef.current = null;
      }

      if (!applyCollaborationPayload(data)) {
        // The server accepted our push but the steps it echoed back can't be
        // applied locally — same unrecoverable divergence, same recovery.
        await handleUnrecoverableDivergence();
        return;
      }

      // A partial batch (large edit split across pushes) leaves more steps
      // sendable now that the version advanced — queue the next batch so the
      // flush drains to completion instead of stopping half-saved.
      if (sendableSteps(editor.state)) {
        collaborationPushQueuedRef.current = true;
        setSaveState("saving");
      } else {
        setSaveState("saved");
      }
    } catch {
      // Network failure or a push that hit COLLAB_PUSH_TIMEOUT_MS. The lock is
      // released in the finally, then we schedule a delayed retry so a transient
      // hang recovers without requiring the user to edit again. Use a delayed
      // re-flush (not the immediate queued one below) to avoid a hot loop while
      // offline.
      setSaveState("error");
      logClientEvent({
        scope: "collaboration-push",
        level: "error",
        message: "collaboration POST failed (network/timeout)",
        data: {
          documentId,
          sentVersion: sendable.version,
          sentStepCount: batch.length,
          pendingStepCount: sendable.steps.length
        }
      });
      scheduleCollaborationFlush(COLLAB_PUSH_RETRY_DELAY_MS);
    } finally {
      window.clearTimeout(pushTimeout);
      collaborationPushBusyRef.current = false;
    }

    if (collaborationPushQueuedRef.current && sendableSteps(editor.state)) {
      collaborationPushQueuedRef.current = false;
      await flushCollaborationSteps();
    }
  }

  function scheduleCollaborationFlush(delay = 80) {
    if (collaborationFlushTimerRef.current) {
      window.clearTimeout(collaborationFlushTimerRef.current);
    }

    collaborationFlushTimerRef.current = window.setTimeout(() => {
      collaborationFlushTimerRef.current = null;
      void flushCollaborationSteps();
    }, delay);
  }

  async function pullCollaborationSteps() {
    // Stop the 500ms fallback poll from hammering the server once a divergence is
    // being handled (a force-push reload is pending or the merge dialog is open).
    if (!editor || collaborationPullBusyRef.current || divergenceHandlingRef.current) {
      return;
    }

    collaborationPullBusyRef.current = true;

    try {
      const shareQuery = shareToken ? `&share=${encodeURIComponent(shareToken)}` : "";
      const response = await fetch(
        `/api/documents/${documentId}/collaboration?version=${getVersion(editor.state)}${shareQuery}`,
        { cache: "no-store" }
      ).catch(() => null);
      const data = (await response?.json().catch(() => null)) as CollaborationStepResponse | null;

      if (data && Array.isArray(data.steps) && data.steps.length > 0) {
        // A pull can be the first place a divergence surfaces (an idle tab, or a
        // freshly-opened tab whose stale seed can't apply its catch-up steps).
        // Route a failed apply through recovery instead of looping forever.
        if (!applyCollaborationPayload(data)) {
          await handleUnrecoverableDivergence();
        }
      }
    } finally {
      collaborationPullBusyRef.current = false;
    }
  }

  // Last-resort recovery for an unrecoverable divergence: this tab's local doc
  // no longer matches the server's confirmed version, so prosemirror-collab
  // can't rebase the pending steps (applyCollaborationPayload threw). If we are
  // the ONLY client connected, force-push our state — the server overwrites its
  // document with ours (archiving the old state) and resets to version 0, then
  // we reload to re-seed the collab plugin at that baseline. No local edits are
  // lost. When other clients are connected the server refuses (returns 409) and
  // we keep the normal "Save failed" conflict behavior.
  async function attemptForcePushRecovery(): Promise<boolean> {
    if (!editor || forcePushBusyRef.current) {
      return false;
    }
    // Skip the upload entirely if we already know another client is here; the
    // server would refuse anyway. (The server re-checks authoritatively.)
    if (remotePresenceRef.current.length > 0) {
      return false;
    }

    forcePushBusyRef.current = true;
    try {
      const response = await fetch(`/api/documents/${documentId}/collaboration`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force: true,
          content: editor.getJSON(),
          clientId: collabClientIdRef.current,
          shareToken
        })
      });
      const data = (await response.json().catch(() => null)) as
        | { forced?: boolean; reason?: string }
        | null;

      if (response.ok && data?.forced) {
        logClientEvent({
          scope: "collaboration-force-push",
          level: "warn",
          message: "force-pushed diverged state; reloading to re-seed at version 0",
          data: { documentId }
        });
        // The collab plugin's version is fixed at editor creation, so a reload is
        // the clean way to adopt the new version-0 baseline (which now holds the
        // content we just pushed).
        window.location.reload();
        return true;
      }

      logClientEvent({
        scope: "collaboration-force-push",
        level: "error",
        message: "force-push refused (other clients connected) or failed",
        data: { documentId, status: response.status, reason: data?.reason ?? null }
      });
      return false;
    } catch {
      return false;
    } finally {
      forcePushBusyRef.current = false;
    }
  }

  // Single entry point for an unrecoverable divergence, reached from EVERY place
  // applyCollaborationPayload returns false (the push-409 rebase, the fallback
  // poll, and the live SSE "steps" event). Mirrors `git`: a sole editor force-
  // pushes its branch; with a collaborator present we must not clobber their
  // work, so we open the manual merge dialog. Latched so the 500ms poll / SSE
  // can't re-fire it and hammer the server while recovery is pending.
  async function handleUnrecoverableDivergence() {
    if (!editor || divergenceHandlingRef.current) {
      return;
    }
    divergenceHandlingRef.current = true;
    setSaveState("error");

    const recovery = planDivergenceRecovery({
      otherClientsPresent: remotePresenceRef.current.length > 0
    });

    if (recovery === "force-push" && (await attemptForcePushRecovery())) {
      // attemptForcePushRecovery reloads the page on success; stay latched.
      return;
    }

    // Either a collaborator is present, or the server refused the force-push
    // (it re-checks presence authoritatively). Resolve via a manual merge —
    // capture this tab's copy now, before any further remote steps churn it.
    setRemoteNotice(null);
    setMergeState({ localContent: editor.getJSON() });
  }


  function normalizeCurrentEditorWidgets() {
    if (!editor) {
      return null;
    }

    const normalized = normalizeWidgetsOutsideTables(editor.getJSON());
    if (normalized.changed) {
      isApplyingRemoteUpdateRef.current = true;
      editor.commands.setContent(normalized.content, false);
      // This full-document setContent collapses other in-flight AI selections to the
      // doc end; re-pin them from the surviving marks so their results stay in place.
      const reseed = reseedAiEditSelectionsFromDoc(editor.state);
      if (reseed) editor.view.dispatch(reseed);
      // Microtask, not rAF: rAF is frozen in backgrounded tabs and would leave
      // this guard stuck `true`, silently disabling saving.
      deferToForeground(() => {
        isApplyingRemoteUpdateRef.current = false;
      });
    }

    return normalized.content;
  }

  function applyRemoteSnapshot(snapshot: {
    title: string;
    content: JSONContent;
    updatedAt: string;
    threads: ThreadView[];
    activeAiRun: ActiveAiRunView | null;
    activeAiRuns?: ActiveAiRunView[];
    aiRuns?: ActiveAiRunView[];
  }) {
    setThreads(snapshot.threads);
    syncAiRuns(snapshot.aiRuns ?? snapshot.activeAiRuns ?? (snapshot.activeAiRun ? [snapshot.activeAiRun] : []));
    setAiRunsLoaded(true);
    setActiveAiTarget((currentTarget) => {
      const visibleRun = snapshot.activeAiRun ?? snapshot.activeAiRuns?.[0] ?? null;
      if (!visibleRun) {
        return null;
      }

      if (visibleRun.triggerType === "COMMENT_THREAD" && visibleRun.triggerId) {
        return {
          type: "comment-thread",
          threadId: visibleRun.triggerId
        };
      }

      if (visibleRun.triggerType === "SELECTION_EDIT" && editor) {
        const selectionId = parseAiRunSelectionId(visibleRun.triggerId);
        const range = selectionId ? getAiEditSelectionRange(editor.state, selectionId) : null;
        if (range) {
          return getRangeEditTarget(range.from, range.to);
        }
      }

      return currentTarget?.type === "selection-edit" ? currentTarget : null;
    });
    setActiveThreadId((currentThreadId) =>
      currentThreadId && snapshot.threads.some((thread) => thread.id === currentThreadId)
        ? currentThreadId
        : null
    );

    if (snapshot.updatedAt === documentUpdatedAtRef.current) {
      return;
    }

    if (!editor) {
      return;
    }

    if (snapshot.title !== titleRef.current) {
      setTitle(snapshot.title);
      titleRef.current = snapshot.title;
    }
    setDocumentUpdatedAt(snapshot.updatedAt);
    setRemoteNotice(null);
    window.requestAnimationFrame(() => {
      updateThreadOffsets();
    });
  }

  async function loadVersionHistory() {
    setHistoryLoading(true);
    setGlobalError(null);

    const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
    const response = await fetch(`/api/documents/${documentId}/versions${shareQuery}`);
    const data = await response.json().catch(() => null);

    if (!response.ok || !Array.isArray(data?.versions)) {
      reportClientError(data?.error ?? "Unable to load version history.", "version-history", {
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setHistoryLoading(false);
      return;
    }

    setHistoryVersions(data.versions);
    setSelectedVersionId(data.versions[0]?.id ?? null);
    setHistoryLoaded(true);
    setHistoryLoading(false);
  }

  // Restore a past version by replacing the editor content with its snapshot and
  // letting the normal collaboration flush persist it (NEVER a direct content
  // PATCH — that would desync the collab room; see CLAUDE.md). onUpdate fires
  // from setContent, marking unsaved and scheduling the flush.
  function handleRestoreVersion(versionId: string) {
    if (!editor || !canWriteDocument) return;
    const version = historyVersions.find((candidate) => candidate.id === versionId);
    if (!version) return;
    setRestoringVersion(true);
    try {
      isApplyingRemoteUpdateRef.current = false;
      editor.commands.setContent(version.content, true);
      hasUnsavedChangesRef.current = true;
      setSaveState("saving");
      scheduleCollaborationFlush();
      setHistoryOpen(false);
    } finally {
      setRestoringVersion(false);
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TaskList,
      TaskItem.configure({ nested: true }),
      StrikeShortcut,
      MoveBlock,
      slashTabExtension,
      Image.configure({
        allowBase64: true,
        inline: false
      }),
      CommentAnchor,
      Mention,
      mentionDecorationExtension,
      collaborationExtension,
      remotePresenceExtension,
      AiEditSelections,
      Suggestions,
      commentHighlightExtension,
      latexRenderExtension,
      SearchExtension,
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https"
      }),
      Placeholder.configure({
        placeholder: "Start writing, or paste content here. Select text to add a comment or ask AI to edit.",
        showOnlyWhenEditable: true,
        showOnlyCurrent: false
      }),
      Table.configure({
        resizable: false
      }),
      TableRow,
      TableHeader,
      TableCell,
      RepoImage,
      EmbeddedWidget,
      AttachmentChip,
      TabBreak,
      tabsVisibilityExtension
    ],
    immediatelyRender: false,
    // Comment-access users are editable too, but locked into suggesting mode (the
    // Suggestions plugin rewrites their edits into tracked changes, and the collab
    // route enforces that they only change suggestions, never committed content).
    editable: canPersistEdits,
    content: initialContent as JSONContent,
    editorProps: {
      attributes: {
        class: "gdocs-prosemirror"
      },
      handleKeyDown(_view, event) {
        // Drive the @mention autocomplete dropdown from the keyboard when it's open.
        const mention = docMentionRef.current;
        if (!mention || mention.items.length === 0) {
          return false;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setDocMention((current) =>
            current ? { ...current, index: (current.index + 1) % current.items.length } : current
          );
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setDocMention((current) =>
            current
              ? { ...current, index: (current.index - 1 + current.items.length) % current.items.length }
              : current
          );
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          applyDocMention(mention.items[mention.index]);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDocMention(null);
          return true;
        }
        return false;
      },
      handlePaste(view, event) {
        const imageFiles = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith("image/")
        );

        if (imageFiles.length === 0) {
          return false;
        }

        event.preventDefault();
        void insertImagesAtPosition(view, imageFiles);
        return true;
      },
      handleDrop(view, event) {
        const imageFiles = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
          file.type.startsWith("image/")
        );

        if (imageFiles.length === 0) {
          return false;
        }

        event.preventDefault();
        void insertImagesAtPosition(view, imageFiles, {
          left: event.clientX,
          top: event.clientY
        });
        return true;
      },
      handleClick(_view, _pos, event) {
        const target = event.target;
        if (!(target instanceof Element)) {
          return false;
        }

        const anchor = target.closest("a[href]");
        if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) {
          return false;
        }

        if (!canWriteDocument || event.metaKey || event.ctrlKey) {
          window.open(anchor.href, "_blank", "noopener,noreferrer");
          return true;
        }

        return false;
      }
    },
    onSelectionUpdate: ({ editor }) => {
      sendPresence(false);
      refreshDocMention(editor);
      setTableControlsActive(editor.isActive("table"));
      const { selection } = editor.state;
      const { from, to } = selection;

      // Inline suggestion review: when the caret is inside a tracked change, show
      // an Accept/Reject popover anchored to it (editors only — accept/reject is
      // an edit-level action). Computed independently of the selection menu below.
      if (canWriteDocument && editorPageRef.current) {
        const ranges = collectSuggestionRanges(editor.state.doc);
        const hit = ranges.find((range) => from >= range.from && from <= range.to);
        if (hit) {
          const related = ranges.filter((range) => range.suggestionId === hit.suggestionId);
          const kinds = new Set(related.map((range) => range.kind));
          const anchorFrom = Math.min(...related.map((range) => range.from));
          const coords = editor.view.coordsAtPos(anchorFrom);
          const pageRect = editorPageRef.current.getBoundingClientRect();
          setSuggestionPopover({
            id: hit.suggestionId,
            label:
              kinds.has("insert") && kinds.has("delete")
                ? "Replace"
                : kinds.has("insert")
                  ? "Insert"
                  : "Delete",
            authorLabel: hit.author.authorLabel,
            top: Math.max(8, coords.bottom - pageRect.top + 6),
            left: Math.max(8, Math.min(coords.left - pageRect.left, pageRect.width - 200))
          });
        } else {
          setSuggestionPopover(null);
        }
      } else {
        setSuggestionPopover(null);
      }

      if (!editorPageRef.current) {
        setSelection(null);
        setSelectionPopoverMode(null);
        return;
      }

      const selectedNodeText =
        selection instanceof NodeSelection ? describeNodeSelection(selection.node) : "";
      if (from === to && !selectedNodeText) {
        setSelection(null);
        setSelectionPopoverMode(null);
        return;
      }

      const text = editor.state.doc.textBetween(from, to, " ").trim() || selectedNodeText;
      if (!text) {
        setSelection(null);
        setSelectionPopoverMode(null);
        return;
      }

      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      const pageRect = editorPageRef.current.getBoundingClientRect();
      const left = Math.max(
        24,
        Math.min((start.left + end.right) / 2 - pageRect.left - 72, pageRect.width - 164)
      );
      const top = Math.max(16, start.top - pageRect.top - 54);

      setSelection({
        text,
        from,
        to,
        context: getSelectionContextFromEditor(editor, from, to) || getSelectionContext(text),
        bubbleTop: top,
        bubbleLeft: left
      });
      setSelectionPopoverMode("menu");
    },
    onUpdate: ({ editor }) => {
      if (!canPersistEdits || isApplyingRemoteUpdateRef.current) {
        return;
      }

      setTableControlsActive(editor.isActive("table"));
      setDocStats(computeDocStats(editor.getText()));
      hasUnsavedChangesRef.current = true;
      setSaveState("saving");
      scheduleCollaborationFlush();
      sendPresence(true);
      if (typingClearTimerRef.current) {
        window.clearTimeout(typingClearTimerRef.current);
      }
      typingClearTimerRef.current = window.setTimeout(() => {
        typingClearTimerRef.current = null;
        sendPresence(false, true);
      }, 900);

      window.requestAnimationFrame(() => {
        updateThreadOffsets();
      });
      refreshDocMention(editor);
    },
    onTransaction: ({ transaction }) => {
      // Fires for every transaction including remote/collab applies and
      // programmatic edits (which onUpdate skips while applying remote updates).
      // Bump a revision only when the doc actually changed so anchor-derived
      // memos recompute and orphaned comments disappear.
      if (transaction.docChanged) {
        setDocRevision((value) => value + 1);
      }
    }
  });

  // Push the current suggesting mode + author into the suggestions plugin so its
  // appendTransaction interceptor and Backspace/Delete keymap know whether to
  // convert edits into tracked changes, and who is authoring them.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(setSuggestionMode(editor.state, suggestingMode, suggestionAuthor));
  }, [editor, suggestingMode, suggestionAuthor]);

  // Recompute the pending-suggestion list whenever the document changes.
  useEffect(() => {
    if (!editor) {
      setSuggestionSummaries([]);
      return;
    }
    setSuggestionSummaries(collectSuggestionRanges(editor.state.doc));
  }, [editor, docRevision]);

  useEffect(() => {
    if (!editor) {
      setTabs([]);
      return;
    }

    function refreshTabs() {
      if (!editor) return;
      if (canWriteDocument) {
        const result = normalizePreludeTab(editor);
        if (result.createdTabId) {
          // Document mutated; this update will fire another onUpdate that re-runs refreshTabs.
          return;
        }
        if (ensureTabsHaveContent(editor)) {
          return;
        }
      }
      const next = listTabs(editor.state.doc);
      setTabs(next);
      setActiveTabIdState((current) => {
        if (next.length === 0) return null;
        if (current && next.some((tab) => tab.id === current)) return current;
        return next[0].id;
      });
    }

    refreshTabs();
    editor.on("update", refreshTabs);
    return () => {
      editor.off("update", refreshTabs);
    };
  }, [editor, canWriteDocument]);

  useEffect(() => {
    if (!editor) return;
    setActiveTab(editor, activeTabId);
  }, [editor, activeTabId, tabs.length]);

  const { sendPresence } = usePresence({
    editor,
    documentId,
    shareToken,
    userName: currentUserName,
    clientIdRef: collabClientIdRef,
    colorRef: collabColorRef
  });

  function handleSelectTab(tabId: string) {
    setActiveTabIdState(tabId);
  }

  useEffect(() => {
    handleCreateTabRef.current = () => {
      handleCreateTab();
    };
  });

  function findTabBreakPos(tabId: string): number | null {
    if (!editor) return null;
    let foundPos: number | null = null;
    editor.state.doc.forEach((child, offset) => {
      if (foundPos !== null) return;
      if (child.type.name === "tabBreak" && child.attrs?.tabId === tabId) {
        foundPos = offset;
      }
    });
    return foundPos;
  }

  function handleCreateTab() {
    if (!editor || !canWriteDocument) return;
    const tabBreakType = editor.schema.nodes.tabBreak;
    if (!tabBreakType) return;

    const newId = createTabId();
    const newTitle = `Tab ${tabs.length + 1}`;
    const tr = editor.state.tr;

    // If this is the first explicit tab and there is existing content, also insert
    // a leading break so the existing content has a name. (normalizePreludeTab
    // will also do this defensively after the update.)
    if (tabs.length === 0 && editor.state.doc.content.size > 2) {
      tr.insert(0, tabBreakType.create({ tabId: createTabId(), title: "Tab 1" }));
    }
    const paragraphType = editor.schema.nodes.paragraph;
    const newTabContent = paragraphType
      ? [tabBreakType.create({ tabId: newId, title: newTitle }), paragraphType.create()]
      : [tabBreakType.create({ tabId: newId, title: newTitle })];
    tr.insert(tr.doc.content.size, newTabContent);
    editor.view.dispatch(tr);
    setActiveTabIdState(newId);
  }

  function handleRenameTab(tabId: string, title: string) {
    if (!editor || !canWriteDocument) return;
    const pos = findTabBreakPos(tabId);
    if (pos === null) return;
    const tr = editor.state.tr.setNodeAttribute(pos, "title", title);
    editor.view.dispatch(tr);
  }

  function handleDeleteTab(tabId: string) {
    if (!editor || !canWriteDocument) return;
    const pos = findTabBreakPos(tabId);
    if (pos === null) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    const wasActive = activeTabId === tabId;
    // Find previous tab to switch to.
    const previousTab = (() => {
      const idx = tabs.findIndex((tab) => tab.id === tabId);
      if (idx > 0) return tabs[idx - 1];
      if (idx === 0 && tabs.length > 1) return tabs[1];
      return null;
    })();
    const tr = editor.state.tr.delete(pos, pos + node.nodeSize);
    editor.view.dispatch(tr);
    if (wasActive) setActiveTabIdState(previousTab?.id ?? null);
  }

  function handleReorderTab(tabId: string, direction: "up" | "down") {
    if (!editor || !canWriteDocument) return;
    const idx = tabs.findIndex((tab) => tab.id === tabId);
    if (idx === -1) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= tabs.length) return;

    const a = tabs[idx];
    const b = tabs[swapIdx];
    // a.contentFrom..a.contentTo and b.contentFrom..b.contentTo are adjacent (separated
    // by the next tabBreak). We move whichever tab comes first to where the second was,
    // by swapping the two slices including their leading tabBreak nodes.
    const first = direction === "up" ? b : a;
    const second = direction === "up" ? a : b;
    const firstFrom = first.breakPos;
    const firstTo = first.contentTo;
    const secondFrom = second.breakPos;
    const secondTo = second.contentTo;
    if (firstTo !== secondFrom) return; // sanity check: adjacency
    const firstSlice = editor.state.doc.slice(firstFrom, firstTo);
    const secondSlice = editor.state.doc.slice(secondFrom, secondTo);
    const tr = editor.state.tr.replaceWith(
      firstFrom,
      secondTo,
      secondSlice.content.append(firstSlice.content)
    );
    editor.view.dispatch(tr);
  }

  useEffect(() => {
    threadsRef.current = threads;
    activeThreadIdRef.current = activeThreadId;

    if (editor) {
      editor.view.dispatch(editor.state.tr.setMeta("comment-highlight-refresh", Date.now()));
    }
  }, [activeThreadId, editor, threads]);

  useEffect(() => {
    remotePresenceRef.current = remotePresence;
    if (editor) {
      editor.view.dispatch(editor.state.tr.setMeta("remote-presence-refresh", Date.now()));
    }
  }, [editor, remotePresence]);

  useCollaborationStream({
    documentId,
    editor,
    shareToken,
    currentUserId,
    collabClientIdRef,
    lastSseAtRef,
    applyCollaborationPayload,
    pullCollaborationSteps,
    onUnrecoverableDivergence: handleUnrecoverableDivergence,
    sendPresence,
    setThreads,
    setDocumentUpdatedAt,
    setRemotePresence,
    setRemoteNotice
  });

  useEffect(() => {
    window.requestAnimationFrame(() => {
      updateThreadOffsets();
    });
  }, [editor, threads, activeThreadId]);

  // Initial word/character count once the editor is ready.
  useEffect(() => {
    if (editor) {
      setDocStats(computeDocStats(editor.getText()));
    }
  }, [editor]);

  // Intercept Cmd/Ctrl-F to open the in-document find bar instead of the
  // browser's find (which can't see hidden-tab content).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Warn before navigating away with unsaved local edits or a pending collab
  // flush, so a tab close mid-save doesn't silently lose work.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      const pending =
        hasUnsavedChangesRef.current ||
        collaborationPushQueuedRef.current ||
        (editor ? Boolean(sendableSteps(editor.state)) : false);
      if (pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [editor]);

  useEffect(() => {
    function handleLayoutChange() {
      updateThreadOffsets();
    }

    window.addEventListener("resize", handleLayoutChange);
    window.addEventListener("scroll", handleLayoutChange, true);

    return () => {
      window.removeEventListener("resize", handleLayoutChange);
      window.removeEventListener("scroll", handleLayoutChange, true);
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      if (collaborationFlushTimerRef.current) {
        window.clearTimeout(collaborationFlushTimerRef.current);
      }
      if (typingClearTimerRef.current) {
        window.clearTimeout(typingClearTimerRef.current);
      }
    };
  }, [editor, threads, activeThreadId]);

  useEffect(() => {
    if (!historyOpen || historyLoaded) {
      return;
    }

    void loadVersionHistory();
  }, [historyLoaded, historyOpen]);

  useEffect(() => {
    const pollInterval = window.setInterval(async () => {
      const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
      const response = await fetch(`/api/documents/${documentId}${shareQuery}`, {
        cache: "no-store"
      }).catch(() => null);

      if (!response?.ok) {
        return;
      }

      const data = await response.json().catch(() => null);
      if (!data?.document || !Array.isArray(data?.threads)) {
        return;
      }

      applyRemoteSnapshot({
        title: data.document.title,
        content: data.document.content as JSONContent,
        updatedAt: data.document.updatedAt,
        threads: data.threads as ThreadView[],
        activeAiRun: data.activeAiRun ?? null,
        activeAiRuns: Array.isArray(data.activeAiRuns) ? data.activeAiRuns : [],
        aiRuns: Array.isArray(data.aiRuns) ? data.aiRuns : []
      });
    }, 2000);

    return () => window.clearInterval(pollInterval);
  }, [documentId, editor, shareToken]);

  function getReplyDraft(threadId: string) {
    void replyDraftTick;
    return replyDraftsRef.current[threadId] ?? "";
  }

  function setReplyDraft(threadId: string, value: string) {
    replyDraftsRef.current[threadId] = value;
    setReplyDraftTick((count) => count + 1);
  }

  async function handleSaveTitleBlur() {
    if (!canWriteDocument) {
      return;
    }

    setSaveState("saving");
    titleRef.current = title;
    const response = await fetch(`/api/documents/${documentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: titleRef.current,
        shareToken
      })
    });
    const data = await response.json().catch(() => null);
    if (response.ok && typeof data?.updatedAt === "string") {
      setDocumentUpdatedAt(data.updatedAt);
      setSaveState("saved");
      return;
    }

    setSaveState("error");
  }

  async function handleSaveAgentConfig(next: { model?: string; effort?: string }) {
    if (!canWriteDocument) {
      return;
    }
    // Optimistic local update so the dropdown reflects the choice immediately.
    const previous = { model: agentModel, effort: agentEffort };
    if (next.model !== undefined) setAgentModel(next.model);
    if (next.effort !== undefined) setAgentEffort(next.effort);

    setSaveState("saving");
    const response = await fetch(`/api/documents/${documentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        shareToken,
        ...(next.model !== undefined ? { agentModel: next.model } : {}),
        ...(next.effort !== undefined ? { agentEffort: next.effort } : {})
      })
    });
    const data = await response.json().catch(() => null);
    if (response.ok && typeof data?.updatedAt === "string") {
      setDocumentUpdatedAt(data.updatedAt);
      setSaveState("saved");
      return;
    }

    // Roll back the optimistic change on failure.
    setAgentModel(previous.model);
    setAgentEffort(previous.effort);
    setSaveState("error");
    reportClientError("Failed to save agent settings.", "agent-config", {
      status: response.status
    });
  }

  async function handleSaveRepository() {
    if (!canWriteDocument) {
      return;
    }

    setRepoBusy(true);
    setRepoNotice(null);
    setGlobalError(null);

    const response = await fetch(`/api/documents/${documentId}/repository`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        repoUrl: repoUrl.trim() || null,
        repoBranch: repoBranch.trim() || null
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.repository) {
      reportClientError(data?.error ?? "Unable to save repository settings.", "repo-settings", {
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setRepoBusy(false);
      return;
    }

    setRepoUrl(data.repository.repoUrl ?? "");
    setRepoBranch(data.repository.repoBranch ?? "");
    if (data.repository.repoUrl) {
      emitTourEvent("repo-linked");
    }
    const accessDenied = data.access?.reason === "no-access";
    setRepoAccessIssue(
      accessDenied
        ? { login: data.access?.login ?? null, tokenSource: data.access?.tokenSource ?? "none" }
        : null
    );
    if (accessDenied) {
      setRepoNotice(null);
      logClientEvent({
        scope: "repo-access",
        level: "warn",
        message: "Linked repository is not accessible.",
        data: {
          documentId,
          repoUrl: data.repository.repoUrl,
          login: data.access?.login ?? null,
          tokenSource: data.access?.tokenSource ?? "none"
        }
      });
    } else {
      setRepoNotice(
        data.repository.repoUrl
          ? data.access?.acceptedInvitation
            ? "Repository linked — collaborator invite accepted"
            : "Repository linked"
          : "Repository link removed"
      );
    }
    setRepoBusy(false);
  }

  async function handleInsertWidget() {
    if (!editor || !canManageAutomation) {
      return;
    }

    setGlobalError(null);
    setWidgetDialogOpen(true);
  }

  async function handleCreateWidget() {
    if (!editor || !canManageAutomation || widgetBusy) {
      return;
    }

    const label = widgetDraft.label.trim() || "Interactive widget";
    const buildCmd = widgetDraft.buildCmd.trim();
    const embedSource = widgetDraft.embedSource.trim();

    if (!buildCmd || !embedSource) {
      reportClientError(
        "Widget config needs build command and embed source.",
        "widget-create-invalid",
        { documentId }
      );
      return;
    }

    setWidgetBusy(true);
    setGlobalError(null);

    const response = await fetch(`/api/documents/${documentId}/widgets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        label,
        buildCmd,
        embedSource,
        shareToken
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.widget) {
      reportClientError(data?.error ?? "Unable to create widget.", "widget-create", {
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setWidgetBusy(false);
      return;
    }

    const src = `/api/documents/${documentId}/widgets/${data.widget.id}/source`;
    editor
      .chain()
      .focus()
      .insertContent({
        type: "embeddedWidget",
        attrs: {
          widgetId: data.widget.id,
          documentId,
          label,
          buildCmd,
          embedSource,
          src
        }
      })
      .run();
    normalizeCurrentEditorWidgets();
    setWidgetDialogOpen(false);
    setWidgetBusy(false);
  }

  function handleAttachClick() {
    if (!editor || !canWriteDocument || attachmentBusy) {
      return;
    }
    attachmentInputRef.current?.click();
  }

  async function handleAttachmentSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0] ?? null;
    // Reset immediately so selecting the same file again re-fires the change event.
    input.value = "";
    if (!file || !editor || !canWriteDocument) {
      return;
    }

    setAttachmentBusy(true);
    setGlobalError(null);

    const body = new FormData();
    body.append("file", file);
    if (shareToken) {
      body.append("share", shareToken);
    }

    const response = await fetch(`/api/documents/${documentId}/attachments`, {
      method: "POST",
      body
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.attachment) {
      reportClientError(data?.error ?? "Unable to upload attachment.", "attachment-upload", {
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setAttachmentBusy(false);
      return;
    }

    const attachment = data.attachment as {
      id: string;
      fileName: string;
      mimeType: string;
      size: number;
      workspacePath: string;
    };
    editor
      .chain()
      .focus()
      .insertContent({
        type: "attachmentChip",
        attrs: {
          attachmentId: attachment.id,
          documentId,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          workspacePath: attachment.workspacePath
        }
      })
      .run();
    setAttachmentBusy(false);
  }

  // Recompute the in-editor @mention autocomplete from the live editor state.
  // Active only for editors, an empty (cursor) selection inside a text block.
  function refreshDocMention(activeEditor: Editor) {
    if (!canWriteDocument || mentionMembers.length === 0 || !editorPageRef.current) {
      if (docMentionRef.current) setDocMention(null);
      return;
    }
    const { selection: sel, doc } = activeEditor.state;
    if (!sel.empty) {
      if (docMentionRef.current) setDocMention(null);
      return;
    }
    const head = sel.head;
    const resolved = doc.resolve(head);
    if (!resolved.parent.isTextblock) {
      if (docMentionRef.current) setDocMention(null);
      return;
    }
    const blockStart = resolved.start();
    const textBefore = doc.textBetween(blockStart, head, "\n", "\n");
    const active = findActiveMentionQuery(textBefore, textBefore.length);
    if (!active) {
      if (docMentionRef.current) setDocMention(null);
      return;
    }
    const items = filterMentionCandidates(active.query, mentionMembers);
    if (items.length === 0) {
      if (docMentionRef.current) setDocMention(null);
      return;
    }
    const from = blockStart + active.start;
    const to = head;
    let left = 0;
    let top = 0;
    try {
      const coords = activeEditor.view.coordsAtPos(from);
      const pageRect = editorPageRef.current.getBoundingClientRect();
      left = coords.left - pageRect.left;
      top = coords.bottom - pageRect.top + 4;
    } catch {
      // coordsAtPos can throw mid-transaction; skip this tick.
      return;
    }
    setDocMention((current) => ({
      query: active.query,
      from,
      to,
      items,
      // Preserve the highlighted index while the same query is being narrowed.
      index: current && current.query && active.query.startsWith(current.query) ? Math.min(current.index, items.length - 1) : 0,
      left,
      top
    }));
  }

  function applyDocMention(candidate: MentionCandidate) {
    const mention = docMentionRef.current;
    if (!editor || !mention) return;
    const label = mentionHandle(candidate);
    const tr = buildMentionInsertTransaction(
      editor.state,
      { from: mention.from, to: mention.to },
      { userId: candidate.id, label }
    );
    setDocMention(null);
    if (!tr) return;
    editor.view.dispatch(tr);
    editor.view.focus();
    // Notify the mentioned member (skips self/non-members server-side).
    void fetch(`/api/documents/${documentId}/mentions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mentionedUserId: candidate.id, shareToken })
    }).catch(() => undefined);
  }

  async function handleCreateComment() {
    if (!selection || !composerBody.trim() || !editor) {
      return;
    }

    emitTourEvent("comment-created");
    setCommentBusy(true);
    setGlobalError(null);

    const selectedRange = selection;
    const threadId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousContent = editor.getJSON();

    // Anchor the thread over the whole selection: text gets the inline
    // commentAnchor mark, and every block atom (widget/repoImage/image) inside
    // the range gets the thread id in its commentThreadIds attr. This handles
    // "select all" over mixed content, which the old inline-only path could not.
    const anchorTr = buildCommentAnchorTransaction(
      editor.state,
      { from: selectedRange.from, to: selectedRange.to },
      threadId
    );
    const marked = !!anchorTr;
    if (anchorTr) {
      editor.view.dispatch(anchorTr);
    }

    if (!marked) {
      const editorSelection = editor.state.selection;
      const isNode = editorSelection instanceof NodeSelection;
      const nodeTypeName = isNode ? editorSelection.node.type?.name ?? null : null;
      const nodesInRange: string[] = [];
      editor.state.doc.nodesBetween(selectedRange.from, selectedRange.to, (node) => {
        if (node.type?.name) {
          nodesInRange.push(node.type.name);
        }
        return true;
      });
      reportClientError(
        "Unable to anchor the comment to the selected text.",
        "comment-anchor",
        {
          documentId,
          threadId,
          from: selectedRange.from,
          to: selectedRange.to,
          selectionKind: isNode ? "node" : "text",
          selectedNodeType: nodeTypeName,
          nodesInRange: Array.from(new Set(nodesInRange)),
          textPreview: selectedRange.text.slice(0, 120)
        }
      );
      setCommentBusy(false);
      return;
    }

    const postComment = async () => {
      const response = await fetch(`/api/documents/${documentId}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          threadId,
          body: composerBody.trim(),
          anchorText: selectedRange.text.slice(0, 1000),
          anchorContext: selectedRange.context ? selectedRange.context.slice(0, 2000) : selectedRange.context,
          clientId: collabClientIdRef.current,
          shareToken,
          guestName: isAuthenticated ? undefined : currentUserName
        })
      });
      const data = await response.json().catch(() => null);
      return { response, data };
    };

    await flushCollaborationSteps();
    let { response, data } = await postComment();

    // A 409 ("Anchor not yet saved") is the collab flush→persist race: the
    // commentAnchor step is in the editor and was just flushed, but the server's
    // persisted snapshot hasn't caught up yet. It clears within moments, so
    // re-flush and re-POST with bounded backoff instead of failing. Crucially we
    // must NOT revert the editor here — the revert would wipe the just-inserted
    // anchor that we are waiting for the server to persist.
    let anchorRetries = 0;
    const MAX_ANCHOR_RETRIES = 3;
    while (response.status === 409 && anchorRetries < MAX_ANCHOR_RETRIES) {
      anchorRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, 400 * anchorRetries));
      await flushCollaborationSteps();
      ({ response, data } = await postComment());
    }

    if (!response.ok || !data?.thread) {
      // Only revert for real failures. A 409 that outlived every retry means the
      // anchor still isn't persisted server-side; reverting would destroy it, so
      // leave the doc intact and just surface the error.
      if (response.status !== 409) {
        isApplyingRemoteUpdateRef.current = true;
        editor.commands.setContent(previousContent, false);
        isApplyingRemoteUpdateRef.current = false;
      }
      reportClientError(data?.error ?? "Unable to create thread.", "comment-create", {
        documentId,
        threadId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null,
        anchorRetries
      });
      setCommentBusy(false);
      return;
    }

    setThreads((current) => [data.thread, ...current]);
    setActiveThreadId(data.thread.id);
    if (typeof data.updatedAt === "string") {
      setDocumentUpdatedAt(data.updatedAt);
    }
    setSelection(null);
    setComposerBody("");
    setSelectionPopoverMode(null);
    setCommentBusy(false);
  }

  function getRangeEditTarget(from: number, to: number): ActiveAiTarget | null {
    if (!editor || !editorPageRef.current) {
      return null;
    }

    const boundedFrom = Math.max(0, Math.min(from, editor.state.doc.content.size));
    const boundedTo = Math.max(boundedFrom, Math.min(to, editor.state.doc.content.size));
    const start = editor.view.coordsAtPos(boundedFrom);
    const end = editor.view.coordsAtPos(boundedTo);
    const pageRect = editorPageRef.current.getBoundingClientRect();
    const isMultiline = end.bottom - start.top > 32 || end.left < start.left;
    const left = isMultiline ? 0 : Math.max(18, start.left - pageRect.left);
    const availableWidth = Math.max(220, pageRect.width - left - 24);
    const selectedWidth = Math.abs(end.right - start.left);
    const selectedHeight = Math.max(76, end.bottom - start.top + 24);

    return {
      type: "selection-edit",
      left,
      top: Math.max(24, start.top - pageRect.top - 8),
      width: isMultiline ? pageRect.width : Math.min(Math.max(selectedWidth, 260), availableWidth),
      height: Math.min(selectedHeight, Math.max(160, pageRect.height - (start.top - pageRect.top) + 16))
    };
  }

  async function handleAiEdit() {
    if (!selection || !editInstruction.trim() || !editor) {
      return;
    }

    emitTourEvent("ai-edit-started");
    const editSelection = selection;
    const instruction = editInstruction.trim();
    const selectedMarkdown = getSelectionMarkdownFromEditor(editor, editSelection.from, editSelection.to);
    const selectionId = createAiEditSelectionId();
    const triggerId = buildAiRunSelectionTriggerId(selectionId);
    setGlobalError(null);
    await ensureAgentNotificationPermission();
    editor.view.dispatch(
      upsertAiEditSelection(editor.state, {
        id: selectionId,
        from: editSelection.from,
        to: editSelection.to,
        progress: "Starting Claude research agent."
      })
    );
    setActiveAiRun({
      id: `pending-selection-edit-${Date.now()}`,
      triggerType: "SELECTION_EDIT",
      triggerId,
      selectionId,
      instruction,
      status: "RUNNING",
      progress: "Starting Claude research agent.",
      startedAt: new Date().toISOString()
    });
    setSelectionPopoverMode(null);
    setSelection(null);
    setEditInstruction("");

    const fetchStartedAt = Date.now();
    const response = await fetch(`/api/documents/${documentId}/ai-edit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        selectedText: editSelection.text,
        selectedMarkdown,
        selectedContext: editSelection.context,
        instruction,
        selectionId,
        shareToken
      })
    }).catch((error) => {
      logClientEvent({
        scope: "ai-edit",
        level: "error",
        message: "kickoff fetch threw",
        data: {
          documentId,
          selectionId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }
      });
      return null;
    });

    const data = await response?.json().catch(() => null);
    const kickoffAiRunId =
      data && typeof data.aiRunId === "string" ? (data.aiRunId as string) : null;

    if (!response?.ok || !kickoffAiRunId) {
      reportClientError(data?.error ?? "AI edit failed to start.", "ai-edit-kickoff", {
        documentId,
        selectionId,
        status: response?.status ?? null,
        ok: response?.ok ?? false,
        serverError: typeof data?.error === "string" ? data.error : null,
        elapsedMs: Date.now() - fetchStartedAt
      });
      notifyAgentCompleted({
        id: `failed-selection-edit-${Date.now()}`,
        triggerType: "SELECTION_EDIT",
        instruction,
        status: "FAILED"
      });
      setActiveAiRun(null);
      setActiveAiTarget(null);
      editor.view.dispatch(removeAiEditSelection(editor.state, selectionId));
      return;
    }

    logClientEvent({
      scope: "ai-edit-kickoff",
      level: "info",
      message: "agent run accepted by server",
      data: {
        documentId,
        selectionId,
        aiRunId: kickoffAiRunId,
        elapsedMs: Date.now() - fetchStartedAt
      }
    });
    // Polling effect (watching `aiRuns`) will pick up status changes and apply the
    // result when the agent finishes. No further work here.
  }

  // Snapshot the widgets already in the live document so widget://<widgetId>
  // placeholders an agent echoed from a selection resolve back to the same node.
  function collectExistingWidgets(): ExistingWidget[] {
    if (!editor) return [];
    const widgets: ExistingWidget[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "embeddedWidget") {
        const attrs = node.attrs as Record<string, unknown>;
        if (typeof attrs.widgetId === "string" && attrs.widgetId) {
          widgets.push({
            widgetId: attrs.widgetId,
            label: typeof attrs.label === "string" ? attrs.label : "Interactive widget",
            buildCmd: typeof attrs.buildCmd === "string" ? attrs.buildCmd : "",
            embedSource: typeof attrs.embedSource === "string" ? attrs.embedSource : "",
            src: typeof attrs.src === "string" ? attrs.src : ""
          });
        }
      }
      return true;
    });
    return widgets;
  }

  // Drop the surviving marker for a failed run the user chose not to retry.
  function dismissFailedAiEdit() {
    const failed = failedAiEdit;
    setFailedAiEdit(null);
    if (!failed || !editor) return;
    editor.view.dispatch(removeAiEditSelection(editor.state, failed.selectionId));
    logClientEvent({
      scope: "ai-edit-retry",
      level: "info",
      message: "user dismissed failed ai edit",
      data: { documentId, selectionId: failed.selectionId, aiRunId: failed.aiRunId }
    });
  }

  // Re-run a FAILED selection edit against the SAME marker with the SAME
  // instruction — no re-select, no re-type. The instruction lives on the AiRun
  // row; the selection text/markdown are reconstructed from the still-live
  // marker range, and the same selectionId is reused so the polling effect
  // applies the new run's result to the same range.
  async function retryFailedAiEdit() {
    const failed = failedAiEdit;
    if (!failed || !editor) return;

    const range = getAiEditSelectionRange(editor.state, failed.selectionId);
    const selectedText = range
      ? editor.state.doc.textBetween(range.from, range.to, "\n", " ").trim()
      : "";
    if (!range || !selectedText) {
      // The range collapsed away since the failure — nothing left to edit.
      reportClientError(
        "The edited text was removed, so the AI edit can't be retried.",
        "ai-edit-retry",
        { documentId, selectionId: failed.selectionId, aiRunId: failed.aiRunId }
      );
      dismissFailedAiEdit();
      return;
    }

    const instruction = failed.instruction.trim();
    if (!instruction) {
      reportClientError("The original instruction is missing, so this edit can't be retried.", "ai-edit-retry", {
        documentId,
        selectionId: failed.selectionId,
        aiRunId: failed.aiRunId
      });
      dismissFailedAiEdit();
      return;
    }

    const selectionId = failed.selectionId;
    const selectedMarkdown = getSelectionMarkdownFromEditor(editor, range.from, range.to);
    const triggerId = buildAiRunSelectionTriggerId(selectionId);

    setFailedAiEdit(null);
    editor.view.dispatch(
      upsertAiEditSelection(editor.state, {
        id: selectionId,
        from: range.from,
        to: range.to,
        progress: "Retrying Claude research agent."
      })
    );
    setActiveAiRun({
      id: `pending-selection-edit-${Date.now()}`,
      triggerType: "SELECTION_EDIT",
      triggerId,
      selectionId,
      instruction,
      status: "RUNNING",
      progress: "Retrying Claude research agent.",
      startedAt: new Date().toISOString()
    });

    logClientEvent({
      scope: "ai-edit-retry",
      level: "info",
      message: "retrying failed ai edit",
      data: { documentId, selectionId, previousAiRunId: failed.aiRunId }
    });

    const fetchStartedAt = Date.now();
    const response = await fetch(`/api/documents/${documentId}/ai-edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText,
        selectedMarkdown,
        selectedContext: getSelectionContextFromEditor(editor, range.from, range.to) || undefined,
        instruction,
        selectionId,
        shareToken
      })
    }).catch((error) => {
      logClientEvent({
        scope: "ai-edit-retry",
        level: "error",
        message: "retry kickoff fetch threw",
        data: {
          documentId,
          selectionId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }
      });
      return null;
    });

    const data = await response?.json().catch(() => null);
    const kickoffAiRunId = data && typeof data.aiRunId === "string" ? (data.aiRunId as string) : null;

    if (!response?.ok || !kickoffAiRunId) {
      reportClientError(data?.error ?? "AI edit failed to start.", "ai-edit-retry", {
        documentId,
        selectionId,
        status: response?.status ?? null,
        serverError: typeof data?.error === "string" ? data.error : null,
        elapsedMs: Date.now() - fetchStartedAt
      });
      // Re-arm the retry affordance so the user can try again (marker is intact).
      setActiveAiRun(null);
      setFailedAiEdit({
        selectionId,
        aiRunId: failed.aiRunId,
        instruction,
        error: typeof data?.error === "string" ? data.error : "AI edit failed to start."
      });
      return;
    }
    // The polling effect picks up the new run and applies it to the same marker.
  }

  async function applyAiEditRun(input: {
    aiRunId: string;
    selectionId: string;
    instruction: string;
    replacementText: string;
    images: AiEditImage[];
    widgets: AiEditWidget[];
    sources: string[];
    commitSha: string | null;
    commitUrl: string | null;
  }) {
    if (!editor) return;

    const { aiRunId, selectionId, instruction, replacementText, images, widgets, sources, commitSha, commitUrl } = input;
    const resolvedRange = resolveAiEditApplyRange(editor.state, selectionId);
    if (resolvedRange.anchorLost) {
      // The anchor is gone (e.g. a false "abandoned" failure stripped the mark
      // before the run actually finished). NEVER drop the result — fall through
      // and insert it at the end of the document, where the user can see it and
      // move or delete it. Previously this path claimed the run as applied
      // without inserting anything, silently eating hours of agent work.
      logClientEvent({
        scope: "ai-edit-marker-lost",
        level: "warn",
        message: "marker not in editor when applying ai run; inserting at end of document",
        data: {
          documentId,
          selectionId,
          aiRunId,
          replacementTextLen: replacementText.length,
          imageCount: images.length,
          widgetCount: widgets.length,
          presence: describeAiEditSelectionPresence(editor.state, selectionId)
        }
      });
      reportClientError(
        "The edited range was lost while the AI run finished — its result was added at the end of the document.",
        "ai-edit-marker-lost",
        { documentId, selectionId, aiRunId }
      );
    }
    const replacementRange = { from: resolvedRange.from, to: resolvedRange.to };

    const docSizeBefore = editor.state.doc.content.size;
    let docSizeAfter = docSizeBefore;
    let insertedContent: ReturnType<typeof buildAiEditInsertContent> | null = null;

    try {
      insertedContent = buildAiEditInsertContent({
        replacementText,
        sourceLinks: sources,
        images,
        widgets,
        documentId,
        shareToken,
        existingWidgets: collectExistingWidgets()
      });
      const applied = editor
        .chain()
        .focus()
        .insertContentAt(replacementRange, insertedContent)
        .run();
      docSizeAfter = editor.state.doc.content.size;
      logClientEvent({
        scope: "ai-edit-apply",
        level: applied && docSizeAfter !== docSizeBefore ? "info" : "warn",
        message:
          applied && docSizeAfter !== docSizeBefore
            ? "insertContentAt applied"
            : "insertContentAt returned without changing doc size",
        data: {
          documentId,
          selectionId,
          aiRunId,
          applied,
          replacementRange,
          docSizeBefore,
          docSizeAfter,
          charDelta: docSizeAfter - docSizeBefore,
          replacementTextLen: replacementText.length,
          insertedHtmlLen: insertedContent.length,
          imageCount: images.length,
          widgetCount: widgets.length
        }
      });
      editor.view.dispatch(removeAiEditSelection(editor.state, selectionId));
      normalizeCurrentEditorWidgets();
      hasUnsavedChangesRef.current = true;
      setSaveState("saving");
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // Persist the AI edit through the collaboration step pipeline ONLY. The
      // insertContentAt above produced local steps; flushing them is what writes
      // the new content + step log atomically and broadcasts to other clients.
      // We attach the agent's commit/source/run metadata to that same push so it
      // lands on the post-edit version. (Previously this path also did a direct
      // full-content PATCH via saveDocument, which wrote Document.content
      // out-of-band, desynced the collab room, and was the root cause of
      // post-AI-edit doc divergence / marker loss.)
      pendingCollabVersionMetaRef.current = {
        forceVersion: true,
        sourceLinks: sources,
        commitSha,
        commitUrl,
        aiRunId
      };
      await flushCollaborationSteps();
      if (pendingCollabVersionMetaRef.current) {
        // Flush had nothing to send (no sendable steps) or did not get accepted,
        // so the metadata was not consumed. Clear it so it can't leak onto an
        // unrelated later push, and log for diagnosis.
        pendingCollabVersionMetaRef.current = null;
        logClientEvent({
          scope: "ai-edit-save-failed",
          level: "warn",
          message: "AI edit flush did not consume version metadata",
          data: { documentId, selectionId, aiRunId, docSizeBefore, docSizeAfter }
        });
      }
    } catch (error) {
      reportClientError("AI edit could not be applied to the document.", "ai-edit-apply-threw", {
        documentId,
        selectionId,
        aiRunId,
        docSizeBefore,
        docSizeAfter: editor.state.doc.content.size,
        replacementTextLen: replacementText.length,
        insertedHtmlLen: insertedContent?.length ?? null,
        imageCount: images.length,
        widgetCount: widgets.length,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 1500) ?? null }
            : String(error)
      });
      notifyAgentCompleted({
        id: `failed-selection-edit-${Date.now()}`,
        triggerType: "SELECTION_EDIT",
        instruction,
        status: "FAILED"
      });
      setActiveAiRun(null);
      setActiveAiTarget(null);
      editor.view.dispatch(removeAiEditSelection(editor.state, selectionId));
      return;
    }

    // Tell the server the run was applied so other open tabs won't re-apply.
    await fetch(`/api/documents/${documentId}/ai-runs/${aiRunId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "markApplied", shareToken })
    }).catch(() => null);

    // Force a node-view remount so freshly inserted widgets/images/tables render
    // cleanly (iframes/tables otherwise sometimes paint half-initialized until the
    // page is refreshed). This used to call editor.commands.setContent(contentToSave),
    // a full-document replace — but that collapsed other in-flight AI selections to
    // the doc end (results landed at the bottom) and, pushed through collaboration,
    // clobbered other clients' concurrent edits. The targeted version re-renders only
    // the atom/table nodes in place, disturbing nothing else.
    const remount = buildAiEditRemountTransaction(editor.state);
    if (remount) {
      isApplyingRemoteUpdateRef.current = true;
      editor.view.dispatch(remount);
      // Microtask, not rAF: rAF is frozen in backgrounded tabs and would leave
      // this guard stuck `true`, silently disabling saving.
      deferToForeground(() => {
        isApplyingRemoteUpdateRef.current = false;
      });
    }

    setActiveAiRun(null);
    setActiveAiTarget(null);
    notifyAgentCompleted({
      id: aiRunId,
      triggerType: "SELECTION_EDIT",
      instruction
    });
  }

  // Resolve an agent's anchored find/replace suggestions against the live doc and
  // apply them as tracked changes. Skipped (un-resolvable) anchors are reported.
  // Renders a tracked-change replacement over a KNOWN range with full formatting:
  // the agent's markdown (incl. inline/block formatting and repo-image figures
  // resolved against the run's images) is parsed to real nodes, inserted right
  // after the struck range, and the inserted span is flagged as a suggested
  // insertion sharing one id with the deletion (so one accept performs the
  // replacement). Returns false if nothing was applied.
  function applyRichTrackedReplacement(
    range: { from: number; to: number },
    replacementText: string,
    author: SuggestionAuthor,
    runImages: AiEditImage[],
    runSources: string[]
  ): boolean {
    if (!editor) return false;
    const record = {
      suggestionId: createSuggestionId(),
      authorId: author.authorId,
      authorLabel: author.authorLabel,
      createdAt: new Date().toISOString()
    };
    let insertion: { from: number; to: number } | undefined;
    const replacement = (replacementText ?? "").trim();
    if (replacement) {
      const html = buildAiEditInsertContent({
        replacementText,
        sourceLinks: runSources,
        images: runImages,
        widgets: [],
        documentId,
        shareToken,
        existingWidgets: collectExistingWidgets(),
        appendUnusedImages: false
      });
      const sizeBefore = editor.state.doc.content.size;
      // Insert the rich content first (skip-tagged so the suggesting-mode
      // interceptor doesn't double-mark it), then mark the inserted span below.
      editor
        .chain()
        .insertContentAt(range.to, html, { updateSelection: false })
        .command(({ tr }) => {
          tr.setMeta(suggestionPluginKey, { type: "skip" });
          return true;
        })
        .run();
      const delta = editor.state.doc.content.size - sizeBefore;
      if (delta > 0) insertion = { from: range.to, to: range.to + delta };
    }
    const tr = markExplicitSuggestion(editor.state, {
      deletion: range.to > range.from ? { from: range.from, to: range.to } : undefined,
      insertion,
      record
    });
    if (!tr) return false;
    editor.view.dispatch(tr);
    return true;
  }

  function applyAgentSuggestions(
    aiRunId: string,
    suggestions: AgentSuggestionInput[],
    model: unknown,
    runImages: AiEditImage[] = [],
    runSources: string[] = []
  ) {
    if (!editor || suggestions.length === 0) return;
    const author: SuggestionAuthor = {
      authorId: `ai-run:${aiRunId}`,
      authorLabel: typeof model === "string" && model ? model : "AI"
    };
    // Resolve every anchor against the CURRENT doc first, then apply high → low so
    // earlier offsets stay valid as later ones insert content.
    const resolved: Array<{ suggestion: AgentSuggestionInput; from: number; to: number }> = [];
    const skipped: AgentSuggestionInput[] = [];
    for (const suggestion of suggestions) {
      const range = resolveSuggestionRange(editor.state.doc, suggestion.findText);
      if (!range) {
        skipped.push(suggestion);
        continue;
      }
      resolved.push({ suggestion, from: range.from, to: range.to });
    }
    resolved.sort((a, b) => b.from - a.from);
    for (const op of resolved) {
      applyRichTrackedReplacement(
        { from: op.from, to: op.to },
        op.suggestion.replacementText,
        author,
        runImages,
        runSources
      );
    }
    if (skipped.length > 0) {
      logClientEvent({
        scope: "ai-suggestion-anchor-lost",
        level: "warn",
        message: "agent suggestions could not be placed",
        data: { documentId, aiRunId, applied: resolved.length, skipped: skipped.length, total: suggestions.length }
      });
      reportClientError(
        `${skipped.length} of ${suggestions.length} AI suggestion(s) could not be placed in the document.`,
        "ai-suggestion-anchor-lost",
        { documentId, aiRunId }
      );
    }
  }

  // Anchors the standalone comment threads an agent created (server-side) by
  // adding the commentAnchor mark for each at its resolved range, through the
  // collab pipeline. The threads already exist + show in the rail; this places
  // their highlight in the text. Unresolved anchors leave the thread unanchored.
  function applyAgentComments(aiRunId: string, comments: Array<{ threadId: string; findText: string }>) {
    if (!editor || comments.length === 0) return;
    let applied = 0;
    const skipped: string[] = [];
    for (const comment of comments) {
      const range = resolveSuggestionRange(editor.state.doc, comment.findText);
      if (!range) {
        skipped.push(comment.threadId);
        continue;
      }
      const tr = buildCommentAnchorTransaction(editor.state, range, comment.threadId);
      if (tr) {
        editor.view.dispatch(tr);
        applied += 1;
      } else {
        skipped.push(comment.threadId);
      }
    }
    if (skipped.length > 0) {
      logClientEvent({
        scope: "ai-comment-anchor-lost",
        level: "warn",
        message: "agent comment anchors could not be placed",
        data: { documentId, aiRunId, applied, skipped: skipped.length, total: comments.length }
      });
    }
  }

  function handleAcceptSuggestion(suggestionId: string) {
    if (!editor) return;
    const tr = acceptSuggestion(editor.state, suggestionId);
    if (tr) editor.view.dispatch(tr);
    setSuggestionPopover(null);
  }

  function handleRejectSuggestion(suggestionId: string) {
    if (!editor) return;
    const tr = rejectSuggestion(editor.state, suggestionId);
    if (tr) editor.view.dispatch(tr);
    setSuggestionPopover(null);
  }

  function handleAcceptAllSuggestions() {
    if (!editor) return;
    const tr = acceptAllSuggestions(editor.state);
    if (tr) editor.view.dispatch(tr);
    setSuggestionPopover(null);
  }

  function handleRejectAllSuggestions() {
    if (!editor) return;
    const tr = rejectAllSuggestions(editor.state);
    if (tr) editor.view.dispatch(tr);
    setSuggestionPopover(null);
  }

  async function handleReply(threadId: string): Promise<boolean> {
    const draft = getReplyDraft(threadId).trim();
    if (!draft) {
      return false;
    }

    setReplyBusyThreadId(threadId);
    setGlobalError(null);

    const response = await fetch(`/api/comments/${threadId}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        body: draft,
        clientId: collabClientIdRef.current,
        shareToken,
        guestName: isAuthenticated ? undefined : currentUserName
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.comment) {
      reportClientError(data?.error ?? "Unable to send reply.", "comment-reply", {
        threadId,
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setReplyBusyThreadId(null);
      return false;
    }

    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              lastReadAt: data.lastReadAt ?? thread.lastReadAt,
              comments: [...thread.comments, data.comment]
            }
          : thread
      )
    );
    setReplyDraft(threadId, "");
    setReplyBusyThreadId(null);
    return true;
  }

  async function handleAskAi(threadId: string) {
    // Mark the thread busy up front so the button can't double-fire while a
    // pending reply draft is being sent.
    emitTourEvent("ask-ai");
    setAiBusyThreadId(threadId);
    const result = await submitPendingReplyThenAskAi({
      draft: getReplyDraft(threadId),
      sendReply: () => handleReply(threadId),
      askAi: () => startAskAiRun(threadId)
    });
    if (result === "reply-failed") {
      // handleReply already surfaced the error toast; don't ask AI on a thread
      // that is missing the user's latest message.
      setAiBusyThreadId(null);
    }
  }

  async function startAskAiRun(threadId: string) {
    setAiBusyThreadId(threadId);
    setGlobalError(null);
    await ensureAgentNotificationPermission();
    setActiveAiTarget({
      type: "comment-thread",
      threadId
    });
    setActiveAiRun({
      id: "pending-comment-reply",
      triggerType: "COMMENT_THREAD",
      triggerId: threadId,
      instruction: "Write the next assistant reply for this comment thread.",
      status: "RUNNING",
      progress: "Starting Claude research agent.",
      startedAt: new Date().toISOString()
    });

    const response = await fetch(`/api/comments/${threadId}/ask-ai`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.aiRunId) {
      reportClientError(data?.error ?? "AI reply failed.", "ask-ai", {
        threadId,
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      notifyAgentCompleted({
        id: `failed-comment-reply-${Date.now()}`,
        triggerType: "COMMENT_THREAD",
        triggerId: threadId,
        instruction: "Write the next assistant reply for this comment thread.",
        status: "FAILED"
      });
      setActiveAiRun(null);
      setActiveAiTarget(null);
      setAiBusyThreadId(null);
      return;
    }

    // Accepted (202). The agent now runs server-side (async, to dodge the
    // Cloudflare 524). Remember which run we're waiting on; completion clears the
    // busy state (effect below) and the posted comment arrives via the SSE
    // `comment-created` broadcast + AiRun polling.
    askAiRunIdRef.current = data.aiRunId;
  }

  async function updateThreadTags(thread: ThreadView, tags: string[], status?: ThreadStatusValue) {
    const response = await fetch(`/api/comments/${thread.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tags,
        status,
        clientId: collabClientIdRef.current,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.thread) {
      reportClientError(data?.error ?? "Unable to update comment tags.", "comment-update", {
        documentId,
        threadId: thread.id,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      return;
    }

    setThreads((current) =>
      current.map((candidate) => (candidate.id === thread.id ? data.thread : candidate))
    );
  }

  function toggleThreadTag(thread: ThreadView, tag: string) {
    const currentTags = getThreadTags(thread);
    const hasTag = currentTags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase());
    const tags = hasTag
      ? currentTags.filter((candidate) => candidate.toLowerCase() !== tag.toLowerCase())
      : [...currentTags, tag];
    void updateThreadTags(thread, tags, tag === "Resolved" && !hasTag ? "RESOLVED" : undefined);
  }

  function commitNewThreadTag(thread: ThreadView) {
    const tag = newTagDraft.trim().slice(0, 48);
    setNewTagThreadId(null);
    setNewTagDraft("");
    if (!tag) {
      return;
    }
    toggleThreadTag(thread, tag);
  }

  // Follow-up into an EDIT session: instead of a conversation run, start a new
  // SELECTION_EDIT run threaded under the session (parentRunId). The server
  // gives the agent the prior attempts' transcript, and the prior work is
  // already merged into the base checkout, so the agent continues rather than
  // restarts. The result applies through the normal selection pipeline — via
  // the surviving marker, or the end-of-document fallback if the anchor is gone.
  async function handleEditSessionFollowUp(rootId: string, message: string) {
    const conversation = conversations.find((c) => c.rootId === rootId);
    if (!conversation) return;
    const rootRun = conversation.runs[0];
    const latestRun = conversation.latestRun;
    const selectionId = rootRun.selectionId ?? parseAiRunSelectionId(rootRun.triggerId ?? null);

    setAgentBusy(true);
    setGlobalError(null);
    await ensureAgentNotificationPermission();

    let markerRange: { from: number; to: number } | null = null;
    let selectedText = "";
    if (editor && selectionId) {
      markerRange = getAiEditSelectionRange(editor.state, selectionId);
      if (markerRange && markerRange.to > markerRange.from) {
        selectedText = editor.state.doc.textBetween(markerRange.from, markerRange.to, "\n");
      }
    }

    const pendingRun: ActiveAiRunView = {
      id: `pending-edit-${Date.now()}`,
      triggerType: "SELECTION_EDIT",
      parentRunId: latestRun.id,
      selectionId: selectionId ?? null,
      instruction: message,
      status: "RUNNING",
      progress: "Starting Claude research agent.",
      startedAt: new Date().toISOString(),
      events: [
        {
          id: `pending-event-${Date.now()}`,
          role: "user",
          message,
          createdAt: new Date().toISOString()
        }
      ]
    };
    syncAiRuns([pendingRun, ...aiRuns]);
    setAgentMessage("");
    setComposeMode("selected");
    setSelectedConversationId(rootId);

    const response = await fetch(`/api/documents/${documentId}/ai-edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText,
        instruction: message,
        selectionId,
        parentRunId: latestRun.id,
        shareToken,
        suggest: canWriteDocument ? undefined : true
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.aiRunId) {
      reportClientError(data?.error ?? "Agent follow-up failed to start.", "agent-edit-followup", {
        documentId,
        parentRunId: latestRun.id,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      syncAiRuns(aiRuns.filter((run) => run.id !== pendingRun.id));
      setAgentBusy(false);
      return;
    }
    // Re-arm the shimmer on the surviving anchor so the document shows the
    // session is active again; the poll's syncRuns keeps it labeled.
    if (editor && selectionId && markerRange) {
      editor.view.dispatch(
        upsertAiEditSelection(editor.state, {
          id: selectionId,
          from: markerRange.from,
          to: markerRange.to,
          progress: "Working…"
        })
      );
    }
    logClientEvent({
      scope: "ai-edit-kickoff",
      level: "info",
      message: "edit session follow-up accepted by server",
      data: { documentId, selectionId, aiRunId: data.aiRunId, parentRunId: latestRun.id }
    });
    agentRunIdRef.current = data.aiRunId;
  }

  async function handleStopAgentRun(runId: string) {
    const response = await fetch(`/api/documents/${documentId}/ai-runs/${runId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", shareToken })
    }).catch(() => null);
    const data = await response?.json().catch(() => null);
    if (!response?.ok) {
      reportClientError(data?.error ?? "Could not stop the agent run.", "agent-cancel", {
        documentId,
        runId,
        status: response?.status ?? null
      });
      return;
    }
    logClientEvent({
      scope: "agent-cancel",
      level: "info",
      message: "agent run cancel requested",
      data: { documentId, runId, cancelled: data?.cancelled ?? null }
    });
  }

  async function handleAgentConversation(options?: { previousRunId?: string | null; rootId?: string | null }) {
    const message = agentMessage.trim();
    if (!message) {
      return;
    }

    const previousRunId = options?.previousRunId ?? null;
    const followUpRootId = options?.rootId ?? previousRunId ?? null;

    // Follow-ups into an edit session continue the EDIT, not a chat.
    if (followUpRootId) {
      const conversation = conversations.find((c) => c.rootId === followUpRootId);
      if (conversation && conversation.runs[0]?.triggerType === "SELECTION_EDIT") {
        await handleEditSessionFollowUp(followUpRootId, message);
        return;
      }
    }

    setAgentBusy(true);
    setGlobalError(null);
    setAgentPanelOpen(true);
    await ensureAgentNotificationPermission();

    const pendingRun: ActiveAiRunView = {
      id: `pending-conversation-${Date.now()}`,
      triggerType: previousRunId ? "CONVERSATION_FOLLOWUP" : "CONVERSATION",
      parentRunId: previousRunId,
      instruction: message,
      status: "RUNNING",
      progress: "Starting Claude research agent.",
      startedAt: new Date().toISOString(),
      events: [
        {
          id: `pending-event-${Date.now()}`,
          role: "user",
          message,
          createdAt: new Date().toISOString()
        }
      ]
    };
    syncAiRuns([pendingRun, ...aiRuns]);
    setAgentMessage("");
    setComposeMode("selected");
    if (followUpRootId) {
      setSelectedConversationId(followUpRootId);
    }

    emitTourEvent("agent-run-started");
    const response = await fetch(`/api/documents/${documentId}/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        shareToken,
        previousRunId
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.aiRun) {
      reportClientError(data?.error ?? "Agent message failed.", "agent-message", {
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setAgentBusy(false);
      return;
    }

    const nextRuns = [
      data.aiRun,
      ...aiRuns.filter((run) => run.id !== pendingRun.id && run.id !== data.aiRun.id)
    ];
    syncAiRuns(nextRuns);
    if (!followUpRootId) {
      const resolvedRootId = data.aiRun.parentRunId
        ? buildConversations(nextRuns).find((c) => c.runs.some((r) => r.id === data.aiRun.id))?.rootId ?? data.aiRun.id
        : data.aiRun.id;
      setSelectedConversationId(resolvedRootId);
    }
    // Run accepted (202); it executes server-side now. Keep the input disabled
    // until the run terminates — the completion effect clears agentBusy when the
    // polled run reaches a terminal state.
    agentRunIdRef.current = data.aiRun.id;
  }

  async function handleCreateShareLink(permission: PermissionLevelValue) {
    setCreatingLink(permission);
    setGlobalError(null);

    const response = await fetch("/api/share-links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        documentId,
        permission
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.shareLink) {
      reportClientError(data?.error ?? "Unable to create share link.", "share-link-create", {
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setCreatingLink(null);
      return;
    }

    setShareLinks((current) => [data.shareLink, ...current]);
    setCreatingLink(null);
  }

  async function handleRevokeShareLink(linkId: string) {
    const response = await fetch(`/api/share-links/${linkId}/revoke`, {
      method: "POST"
    });

    if (!response.ok) {
      reportClientError("Unable to revoke share link.", "share-link-revoke", { documentId });
      return;
    }

    setShareLinks((current) => current.filter((link) => link.id !== linkId));
  }

  async function handleInviteCollaborator() {
    if (!inviteEmail.trim()) {
      return;
    }

    setInviteBusy(true);
    setGlobalError(null);

    const response = await fetch("/api/memberships", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        documentId,
        email: inviteEmail.trim(),
        permission: invitePermission
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.membership) {
      reportClientError(data?.error ?? "Unable to add collaborator.", "collaborator-add", {
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setInviteBusy(false);
      return;
    }

    setMembers((current) => {
      const existingIndex = current.findIndex((member) => member.user.id === data.membership.user.id);
      if (existingIndex === -1) {
        return [...current, data.membership];
      }

      return current.map((member) =>
        member.user.id === data.membership.user.id ? data.membership : member
      );
    });
    setInviteEmail("");
    setInvitePermission("COMMENT");
    setInviteBusy(false);
  }

  function markThreadRead(threadId: string) {
    const now = new Date().toISOString();
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId ? { ...thread, lastReadAt: now } : thread
      )
    );
    void fetch(`/api/comments/${threadId}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shareToken })
    }).catch(() => null);
  }

  function focusThread(thread: ThreadView) {
    setActiveThreadId(thread.id);
    setSelectionPopoverMode(null);
    if (currentUserId && isThreadUnread(thread, currentUserId)) {
      markThreadRead(thread.id);
    }

    if (editor) {
      try {
        const range = resolveCommentAnchorRange(editor.state.doc, thread);
        if (!range) {
          return;
        }

        editor.commands.setTextSelection({ from: range.fromPos, to: range.toPos });
        editor.commands.focus();
      } catch {
        // Ignore stale positions after content edits.
      }
    }
  }

  async function handleDeleteComment(commentId: string) {
    setDeleteBusyCommentId(commentId);
    setGlobalError(null);

    const response = await fetch(`/api/comments/comment/${commentId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        clientId: collabClientIdRef.current,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.deletedCommentId) {
      reportClientError(data?.error ?? "Unable to delete comment.", "comment-delete", {
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setDeleteBusyCommentId(null);
      return;
    }

    if (data.deletedThreadId) {
      setThreads((current) => {
        const nextThreads = current.filter((thread) => thread.id !== data.deletedThreadId);
        setActiveThreadId((activeId) =>
          activeId === data.deletedThreadId ? nextThreads[0]?.id ?? null : activeId
        );
        return nextThreads;
      });
      setDeleteBusyCommentId(null);
      return;
    }

    setThreads((current) =>
      current.map((thread) =>
        thread.comments.some((comment) => comment.id === data.deletedCommentId)
          ? {
              ...thread,
              comments: thread.comments.filter((comment) => comment.id !== data.deletedCommentId)
            }
          : thread
      )
    );
    setDeleteBusyCommentId(null);
  }

  async function handleEditComment(commentId: string, nextBody: string) {
    const trimmed = nextBody.trim();
    if (!trimmed) return;
    setEditBusyCommentId(commentId);
    setGlobalError(null);

    const response = await fetch(`/api/comments/comment/${commentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: trimmed, clientId: collabClientIdRef.current, shareToken })
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.comment) {
      reportClientError(data?.error ?? "Unable to edit comment.", "comment-edit", {
        documentId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
      });
      setEditBusyCommentId(null);
      return;
    }

    setThreads((current) =>
      current.map((thread) =>
        thread.comments.some((comment) => comment.id === data.comment.id)
          ? {
              ...thread,
              comments: thread.comments.map((comment) =>
                comment.id === data.comment.id ? data.comment : comment
              )
            }
          : thread
      )
    );
    setEditBusyCommentId(null);
  }

  function applyReactionsToComment(commentId: string, map: (reactions: ReactionSummary[]) => ReactionSummary[]) {
    setThreads((current) =>
      current.map((thread) =>
        thread.comments.some((comment) => comment.id === commentId)
          ? {
              ...thread,
              comments: thread.comments.map((comment) =>
                comment.id === commentId ? { ...comment, reactions: map(comment.reactions ?? []) } : comment
              )
            }
          : thread
      )
    );
  }

  async function handleToggleReaction(commentId: string, emoji: string) {
    if (!canWriteComments) return;
    // Optimistic toggle; toggleReactionLocal is its own inverse, so we revert by
    // re-applying it if the request fails.
    applyReactionsToComment(commentId, (reactions) => toggleReactionLocal(reactions ?? [], emoji, currentUserName));

    const response = await fetch(`/api/comments/comment/${commentId}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji, clientId: collabClientIdRef.current, shareToken })
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !Array.isArray(data?.reactions)) {
      applyReactionsToComment(commentId, (reactions) => toggleReactionLocal(reactions ?? [], emoji, currentUserName));
      reportClientError(data?.error ?? "Unable to react.", "comment-reaction", {
        documentId,
        status: response.status
      });
      return;
    }

    // Reconcile with the server's authoritative aggregation.
    applyReactionsToComment(commentId, () => data.reactions);
  }

  const availableCommentTags = useMemo(() => {
    const tags = new Map<string, string>();
    DEFAULT_COMMENT_TAGS.forEach((tag) => tags.set(tag.toLowerCase(), tag));
    threads.forEach((thread) => {
      getThreadTags(thread).forEach((tag) => tags.set(tag.toLowerCase(), tag));
    });
    return Array.from(tags.values()).sort((left, right) => left.localeCompare(right));
  }, [threads]);

  function getCommentTagFilter(tag: string) {
    return commentTagFilters[tag.toLowerCase()] ?? "all";
  }

  function setCommentTagFilter(tag: string, value: CommentTagFilterValue) {
    setCommentTagFilters((current) => ({
      ...current,
      [tag.toLowerCase()]: value
    }));
  }

  const hasUnresolvedThreads = useMemo(
    () => threads.some((thread) => thread.status === "OPEN"),
    [threads]
  );

  const visibleThreads = useMemo(
    () =>
      threads.filter((thread) => {
        const threadTags = getThreadTags(thread);
        for (const tag of availableCommentTags) {
          const filter = commentTagFilters[tag.toLowerCase()] ?? "all";
          if (filter === "all") {
            continue;
          }
          const hasTag = threadTags.some((threadTag) => threadTag.toLowerCase() === tag.toLowerCase());
          if (filter === "yes" && !hasTag) {
            return false;
          }
          if (filter === "no" && hasTag) {
            return false;
          }
        }

        // Hide threads whose anchor no longer exists in the document. When the
        // anchored text is deleted the inline commentAnchor mark goes with it;
        // when an anchored block atom (widget/repoImage/image) is deleted its
        // commentThreadIds attr goes with it. Either way the thread is orphaned
        // and should disappear from the rail, just like a deleted-text comment.
        if (editor) {
          const range = resolveCommentAnchorRange(editor.state.doc, thread);
          if (!range) return false;

          // When the doc has tabs, also hide threads anchored outside the active tab.
          if (tabs.length > 0 && activeTabId) {
            const activeTab = tabs.find((tab) => tab.id === activeTabId);
            if (activeTab) {
              const anchorPos = range.fromPos;
              if (anchorPos < activeTab.contentFrom || anchorPos > activeTab.contentTo) {
                return false;
              }
            }
          }
        }
        return true;
      }),
    // docRevision forces recompute when the doc (and its comment anchors) changes.
    [availableCommentTags, commentTagFilters, threads, editor, tabs, activeTabId, docRevision]
  );

  const orderedThreads = useMemo(() => {
    const inactiveThreads = visibleThreads.filter((thread) => thread.id !== activeThreadId);
    const activeThread = visibleThreads.find((thread) => thread.id === activeThreadId);
    return activeThread ? [...inactiveThreads, activeThread] : inactiveThreads;
  }, [activeThreadId, visibleThreads]);
  const selectedVersion =
    historyVersions.find((version) => version.id === selectedVersionId) ?? historyVersions[0] ?? null;
  const conversations = useMemo(() => buildConversations(aiRuns), [aiRuns]);
  const selectedConversation = useMemo(() => {
    if (composeMode === "new") return null;
    if (selectedConversationId) {
      const found = conversations.find((c) => c.rootId === selectedConversationId);
      if (found) return found;
    }
    return conversations[0] ?? null;
  }, [composeMode, conversations, selectedConversationId]);

  useEffect(() => {
    if (composeMode === "new") return;
    if (!selectedConversationId && conversations[0]) {
      setSelectedConversationId(conversations[0].rootId);
      return;
    }
    if (
      selectedConversationId &&
      conversations.length > 0 &&
      !conversations.some((c) => c.rootId === selectedConversationId)
    ) {
      setSelectedConversationId(conversations[0].rootId);
    }
  }, [composeMode, conversations, selectedConversationId]);

  useEffect(() => {
    if (!editor) return;

    const selectionRuns: Array<{ run: ActiveAiRunView; selectionId: string }> = [];
    const settledSelectionIds: string[] = [];

    for (const run of aiRuns) {
      if (run.triggerType !== "SELECTION_EDIT") continue;
      const selectionId = run.selectionId ?? parseAiRunSelectionId(run.triggerId);
      if (!selectionId) continue;
      if (run.status === "RUNNING") {
        selectionRuns.push({ run, selectionId });
      } else if (run.status === "SUCCEEDED" && run.appliedAt) {
        // Applied (possibly by another session): drop any lingering local entry
        // so the "working" shimmer doesn't outlive the run.
        settledSelectionIds.push(selectionId);
      }
    }

    editor.view.dispatch(syncAiEditSelectionRuns(editor.state, selectionRuns, settledSelectionIds));
  }, [aiRuns, editor]);

  useEffect(() => {
    if (!editor) return;

    for (const run of aiRuns) {
      if (run.triggerType !== "SELECTION_EDIT") continue;
      const selectionId = run.selectionId ?? parseAiRunSelectionId(run.triggerId);
      if (!selectionId) continue;
      const prev = aiEditRunStateRef.current.get(run.id);
      if (prev === "applying" || prev === "applied" || prev === "failed") continue;

      if (run.status === "FAILED") {
        aiEditRunStateRef.current.set(run.id, "failed");
        const finishedAtMs = run.finishedAt ? new Date(run.finishedAt).getTime() : 0;
        const isStaleFromPreviousSession =
          finishedAtMs > 0 && finishedAtMs < mountedAtRef.current - 5_000;
        // Keep the selection marker alive so the user can retry the SAME
        // instruction on the SAME range without re-selecting and re-typing. The
        // marker only survives if the range still exists; if it was deleted
        // out from under the run there is nothing to retry, so fall back to the
        // old cleanup behavior.
        const markerRange = getAiEditSelectionRange(editor.state, selectionId);
        if (!isStaleFromPreviousSession) {
          reportClientError(run.error ?? "AI edit failed.", "ai-edit-run-failed", {
            documentId,
            selectionId,
            aiRunId: run.id,
            retryable: !!markerRange
          });
          notifyAgentCompleted({
            id: run.id,
            triggerType: "SELECTION_EDIT",
            instruction: run.instruction,
            status: "FAILED"
          });
        }
        setActiveAiRun(null);
        if (markerRange && !isStaleFromPreviousSession) {
          // Keep the highlight but drop the "running" progress label so the
          // marker doesn't look like it's still working.
          editor.view.dispatch(
            upsertAiEditSelection(editor.state, {
              id: selectionId,
              from: markerRange.from,
              to: markerRange.to,
              progress: null
            })
          );
          setFailedAiEdit({
            selectionId,
            aiRunId: run.id,
            instruction: run.instruction ?? "",
            error: run.error ?? "AI edit failed."
          });
        } else {
          editor.view.dispatch(removeAiEditSelection(editor.state, selectionId));
        }
        continue;
      }

      if (run.status !== "SUCCEEDED") continue;
      if (run.appliedAt) {
        aiEditRunStateRef.current.set(run.id, "applied");
        continue;
      }

      aiEditRunStateRef.current.set(run.id, "applying");
      void aiApplyQueueRef.current.run(async () => {
        const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
        const response = await fetch(
          `/api/documents/${documentId}/ai-runs/${run.id}${shareQuery}`,
          { cache: "no-store" }
        ).catch(() => null);
        const data = await response?.json().catch(() => null);
        const fetched = data?.aiRun;
        if (!response?.ok || !fetched) {
          logClientEvent({
            scope: "ai-edit-fetch-result",
            level: "error",
            message: "failed to fetch ai run result",
            data: {
              documentId,
              selectionId,
              aiRunId: run.id,
              status: response?.status ?? null
            }
          });
          // Retry on the next poll cycle by clearing our state mark.
          aiEditRunStateRef.current.delete(run.id);
          return;
        }
        const fetchedWidgets = Array.isArray(fetched.widgets) ? (fetched.widgets as AiEditWidget[]) : [];
        const fetchedImages = Array.isArray(fetched.images) ? (fetched.images as AiEditImage[]) : [];
        if (
          !aiEditRunHasApplicableContent({
            replacementText: typeof fetched.replacementText === "string" ? fetched.replacementText : null,
            images: fetchedImages,
            widgets: fetchedWidgets
          })
        ) {
          // Legacy run that completed before the replacement column existed, or
          // any other "succeeded with no payload" state (no text AND no
          // images/widgets). Claim it so we stop re-fetching it every 2s. A run
          // with an empty replacement but images/widgets is NOT dropped here — it
          // falls through and inserts the assets (replacing the selection).
          logClientEvent({
            scope: "ai-edit-fetch-result",
            level: "warn",
            message: "succeeded run has no applicable content; claiming to stop retry",
            data: { documentId, selectionId, aiRunId: run.id }
          });
          await fetch(`/api/documents/${documentId}/ai-runs/${run.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "markApplied", shareToken })
          }).catch(() => null);
          aiEditRunStateRef.current.set(run.id, "applied");
          editor.view.dispatch(removeAiEditSelection(editor.state, selectionId));
          return;
        }
        const agentSuggestions = Array.isArray(fetched.suggestions)
          ? (fetched.suggestions as AgentSuggestionInput[])
          : [];
        if (fetched.suggestOnly) {
          // Comment-access user asked the agent to edit their selection: land the
          // replacement as a tracked change over the selection (not committed),
          // plus any out-of-selection suggestions the agent proposed.
          const range = getAiEditSelectionRange(editor.state, selectionId);
          const author: SuggestionAuthor = {
            authorId: `ai-run:${run.id}`,
            authorLabel: typeof fetched.model === "string" ? fetched.model : "AI"
          };
          const runImages = Array.isArray(fetched.images) ? (fetched.images as AiEditImage[]) : [];
          const runSources = Array.isArray(fetched.sources) ? (fetched.sources as string[]) : [];
          if (range) {
            applyRichTrackedReplacement(
              range,
              typeof fetched.replacementText === "string" ? fetched.replacementText : "",
              author,
              runImages,
              runSources
            );
          }
          applyAgentSuggestions(run.id, agentSuggestions, fetched.model, runImages, runSources);
          if (Array.isArray(fetched.agentComments)) {
            applyAgentComments(run.id, fetched.agentComments as Array<{ threadId: string; findText: string }>);
          }
          editor.view.dispatch(removeAiEditSelection(editor.state, selectionId));
          await flushCollaborationSteps();
          await fetch(`/api/documents/${documentId}/ai-runs/${run.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "markApplied", shareToken })
          }).catch(() => null);
          setActiveAiRun(null);
          setActiveAiTarget(null);
          aiEditRunStateRef.current.set(run.id, "applied");
          return;
        }
        await applyAiEditRun({
          aiRunId: run.id,
          selectionId,
          instruction: run.instruction,
          replacementText: typeof fetched.replacementText === "string" ? fetched.replacementText : "",
          images: fetchedImages,
          widgets: fetchedWidgets,
          sources: Array.isArray(fetched.sources) ? (fetched.sources as string[]) : [],
          commitSha: typeof fetched.commitSha === "string" ? fetched.commitSha : null,
          commitUrl: typeof fetched.commitUrl === "string" ? fetched.commitUrl : null
        });
        // The agent may also have proposed edits OUTSIDE the selection and/or
        // left standalone comments.
        const editAgentComments = Array.isArray(fetched.agentComments)
          ? (fetched.agentComments as Array<{ threadId: string; findText: string }>)
          : [];
        if (agentSuggestions.length > 0) {
          applyAgentSuggestions(
            run.id,
            agentSuggestions,
            fetched.model,
            Array.isArray(fetched.images) ? (fetched.images as AiEditImage[]) : [],
            Array.isArray(fetched.sources) ? (fetched.sources as string[]) : []
          );
        }
        if (editAgentComments.length > 0) {
          applyAgentComments(run.id, editAgentComments);
        }
        if (agentSuggestions.length > 0 || editAgentComments.length > 0) {
          await flushCollaborationSteps();
        }
        aiEditRunStateRef.current.set(run.id, "applied");
      });
    }
  }, [aiRuns, editor, documentId, shareToken]);

  // Apply tracked-change suggestions proposed by comment-reply / conversation
  // agents (SELECTION_EDIT runs are handled by the loop above). Each run is
  // processed once per session; markApplied makes it idempotent across reloads so
  // the persisted marks are not re-applied.
  const suggestionRunProcessedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!editor || !canPersistEdits) return;
    for (const run of aiRuns) {
      if (run.status !== "SUCCEEDED") continue;
      if (run.triggerType === "SELECTION_EDIT") continue;
      if (run.appliedAt) {
        suggestionRunProcessedRef.current.add(run.id);
        continue;
      }
      if (suggestionRunProcessedRef.current.has(run.id)) continue;
      suggestionRunProcessedRef.current.add(run.id);
      void (async () => {
        const shareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
        const response = await fetch(
          `/api/documents/${documentId}/ai-runs/${run.id}${shareQuery}`,
          { cache: "no-store" }
        ).catch(() => null);
        const data = await response?.json().catch(() => null);
        const fetched = data?.aiRun;
        const suggestions = Array.isArray(fetched?.suggestions)
          ? (fetched.suggestions as AgentSuggestionInput[])
          : [];
        const agentComments = Array.isArray(fetched?.agentComments)
          ? (fetched.agentComments as Array<{ threadId: string; findText: string }>)
          : [];
        if (suggestions.length > 0) {
          applyAgentSuggestions(
            run.id,
            suggestions,
            fetched?.model,
            Array.isArray(fetched?.images) ? (fetched.images as AiEditImage[]) : [],
            Array.isArray(fetched?.sources) ? (fetched.sources as string[]) : []
          );
        }
        if (agentComments.length > 0) {
          applyAgentComments(run.id, agentComments);
        }
        if (suggestions.length > 0 || agentComments.length > 0) {
          await flushCollaborationSteps();
        }
        // Mark applied so a reload doesn't re-apply the now-persisted suggestions.
        await fetch(`/api/documents/${documentId}/ai-runs/${run.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "markApplied", shareToken })
        }).catch(() => null);
      })();
    }
  }, [aiRuns, editor, documentId, shareToken, canPersistEdits]);

  // Clear async run busy-state once the run we kicked off reaches a terminal
  // state in the polled runs. (The comment reply itself arrives via the SSE
  // comment-created broadcast; conversation replies arrive as polled run events.)
  useEffect(() => {
    const waitingAskAi = askAiRunIdRef.current;
    if (waitingAskAi) {
      const run = aiRuns.find((candidate) => candidate.id === waitingAskAi);
      if (run && run.status !== "RUNNING") {
        askAiRunIdRef.current = null;
        setAiBusyThreadId(null);
        setActiveAiTarget((current) =>
          current?.type === "comment-thread" && current.threadId === run.triggerId ? null : current
        );
      }
    }

    const waitingAgent = agentRunIdRef.current;
    if (waitingAgent) {
      const run = aiRuns.find((candidate) => candidate.id === waitingAgent);
      if (run && run.status !== "RUNNING") {
        agentRunIdRef.current = null;
        setAgentBusy(false);
      }
    }
  }, [aiRuns]);

  const aiEditMarkCleanupDoneRef = useRef(false);
  useEffect(() => {
    if (!editor || !aiRunsLoaded || aiEditMarkCleanupDoneRef.current) return;
    aiEditMarkCleanupDoneRef.current = true;

    const cleanupTr = cleanupStaleAiEditRangeMarksAfterRunsLoaded(editor.state, aiRuns, aiRunsLoaded);
    if (cleanupTr) editor.view.dispatch(cleanupTr);
  }, [aiRuns, aiRunsLoaded, editor]);

  const commentThreadRunsByThread = useMemo(() => {
    const map = new Map<string, ActiveAiRunView>();
    for (const run of activeAiRuns) {
      if (run.status !== "RUNNING") continue;
      if (run.triggerType !== "COMMENT_THREAD" || !run.triggerId) continue;
      if (!map.has(run.triggerId)) {
        map.set(run.triggerId, run);
      }
    }
    return map;
  }, [activeAiRuns]);

  return (
    <section className="workspace-shell">
      {globalError ? (
        <div className="error-toast" role="alert" aria-live="assertive" onClick={() => setGlobalError(null)}>
          {globalError}
        </div>
      ) : null}

      {failedAiEdit ? (
        <div className="ai-edit-retry-toast" role="alert" aria-live="assertive">
          <div className="ai-edit-retry-toast__body">
            <strong>AI edit failed.</strong>
            <span className="ai-edit-retry-toast__detail">
              {failedAiEdit.error || "The agent run did not complete."}
            </span>
            <span className="ai-edit-retry-toast__hint">Your selection is still highlighted.</span>
          </div>
          <div className="ai-edit-retry-toast__actions">
            <button
              type="button"
              className="ai-edit-retry-toast__retry"
              onClick={() => void retryFailedAiEdit()}
            >
              Retry
            </button>
            <button
              type="button"
              className="ai-edit-retry-toast__dismiss"
              onClick={dismissFailedAiEdit}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {findOpen && editor ? (
        <FindBar editor={editor} canReplace={canWriteDocument} onClose={() => setFindOpen(false)} />
      ) : null}

      {agentPanelOpen ? null : (
      <>
      {isPublicView ? null : (
      <div className="document-chrome">
        <div className="document-topbar">
          <div className="document-topbar-left">
            <input
              aria-label="Document title"
              className="document-title-input"
              data-tour="doc-title"
              disabled={!canWriteDocument}
              onBlur={handleSaveTitleBlur}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </div>

          <div className="document-compact-status">
            <span className="save-indicator" data-state={saveState} role="status" aria-live="polite">
              <span className="save-indicator-dot" aria-hidden="true" />
              {saveState === "saving"
                ? "Saving"
                : saveState === "saved"
                  ? "Saved"
                  : saveState === "error"
                    ? "Save failed"
                    : "Ready"}
            </span>
            <span className="doc-word-count" title={`${docStats.characters} characters`}>
              {docStats.words} {docStats.words === 1 ? "word" : "words"}
            </span>
          </div>

          <button
            aria-controls="document-topbar-tools"
            aria-expanded={chromeMenuOpen}
            className={`ghost-button document-tools-toggle${chromeMenuOpen ? " active" : ""}`}
            onClick={() => setChromeMenuOpen((value) => !value)}
            type="button"
          >
            Menu
          </button>

          <div
            className="document-topbar-tools"
            data-open={chromeMenuOpen ? "true" : "false"}
            id="document-topbar-tools"
          >
          <ExportMenu documentId={documentId} shareToken={shareToken} />

          <FileMenu currentDocumentId={documentId} onOpenVersionHistory={() => setHistoryOpen(true)} />

          {canPersistEdits && (
            <div className="suggestion-mode-controls">
              {canWriteDocument ? (
                <button
                  aria-pressed={suggestingMode}
                  className={`ghost-button header-toggle-button${suggestingMode ? " active" : ""}`}
                  onClick={() => setSuggestingMode((value) => !value)}
                  title={
                    suggestingMode
                      ? "Suggesting: your edits become tracked changes. Click to edit directly."
                      : "Editing directly. Click to switch to suggesting (tracked changes)."
                  }
                  type="button"
                >
                  {suggestingMode ? "Suggesting" : "Editing"}
                </button>
              ) : (
                <span
                  className="ghost-button header-toggle-button active suggestion-mode-locked"
                  title="You have comment access — your edits are saved as suggestions."
                >
                  Suggesting
                </span>
              )}

              {distinctSuggestions.length > 0 && (
                <div className="suggestion-review">
                  <button
                    aria-pressed={suggestionPanelOpen}
                    className={`ghost-button header-toggle-button${suggestionPanelOpen ? " active" : ""}`}
                    onClick={() => setSuggestionPanelOpen((value) => !value)}
                    type="button"
                  >
                    {distinctSuggestions.length} suggestion{distinctSuggestions.length === 1 ? "" : "s"}
                  </button>
                  {suggestionPanelOpen && (
                    <div className="suggestion-review-panel" role="menu">
                      {canWriteDocument && (
                        <div className="suggestion-review-bulk">
                          <button type="button" className="ghost-button" onClick={handleAcceptAllSuggestions}>
                            Accept all
                          </button>
                          <button type="button" className="ghost-button" onClick={handleRejectAllSuggestions}>
                            Reject all
                          </button>
                        </div>
                      )}
                      <ul className="suggestion-review-list">
                        {distinctSuggestions.map((suggestion) => (
                          <li key={suggestion.id} className="suggestion-review-item">
                            <span className="suggestion-review-meta">
                              {suggestion.kinds.has("insert") && suggestion.kinds.has("delete")
                                ? "Replace"
                                : suggestion.kinds.has("insert")
                                  ? "Insert"
                                  : "Delete"}
                              {suggestion.authorLabel ? ` · ${suggestion.authorLabel}` : ""}
                            </span>
                            {canWriteDocument && (
                              <span className="suggestion-review-actions">
                                <button
                                  type="button"
                                  className="ghost-button"
                                  onClick={() => handleAcceptSuggestion(suggestion.id)}
                                >
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button"
                                  onClick={() => handleRejectSuggestion(suggestion.id)}
                                >
                                  Reject
                                </button>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <button
            aria-pressed={formatBarOpen}
            className={`ghost-button header-toggle-button${formatBarOpen ? " active" : ""}`}
            onClick={() => setFormatBarOpen((value) => !value)}
            type="button"
          >
            Format
          </button>

          <div className="format-bar-placeholder" data-open={formatBarOpen ? "true" : "false"} hidden={!formatBarOpen}>
            <div className="editor-toolbar" role="toolbar" aria-label="Document formatting">
              <div className="editor-toolbar-group">
                <ToolbarButton
                  active={editor?.isActive("heading", { level: 1 }) ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Title"
                  onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
                />
                <ToolbarButton
                  active={editor?.isActive("heading", { level: 2 }) ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="H2"
                  onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
                />
                <ToolbarButton
                  active={editor?.isActive("paragraph") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Text"
                  onClick={() => editor?.chain().focus().setParagraph().run()}
                />
              </div>

              <div className="editor-toolbar-group">
                <ToolbarButton
                  active={editor?.isActive("bold") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="B"
                  onClick={() => editor?.chain().focus().toggleBold().run()}
                />
                <ToolbarButton
                  active={editor?.isActive("italic") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="I"
                  onClick={() => editor?.chain().focus().toggleItalic().run()}
                />
                <ToolbarButton
                  active={editor?.isActive("underline") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="U"
                  onClick={() => editor?.chain().focus().toggleUnderline().run()}
                />
              </div>

              <div className="editor-toolbar-group">
                <ToolbarButton
                  active={editor?.isActive("bulletList") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Bullets"
                  onClick={() => editor?.chain().focus().toggleBulletList().run()}
                />
                <ToolbarButton
                  active={editor?.isActive("orderedList") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Numbered"
                  onClick={() => editor?.chain().focus().toggleOrderedList().run()}
                />
                <ToolbarButton
                  active={editor?.isActive("blockquote") ?? false}
                  disabled={!canWriteDocument || !editor}
                  label="Quote"
                  onClick={() => editor?.chain().focus().toggleBlockquote().run()}
                />
                <ToolbarButton
                  disabled={!canManageAutomation || !editor}
                  label="Widget"
                  onClick={handleInsertWidget}
                />
                <ToolbarButton
                  disabled={!canWriteDocument || !editor || attachmentBusy}
                  label={attachmentBusy ? "Uploading…" : "Attach"}
                  onClick={handleAttachClick}
                />
                <input
                  ref={attachmentInputRef}
                  className="visually-hidden-input"
                  onChange={handleAttachmentSelected}
                  style={{ display: "none" }}
                  type="file"
                />
              </div>

              <div className="editor-toolbar-group editor-toolbar-table-group">
                <ToolbarButton
                  disabled={!canWriteDocument || !editor}
                  label="Table"
                  onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
                />
                <ToolbarButton
                  disabled={!canWriteDocument || !tableControlsActive}
                  label="+ Row"
                  onClick={() => editor?.chain().focus().addRowAfter().run()}
                />
                <ToolbarButton
                  disabled={!canWriteDocument || !tableControlsActive}
                  label="- Row"
                  onClick={() => editor?.chain().focus().deleteRow().run()}
                />
                <ToolbarButton
                  disabled={!canWriteDocument || !tableControlsActive}
                  label="+ Col"
                  onClick={() => editor?.chain().focus().addColumnAfter().run()}
                />
                <ToolbarButton
                  disabled={!canWriteDocument || !tableControlsActive}
                  label="- Col"
                  onClick={() => editor?.chain().focus().deleteColumn().run()}
                />
                <ToolbarButton
                  disabled={!canWriteDocument || !tableControlsActive}
                  label="Delete"
                  onClick={() => editor?.chain().focus().deleteTable().run()}
                />
              </div>
            </div>
          </div>

          <details className="header-menu header-menu-comments">
            <summary>Comments</summary>
            <div className="header-menu-panel comment-filter-panel" aria-label="Comment filters">
              {availableCommentTags.map((tag) => {
                const filter = getCommentTagFilter(tag);
                return (
                  <div className="comment-tag-filter-row" key={tag}>
                    <span>{tag}</span>
                    <div className="comment-tag-filter-controls" role="group" aria-label={`${tag} filter`}>
                      {(["yes", "no", "all"] as CommentTagFilterValue[]).map((value) => (
                        <button
                          className={filter === value ? "active" : ""}
                          key={value}
                          onClick={() => setCommentTagFilter(tag, value)}
                          type="button"
                        >
                          {value === "yes" ? "Yes" : value === "no" ? "No" : "All"}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </details>

          <details className="header-menu header-menu-wide" data-tour="repo-menu">
            <summary>Repo</summary>
            <div className="header-menu-panel research-repo-panel">
              <div>
                <strong>Research repository</strong>
                <p>
                  {repoUrl
                    ? `${repoUrl}${repoBranch ? ` on ${repoBranch}` : ""}${repoUrl.startsWith("https://huggingface.co/") ? " (read-only)" : ""}`
                    : "Link a GitHub repo, or a public HuggingFace repo (read-only), to give the AI a checked-out workspace."}
                </p>
              </div>
              {canWriteDocument ? (
                <div className="research-repo-controls">
                  <input
                    aria-label="Repository URL"
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/org/repo or https://huggingface.co/datasets/owner/name"
                    value={repoUrl}
                  />
                  <input
                    aria-label="Repository branch"
                    onChange={(event) => setRepoBranch(event.target.value)}
                    placeholder="Branch"
                    value={repoBranch}
                  />
                  <button
                    className="ghost-button"
                    disabled={repoBusy}
                    onClick={handleSaveRepository}
                    type="button"
                  >
                    {repoBusy ? "Saving..." : "Save"}
                  </button>
                </div>
              ) : null}
              {repoNotice ? <span className="subtle-pill">{repoNotice}</span> : null}
              {repoAccessIssue ? (
                <div className="repo-access-warning" role="alert">
                  <strong>We don&apos;t have access to this repository.</strong>
                  {repoAccessIssue.tokenSource === "none" ? (
                    <p>
                      No GitHub credential is connected for this document. If the repository is
                      private (or you want the AI to push to it), connect a GitHub personal access
                      token with access to it under <em>AI credentials</em> in the topbar, then
                      press Save again. Public repositories work read-only without a token — so
                      also check the URL for typos.
                    </p>
                  ) : (
                    <p>
                      This document&apos;s git access runs as{" "}
                      {repoAccessIssue.login ? <code>{repoAccessIssue.login}</code> : "a GitHub account"}{" "}
                      which can&apos;t see the repository. Invite that account as a collaborator
                      (repo → Settings → Collaborators → Add people) and press Save again — the
                      invite is accepted automatically. Or connect your own GitHub token under{" "}
                      <em>AI credentials</em>, or fix a typo in the URL.
                    </p>
                  )}
                  <button
                    className="ghost-button"
                    disabled={repoBusy}
                    onClick={handleSaveRepository}
                    type="button"
                  >
                    {repoBusy ? "Checking..." : "Check again"}
                  </button>
                </div>
              ) : null}
            </div>
          </details>

          {canManageAutomation ? (
            <EnvironmentMenu
              documentId={documentId}
              shareToken={shareToken}
              onKeysChanged={(keys) => {
                setHasOpenRouterKey(keys.includes("OPENROUTER_API_KEY") || credentialHasOpenRouterKey);
                setHasLiteLlmKey(keys.includes("LITELLM_API_KEY") || credentialHasLiteLlmKey);
              }}
            />
          ) : null}

          {canManageAutomation ? <SkillsMenu documentId={documentId} shareToken={shareToken} /> : null}
          </div>

          <div className="document-topbar-actions">
            {remoteNotice ? <span className="subtle-pill">{remoteNotice}</span> : null}
            {viaShareLink ? (
              <span
                className="subtle-pill"
                title={
                  initialPermission === "EDIT"
                    ? "This edit link can run workspace agents, including commands and repository changes."
                    : initialPermission === "COMMENT"
                      ? "Agents can research and suggest, but cannot run commands, change repository files, access document secrets, commit, or push."
                      : "This view link cannot start agents."
                }
              >
                {initialPermission === "EDIT"
                  ? "Shared edit access · AI workspace"
                  : initialPermission === "COMMENT"
                    ? "Shared comment access · AI read-only"
                    : "Shared view access · AI unavailable"}
              </span>
            ) : null}
            {remotePresence.length > 0 ? (
              <div className="collaboration-presence-list" aria-label="Active collaborators">
                {remotePresence.slice(0, 4).map((presence) => (
                  <span
                    className="collaboration-presence-avatar"
                    key={presence.clientId}
                    style={{ backgroundColor: presence.color }}
                    title={presence.typing ? `${presence.userName} is typing` : presence.userName}
                  >
                    {presence.userName.slice(0, 1).toUpperCase()}
                  </span>
                ))}
              </div>
            ) : null}
            <button
              className="ghost-button"
              data-tour="agents-button"
              onClick={() => setAgentPanelOpen((open) => !open)}
              type="button"
            >
              Agents{activeAiRuns.length > 0 ? ` (${activeAiRuns.length})` : ""}
            </button>
            {isOwner ? (
              <button className="primary-button" onClick={() => setShareModalOpen(true)} type="button">
                Share
              </button>
            ) : null}
          </div>
        </div>
      </div>
      )}

      {agentToast ? (
        <button
          className="agent-toast"
          onClick={() => {
            dismissAgentToast();
            setAgentPanelOpen(true);
          }}
          type="button"
        >
          <strong>{agentToast.title}</strong>
          <span>{agentToast.body}</span>
        </button>
      ) : null}

      <div
        className="editor-stage"
        data-outline-collapsed={outlineCollapsed ? "true" : "false"}
        data-public-view={isPublicView ? "true" : "false"}
        data-comments-hidden={isPublicView && !hasUnresolvedThreads ? "true" : "false"}
        style={{ "--outline-width": `${isPublicView ? 0 : outlineCollapsed ? 36 : Math.round(outlineWidth)}px` } as React.CSSProperties}
      >
        {isPublicView ? null : (
          <DocOutline
            editor={editor}
            collapsed={outlineCollapsed}
            width={outlineWidth}
            onToggleCollapsed={() => setOutlineCollapsed((value) => !value)}
            onWidthChange={setOutlineWidth}
            tabs={tabs}
            activeTabId={activeTabId}
            canEditTabs={canWriteDocument}
            onSelectTab={handleSelectTab}
            onCreateTab={handleCreateTab}
            onRenameTab={handleRenameTab}
            onDeleteTab={handleDeleteTab}
            onReorderTab={handleReorderTab}
          />
        )}
        <div className="editor-page-shell">
          {tabs.length > 1 ? (
            <nav className="mobile-tab-strip" aria-label="Document tabs">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`mobile-tab-chip${tab.id === activeTabId ? " mobile-tab-chip-active" : ""}`}
                  onClick={() => handleSelectTab(tab.id)}
                  type="button"
                >
                  {tab.title || "Untitled"}
                </button>
              ))}
            </nav>
          ) : null}
          <div className="editor-page" data-tour="editor" ref={editorPageRef}>
            {selection && selectionPopoverMode && (canWriteComments || canWriteDocument) ? (
              <SelectionPopover
                selection={selection}
                mode={selectionPopoverMode}
                canWriteComments={canWriteComments}
                canWriteDocument={canWriteDocument}
                composerBody={composerBody}
                commentBusy={commentBusy}
                editInstruction={editInstruction}
                mentionMembers={mentionMembers}
                onModeChange={setSelectionPopoverMode}
                onComposerBodyChange={setComposerBody}
                onEditInstructionChange={setEditInstruction}
                onSubmitComment={handleCreateComment}
                onSubmitEdit={handleAiEdit}
                onCancel={() => {
                  setSelectionPopoverMode("menu");
                  setComposerBody("");
                  setEditInstruction("");
                }}
              />
            ) : null}

            {suggestionPopover && canWriteDocument ? (
              <div
                className="suggestion-inline-popover"
                style={{ top: suggestionPopover.top, left: suggestionPopover.left }}
                onMouseDown={(event) => event.preventDefault()}
              >
                <span className="suggestion-inline-label">
                  {suggestionPopover.label}
                  {suggestionPopover.authorLabel ? ` · ${suggestionPopover.authorLabel}` : ""}
                </span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => handleAcceptSuggestion(suggestionPopover.id)}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => handleRejectSuggestion(suggestionPopover.id)}
                >
                  Reject
                </button>
              </div>
            ) : null}

            <EditorContent editor={editor} />
            <LinkPopover editor={editor} containerRef={editorPageRef} canEdit={canWriteDocument} />
            <HeadingCopyOverlay editor={editor} containerRef={editorPageRef} />
            <TableInlineControls
              editor={editor}
              containerRef={editorPageRef}
              enabled={canWriteDocument}
            />
            {docMention ? (
              <div
                className="mention-suggest"
                role="listbox"
                style={{ left: docMention.left, top: docMention.top }}
                onMouseDown={(event) => event.preventDefault()}
              >
                {docMention.items.map((candidate, index) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="option"
                    aria-selected={index === docMention.index}
                    className={`mention-suggest-item${index === docMention.index ? " mention-suggest-item-active" : ""}`}
                    onMouseEnter={() =>
                      setDocMention((current) => (current ? { ...current, index } : current))
                    }
                    onClick={() => applyDocMention(candidate)}
                  >
                    <span className="mention-suggest-name">{candidate.name || candidate.email}</span>
                    {candidate.name && candidate.email ? (
                      <span className="mention-suggest-email">{candidate.email}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {isPublicView && !hasUnresolvedThreads ? null : (
        <CommentRail
          threads={threads}
          orderedThreads={orderedThreads}
          activeThreadId={activeThreadId}
          threadOffsets={threadOffsets}
          railHeight={railHeight}
          activeAiRun={activeAiRun}
          commentThreadRunsByThread={commentThreadRunsByThread}
          aiBusyThreadId={aiBusyThreadId}
          replyBusyThreadId={replyBusyThreadId}
          deleteBusyCommentId={deleteBusyCommentId}
          editBusyCommentId={editBusyCommentId}
          canWriteComments={canWriteComments}
          isOwner={isOwner}
          currentUserId={currentUserId}
          mentionViewer={mentionViewer}
          flashCommentIds={flashCommentIds}
          newTagThreadId={newTagThreadId}
          newTagDraft={newTagDraft}
          onFocusThread={focusThread}
          onToggleThreadTag={toggleThreadTag}
          onStartNewTag={(threadId) => {
            setNewTagThreadId(threadId);
            setNewTagDraft("");
          }}
          onChangeNewTagDraft={setNewTagDraft}
          onCommitNewTag={commitNewThreadTag}
          onCancelNewTag={() => {
            setNewTagThreadId(null);
            setNewTagDraft("");
          }}
          getReplyDraft={getReplyDraft}
          onChangeReplyDraft={setReplyDraft}
          onSubmitReply={handleReply}
          onAskAi={handleAskAi}
          onDeleteComment={(commentId) => void handleDeleteComment(commentId)}
          onEditComment={(commentId, commentBody) => void handleEditComment(commentId, commentBody)}
          onToggleReaction={(commentId, emoji) => void handleToggleReaction(commentId, emoji)}
        />
        )}
      </div>
      </>
      )}

      {isPublicView ? null : <OnboardingTour surface="doc" editor={editor} />}

      {agentPanelOpen ? (
        <AgentPanel
          title={title}
          documentId={documentId}
          shareToken={shareToken}
          activeAiRuns={activeAiRuns}
          conversations={conversations}
          selectedConversation={selectedConversation}
          composeMode={composeMode}
          agentMessage={agentMessage}
          agentBusy={agentBusy}
          canWriteComments={canWriteComments}
          canWriteDocument={canWriteDocument}
          agentModel={agentModel}
          agentEffort={agentEffort}
          hasOpenRouterKey={hasOpenRouterKey}
          hasLiteLlmKey={hasLiteLlmKey}
          localModel={localAgentModel}
          onAgentModelChange={(model) => void handleSaveAgentConfig({ model })}
          onAgentEffortChange={(effort) => void handleSaveAgentConfig({ effort })}
          onClose={() => setAgentPanelOpen(false)}
          onSelectConversation={(rootId) => {
            setComposeMode("selected");
            setSelectedConversationId(rootId);
          }}
          onStartNewConversation={() => {
            setComposeMode("new");
            setSelectedConversationId(null);
          }}
          onAgentMessageChange={setAgentMessage}
          onSendAgentMessage={(options) => void handleAgentConversation(options)}
          onStopRun={(runId) => void handleStopAgentRun(runId)}
        />
      ) : null}

      {historyOpen ? (
        <VersionHistoryModal
          loading={historyLoading}
          versions={historyVersions}
          selectedVersion={selectedVersion}
          canRestore={canWriteDocument}
          restoring={restoringVersion}
          onClose={() => setHistoryOpen(false)}
          onSelectVersion={setSelectedVersionId}
          onRestoreVersion={handleRestoreVersion}
        />
      ) : null}

      {widgetDialogOpen ? (
        <WidgetDialog
          busy={widgetBusy}
          draft={widgetDraft}
          onClose={() => setWidgetDialogOpen(false)}
          onChange={setWidgetDraft}
          onSubmit={() => void handleCreateWidget()}
        />
      ) : null}

      {shareModalOpen ? (
        <ShareModal
          members={members}
          shareLinks={shareLinks}
          inviteEmail={inviteEmail}
          invitePermission={invitePermission}
          inviteBusy={inviteBusy}
          creatingLink={creatingLink}
          onChangeInviteEmail={setInviteEmail}
          onChangeInvitePermission={setInvitePermission}
          onInvite={handleInviteCollaborator}
          onCreateShareLink={handleCreateShareLink}
          onRevokeShareLink={handleRevokeShareLink}
          onClose={() => setShareModalOpen(false)}
        />
      ) : null}

      {mergeState ? (
        <DivergenceMergeDialog
          documentId={documentId}
          shareToken={shareToken}
          clientId={collabClientIdRef.current}
          localContent={mergeState.localContent as unknown as DocNode}
        />
      ) : null}
    </section>
  );
}
