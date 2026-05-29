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
import { EditorContent, JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PermissionLevelValue, ThreadStatusValue } from "@/lib/contracts";

import { AgentPanel } from "./document-workspace/agent-panel";
import { ToolbarButton, insertImagesAtPosition } from "./document-workspace/atoms";
import { buildAiEditInsertContent, normalizeWidgetsOutsideTables } from "./document-workspace/ai-edit-insert";
import {
  AiEditSelections,
  cleanupStaleAiEditRangeMarks,
  describeAiEditSelectionPresence,
  getAiEditSelectionRange,
  removeAiEditSelection,
  syncAiEditSelectionRuns,
  upsertAiEditSelection
} from "./document-workspace/ai-edit-selections";
import { CommentRail } from "./document-workspace/comment-rail";
import { DocOutline, OUTLINE_MAX_WIDTH, OUTLINE_MIN_WIDTH } from "./document-workspace/doc-outline";
import { MoveBlock, SlashTab, StrikeShortcut, TaskItem } from "./document-workspace/editor-extras";
import { FileMenu } from "./document-workspace/file-menu";
import { SelectionPopover } from "./document-workspace/selection-popover";
import { LinkPopover } from "./document-workspace/link-popover";
import { HeadingCopyOverlay } from "./document-workspace/heading-copy-overlay";
import { CommentAnchor, createCommentHighlightExtension, resolveCommentAnchorRange } from "./document-workspace/comment-anchors";
import {
  createCollaborationExtension,
  createRemotePresenceExtension,
  type CollaborationStepResponse,
  type ReceivedMappingEntry,
  type RemotePresenceView
} from "./document-workspace/collaboration";
import { useCollaborationStream } from "./document-workspace/use-collaboration-stream";
import { usePresence } from "./document-workspace/use-presence";
import { FindBar } from "./document-workspace/find-bar";
import { SearchExtension } from "./document-workspace/search";
import { buildConversations } from "./document-workspace/conversations";
import { createLatexRenderExtension } from "./document-workspace/latex";
import { EmbeddedWidget, RepoImage, TabBreak } from "./document-workspace/nodes";
import {
  createTabId,
  createTabsVisibilityExtension,
  ensureTabsHaveContent,
  listTabs,
  normalizePreludeTab,
  setActiveTab,
  type TabSummary
} from "./document-workspace/tabs";
import { commentThreadIdsAttributeSpec } from "@/lib/document-schema-nodes";

const Image = ImageExtension.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...commentThreadIdsAttributeSpec
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
  initialThreads,
  initialShareLinks,
  initialRepoUrl,
  initialRepoBranch,
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
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoNotice, setRepoNotice] = useState<string | null>(null);
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
  const aiEditRunStateRef = useRef<Map<string, "applying" | "applied" | "failed">>(new Map());
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
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);
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
  const remotePresenceRef = useRef<RemotePresenceView[]>([]);
  const receivedMappingsRef = useRef<ReceivedMappingEntry[]>([]);
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
  const canWriteComments = isAuthenticated && initialPermission !== "VIEW";
  const canWriteDocument = initialPermission === "EDIT";

  const commentHighlightExtension = useMemo(
    () =>
      createCommentHighlightExtension(threadsRef, activeThreadIdRef, (threadId) => {
        setActiveThreadId(threadId);
        setSelectionPopoverMode(null);
      }),
    []
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
      window.requestAnimationFrame(() => {
        isApplyingRemoteUpdateRef.current = false;
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

    // Attach any one-shot AI-edit version metadata to this push. Kept until the
    // push is accepted (a 409 rebase + re-flush must still carry it).
    const versionMeta = pendingCollabVersionMetaRef.current;

    try {
      const response = await fetch(`/api/documents/${documentId}/collaboration`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          version: sendable.version,
          steps: sendable.steps.map((step) => step.toJSON()),
          clientId: collabClientIdRef.current,
          shareToken,
          ...(versionMeta ? { versionMeta } : {})
        })
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
            sentStepCount: sendable.steps.length,
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
        }

        // A 422 means the server could not apply our steps at all (corrupt step
        // or client/server schema mismatch). Retrying sends the same bad steps
        // and fails identically, so do NOT queue a re-flush — surface a refresh
        // prompt and stop. (Distinct from 409, which IS retryable.)
        if (response.status === 422) {
          collaborationPushQueuedRef.current = false;
          setRemoteNotice("Live collaboration lost sync. Refresh this document to reconnect.");
          setSaveState("error");
          return;
        }

        setSaveState("error");
        void pullCollaborationSteps();
        return;
      }

      // Push accepted — the version metadata (if any) was consumed by this
      // commit, so don't re-attach it to subsequent pushes.
      if (versionMeta && pendingCollabVersionMetaRef.current === versionMeta) {
        pendingCollabVersionMetaRef.current = null;
      }

      if (!applyCollaborationPayload(data)) {
        setSaveState("error");
        return;
      }

      setSaveState(response.ok && !sendableSteps(editor.state) ? "saved" : "saving");
    } catch {
      setSaveState("error");
    } finally {
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
    if (!editor || collaborationPullBusyRef.current) {
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
        applyCollaborationPayload(data);
      }
    } finally {
      collaborationPullBusyRef.current = false;
    }
  }


  function normalizeCurrentEditorWidgets() {
    if (!editor) {
      return null;
    }

    const normalized = normalizeWidgetsOutsideTables(editor.getJSON());
    if (normalized.changed) {
      isApplyingRemoteUpdateRef.current = true;
      editor.commands.setContent(normalized.content, false);
      window.requestAnimationFrame(() => {
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
      collaborationExtension,
      remotePresenceExtension,
      AiEditSelections,
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
      TabBreak,
      tabsVisibilityExtension
    ],
    immediatelyRender: false,
    editable: canWriteDocument,
    content: initialContent as JSONContent,
    editorProps: {
      attributes: {
        class: "gdocs-prosemirror"
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
      setTableControlsActive(editor.isActive("table"));
      const { selection } = editor.state;
      const { from, to } = selection;
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
      if (!canWriteDocument || isApplyingRemoteUpdateRef.current) {
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
    }
  });

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
    collabClientIdRef,
    lastSseAtRef,
    applyCollaborationPayload,
    pullCollaborationSteps,
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
    setRepoNotice(data.repository.repoUrl ? "Repository linked" : "Repository link removed");
    setRepoBusy(false);
  }

  async function handleInsertWidget() {
    if (!editor || !canWriteDocument) {
      return;
    }

    setGlobalError(null);
    setWidgetDialogOpen(true);
  }

  async function handleCreateWidget() {
    if (!editor || !canWriteDocument || widgetBusy) {
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

    const src = `/api/documents/${documentId}/widgets/${data.widget.id}/source${
      shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""
    }`;
    editor
      .chain()
      .focus()
      .insertContent({
        type: "embeddedWidget",
        attrs: {
          widgetId: data.widget.id,
          documentId,
          shareToken,
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

  async function handleCreateComment() {
    if (!selection || !composerBody.trim() || !editor) {
      return;
    }

    setCommentBusy(true);
    setGlobalError(null);

    const selectedRange = selection;
    const threadId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const previousContent = editor.getJSON();

    const editorSelectionBeforeAnchor = editor.state.selection;
    const blockAnchorNode =
      editorSelectionBeforeAnchor instanceof NodeSelection &&
      ["embeddedWidget", "repoImage", "image"].includes(
        editorSelectionBeforeAnchor.node.type?.name ?? ""
      )
        ? editorSelectionBeforeAnchor.node
        : null;
    const blockAnchorPos = blockAnchorNode ? editorSelectionBeforeAnchor.from : null;

    let marked: boolean;
    if (blockAnchorNode && blockAnchorPos !== null) {
      const existingIds = Array.isArray(blockAnchorNode.attrs?.commentThreadIds)
        ? (blockAnchorNode.attrs.commentThreadIds as string[])
        : [];
      const nextIds = existingIds.includes(threadId) ? existingIds : [...existingIds, threadId];
      marked = editor
        .chain()
        .command(({ tr }) => {
          tr.setNodeAttribute(blockAnchorPos, "commentThreadIds", nextIds);
          return true;
        })
        .run();
    } else {
      marked = editor
        .chain()
        .setTextSelection({ from: selectedRange.from, to: selectedRange.to })
        .setMark("commentAnchor", { threadId })
        .setTextSelection({ from: selectedRange.to, to: selectedRange.to })
        .run();
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

    await flushCollaborationSteps();

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
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.thread) {
      isApplyingRemoteUpdateRef.current = true;
      editor.commands.setContent(previousContent, false);
      isApplyingRemoteUpdateRef.current = false;
      reportClientError(data?.error ?? "Unable to create thread.", "comment-create", {
        documentId,
        threadId,
        status: response.status,
        serverError: typeof data?.error === "string" ? data.error : null
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
    const replacementRange = getAiEditSelectionRange(editor.state, selectionId);
    if (!replacementRange) {
      logClientEvent({
        scope: "ai-edit-marker-lost",
        level: "error",
        message: "marker not in editor when applying ai run",
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
      // Claim the run so we don't loop on it; the user already lost the anchor.
      await fetch(`/api/documents/${documentId}/ai-runs/${aiRunId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "markApplied", shareToken })
      }).catch(() => null);
      setActiveAiRun(null);
      setActiveAiTarget(null);
      reportClientError(
        "The edited range was deleted before the AI run finished. Replacement skipped.",
        "ai-edit-marker-lost",
        { documentId, selectionId, aiRunId }
      );
      return;
    }

    const docSizeBefore = editor.state.doc.content.size;
    let docSizeAfter = docSizeBefore;
    let insertedContent: ReturnType<typeof buildAiEditInsertContent> | null = null;
    let contentToSave: JSONContent | null = null;

    try {
      insertedContent = buildAiEditInsertContent({
        replacementText,
        sourceLinks: sources,
        images,
        widgets,
        documentId,
        shareToken
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
      contentToSave = editor.getJSON();
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

    // Force node-view remount so freshly inserted widgets/tables render
    // cleanly. Without this, iframes and tables sometimes paint in a
    // half-initialized state until the user refreshes the page.
    if (contentToSave) {
      isApplyingRemoteUpdateRef.current = true;
      editor.commands.setContent(contentToSave, false);
      window.requestAnimationFrame(() => {
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

  async function handleReply(threadId: string) {
    const draft = getReplyDraft(threadId).trim();
    if (!draft) {
      return;
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
        shareToken
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
      return;
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
  }

  async function handleAskAi(threadId: string) {
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

  async function handleAgentConversation(options?: { previousRunId?: string | null; rootId?: string | null }) {
    const message = agentMessage.trim();
    if (!message) {
      return;
    }

    const previousRunId = options?.previousRunId ?? null;
    const followUpRootId = options?.rootId ?? previousRunId ?? null;

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

        // When the doc has tabs, hide threads whose anchor falls outside the active tab.
        if (editor && tabs.length > 0 && activeTabId) {
          const activeTab = tabs.find((tab) => tab.id === activeTabId);
          if (activeTab) {
            const range = resolveCommentAnchorRange(editor.state.doc, thread);
            if (!range) return false;
            const anchorPos = range.fromPos;
            if (anchorPos < activeTab.contentFrom || anchorPos > activeTab.contentTo) {
              return false;
            }
          }
        }
        return true;
      }),
    [availableCommentTags, commentTagFilters, threads, editor, tabs, activeTabId]
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

    for (const run of activeAiRuns) {
      if (run.status !== "RUNNING" || run.triggerType !== "SELECTION_EDIT") continue;
      const selectionId = run.selectionId ?? parseAiRunSelectionId(run.triggerId);
      if (!selectionId) continue;
      selectionRuns.push({ run, selectionId });
    }

    editor.view.dispatch(syncAiEditSelectionRuns(editor.state, selectionRuns));
  }, [activeAiRuns, editor]);

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
        if (!isStaleFromPreviousSession) {
          reportClientError(run.error ?? "AI edit failed.", "ai-edit-run-failed", {
            documentId,
            selectionId,
            aiRunId: run.id
          });
          notifyAgentCompleted({
            id: run.id,
            triggerType: "SELECTION_EDIT",
            instruction: run.instruction,
            status: "FAILED"
          });
        }
        editor.view.dispatch(removeAiEditSelection(editor.state, selectionId));
        setActiveAiRun(null);
        continue;
      }

      if (run.status !== "SUCCEEDED") continue;
      if (run.appliedAt) {
        aiEditRunStateRef.current.set(run.id, "applied");
        continue;
      }

      aiEditRunStateRef.current.set(run.id, "applying");
      void (async () => {
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
        if (typeof fetched.replacementText !== "string" || !fetched.replacementText) {
          // Legacy run that completed before the replacement column existed, or
          // any other "succeeded with no payload" state. Claim it so we stop
          // re-fetching it every 2s.
          logClientEvent({
            scope: "ai-edit-fetch-result",
            level: "warn",
            message: "succeeded run has no replacementText; claiming to stop retry",
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
        await applyAiEditRun({
          aiRunId: run.id,
          selectionId,
          instruction: run.instruction,
          replacementText: fetched.replacementText,
          images: Array.isArray(fetched.images) ? (fetched.images as AiEditImage[]) : [],
          widgets: Array.isArray(fetched.widgets) ? (fetched.widgets as AiEditWidget[]) : [],
          sources: Array.isArray(fetched.sources) ? (fetched.sources as string[]) : [],
          commitSha: typeof fetched.commitSha === "string" ? fetched.commitSha : null,
          commitUrl: typeof fetched.commitUrl === "string" ? fetched.commitUrl : null
        });
        aiEditRunStateRef.current.set(run.id, "applied");
      })();
    }
  }, [aiRuns, editor, documentId, shareToken]);

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
    if (!editor || aiEditMarkCleanupDoneRef.current) return;
    aiEditMarkCleanupDoneRef.current = true;

    const activeSelectionIds = new Set<string>();
    for (const run of activeAiRuns) {
      if (run.status !== "RUNNING" || run.triggerType !== "SELECTION_EDIT") continue;
      const selectionId = parseAiRunSelectionId(run.triggerId);
      if (selectionId) activeSelectionIds.add(selectionId);
    }

    const cleanupTr = cleanupStaleAiEditRangeMarks(editor.state, activeSelectionIds);
    if (cleanupTr) editor.view.dispatch(cleanupTr);
  }, [activeAiRuns, editor]);

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

          <a
            className="ghost-button header-toggle-button"
            href={`/api/documents/${documentId}/export${
              shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""
            }`}
            download
          >
            Export
          </a>

          <FileMenu currentDocumentId={documentId} onOpenVersionHistory={() => setHistoryOpen(true)} />

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
                  disabled={!canWriteDocument || !editor}
                  label="Widget"
                  onClick={handleInsertWidget}
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

          <details className="header-menu header-menu-wide">
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
            </div>
          </details>

          <div className="document-topbar-actions">
            {remoteNotice ? <span className="subtle-pill">{remoteNotice}</span> : null}
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
          <div className="editor-page" ref={editorPageRef}>
            {selection && selectionPopoverMode && (canWriteComments || canWriteDocument) ? (
              <SelectionPopover
                selection={selection}
                mode={selectionPopoverMode}
                canWriteComments={canWriteComments}
                canWriteDocument={canWriteDocument}
                composerBody={composerBody}
                commentBusy={commentBusy}
                editInstruction={editInstruction}
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

            <EditorContent editor={editor} />
            <LinkPopover editor={editor} containerRef={editorPageRef} canEdit={canWriteDocument} />
            <HeadingCopyOverlay editor={editor} containerRef={editorPageRef} />
            <TableInlineControls
              editor={editor}
              containerRef={editorPageRef}
              enabled={canWriteDocument}
            />
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
        />
        )}
      </div>
      </>
      )}

      {agentPanelOpen ? (
        <AgentPanel
          title={title}
          activeAiRuns={activeAiRuns}
          conversations={conversations}
          selectedConversation={selectedConversation}
          composeMode={composeMode}
          agentMessage={agentMessage}
          agentBusy={agentBusy}
          canWriteComments={canWriteComments}
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
    </section>
  );
}
