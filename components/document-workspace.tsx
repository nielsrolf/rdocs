"use client";

import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Underline from "@tiptap/extension-underline";
import { getVersion, receiveTransaction, sendableSteps } from "@tiptap/pm/collab";
import { NodeSelection } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import { EditorContent, JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";

import type { PermissionLevelValue, ThreadStatusValue } from "@/lib/contracts";
import { permissionLabel } from "@/lib/utils";

import { AgentPanel } from "./document-workspace/agent-panel";
import { ToolbarButton, insertImagesAtPosition } from "./document-workspace/atoms";
import { buildAiEditInsertContent, normalizeWidgetsOutsideTables } from "./document-workspace/ai-edit-insert";
import {
  AiEditSelections,
  getAiEditSelectionRange,
  removeAiEditSelection,
  syncAiEditSelectionRuns,
  upsertAiEditSelection
} from "./document-workspace/ai-edit-selections";
import { CommentRail } from "./document-workspace/comment-rail";
import { DocOutline, OUTLINE_MAX_WIDTH, OUTLINE_MIN_WIDTH } from "./document-workspace/doc-outline";
import { SelectionPopover } from "./document-workspace/selection-popover";
import { CommentAnchor, createCommentHighlightExtension, resolveCommentAnchorRange } from "./document-workspace/comment-anchors";
import {
  createCollaborationExtension,
  createRemotePresenceExtension,
  type RemotePresenceView
} from "./document-workspace/collaboration";
import { buildConversations } from "./document-workspace/conversations";
import { createLatexRenderExtension } from "./document-workspace/latex";
import { EmbeddedWidget, RepoImage } from "./document-workspace/nodes";
import { ShareModal } from "./document-workspace/share-modal";
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
  getAiRunProgressLabel,
  getSelectionContext,
  getSelectionContextFromEditor,
  getSelectionMarkdownFromEditor,
  getThreadTags,
  parseAiRunSelectionRange
} from "./document-workspace/utils";

type CollaborationStepResponse = {
  accepted?: boolean;
  steps?: unknown[];
  clientIds?: Array<string | number>;
  fromVersion?: number;
  version?: number;
  updatedAt?: string | null;
};

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
  const [globalError, setGlobalError] = useState<string | null>(null);
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<VersionView[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
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
  const [tableControlsActive, setTableControlsActive] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const collaborationFlushTimerRef = useRef<number | null>(null);
  const collaborationPushBusyRef = useRef(false);
  const collaborationPushQueuedRef = useRef(false);
  const collaborationPullBusyRef = useRef(false);
  const presenceTimerRef = useRef<number | null>(null);
  const typingClearTimerRef = useRef<number | null>(null);
  const isApplyingRemoteUpdateRef = useRef(false);
  const hasUnsavedChangesRef = useRef(false);
  const pendingVersionSourcesRef = useRef<string[]>([]);
  const pendingCommitRef = useRef<{ commitSha: string | null; commitUrl: string | null; aiRunId: string | null }>({
    commitSha: null,
    commitUrl: null,
    aiRunId: null
  });
  const forceVersionRef = useRef(false);
  const titleRef = useRef(initialTitle);
  const documentUpdatedAtRef = useRef(initialDocumentUpdatedAt);
  const replyDraftsRef = useRef<Record<string, string>>({});
  const [replyDraftTick, setReplyDraftTick] = useState(0);
  const editorPageRef = useRef<HTMLDivElement | null>(null);
  const threadsRef = useRef<HighlightThread[]>(initialThreads);
  const activeThreadIdRef = useRef<string | null>(initialThreads[0]?.id ?? null);
  const previousAiRunsRef = useRef<Record<string, string>>({});
  const remotePresenceRef = useRef<RemotePresenceView[]>([]);
  const collabClientIdRef = useRef(createCollaborationClientId());
  const collabColorRef = useRef(createPresenceColor(collabClientIdRef.current));
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
    () => createRemotePresenceExtension(remotePresenceRef),
    []
  );

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("gdocs-ai:outline-collapsed");
      if (stored === "true") {
        setOutlineCollapsed(true);
      }
      const storedWidth = window.localStorage.getItem("gdocs-ai:outline-width");
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
        "gdocs-ai:outline-collapsed",
        outlineCollapsed ? "true" : "false"
      );
    } catch {
      // Ignore quota / privacy errors.
    }
  }, [outlineCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem("gdocs-ai:outline-width", String(Math.round(outlineWidth)));
    } catch {
      // Ignore quota / privacy errors.
    }
  }, [outlineWidth]);

  useEffect(() => {
    documentUpdatedAtRef.current = documentUpdatedAt;
  }, [documentUpdatedAt]);

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
      editor.view.dispatch(
        receiveTransaction(editor.state, steps, clientIds, {
          mapSelectionBackward: true
        })
      );
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
          shareToken
        })
      });
      const data = (await response.json().catch(() => null)) as CollaborationStepResponse | null;

      if (!data || !Array.isArray(data.steps) || !Array.isArray(data.clientIds)) {
        setSaveState("error");
        return;
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

    if (collaborationPushQueuedRef.current || sendableSteps(editor.state)) {
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

  function getPresenceSelection() {
    if (!editor) {
      return null;
    }

    const { anchor, head, from, to } = editor.state.selection;
    return { anchor, head, from, to };
  }

  function sendPresence(typing: boolean, immediate = false) {
    if (!editor) {
      return;
    }

    const payload = {
      clientId: collabClientIdRef.current,
      userName: currentUserName || "Guest",
      color: collabColorRef.current,
      selection: getPresenceSelection(),
      typing,
      shareToken
    };

    const postPresence = () => {
      void fetch(`/api/documents/${documentId}/collaboration/presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }).catch(() => undefined);
    };

    if (immediate) {
      if (presenceTimerRef.current) {
        window.clearTimeout(presenceTimerRef.current);
        presenceTimerRef.current = null;
      }
      postPresence();
      return;
    }

    if (presenceTimerRef.current) {
      return;
    }

    presenceTimerRef.current = window.setTimeout(() => {
      presenceTimerRef.current = null;
      postPresence();
    }, 120);
  }

  async function saveDocument(
    nextContent: JSONContent,
    metadata?: {
      sourceLinks?: string[];
      commitSha?: string | null;
      commitUrl?: string | null;
      aiRunId?: string | null;
      forceVersion?: boolean;
    }
  ) {
    const normalizedContent = normalizeWidgetsOutsideTables(nextContent).content;
    const response = await fetch(`/api/documents/${documentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: titleRef.current,
        content: normalizedContent,
        shareToken,
        forceVersion: metadata?.forceVersion ?? forceVersionRef.current,
        sourceLinks: metadata?.sourceLinks ?? pendingVersionSourcesRef.current,
        commitSha: metadata?.commitSha ?? pendingCommitRef.current.commitSha,
        commitUrl: metadata?.commitUrl ?? pendingCommitRef.current.commitUrl,
        aiRunId: metadata?.aiRunId ?? pendingCommitRef.current.aiRunId
      })
    });

    const data = await response.json().catch(() => null);
    const saved = response.ok && typeof data?.updatedAt === "string";

    if (saved) {
      hasUnsavedChangesRef.current = false;
      forceVersionRef.current = false;
      pendingVersionSourcesRef.current = [];
      pendingCommitRef.current = { commitSha: null, commitUrl: null, aiRunId: null };
      setDocumentUpdatedAt(data.updatedAt);
      setRemoteNotice(null);
      if (historyOpen) {
        void loadVersionHistory();
      }
    }

    setSaveState(saved ? "saved" : "error");
    return saved;
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

      if (visibleRun.triggerType === "SELECTION_EDIT") {
        const range = parseAiRunSelectionRange(visibleRun.triggerId);
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
      setGlobalError(data?.error ?? "Unable to load version history.");
      setHistoryLoading(false);
      return;
    }

    setHistoryVersions(data.versions);
    setSelectedVersionId(data.versions[0]?.id ?? null);
    setHistoryLoaded(true);
    setHistoryLoading(false);
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
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
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https"
      }),
      Table.configure({
        resizable: false
      }),
      TableRow,
      TableHeader,
      TableCell,
      RepoImage,
      EmbeddedWidget
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

  useEffect(() => {
    if (!editor) {
      return;
    }

    const shareQuery = shareToken ? `&share=${encodeURIComponent(shareToken)}` : "";
    const stream = new EventSource(
      `/api/documents/${documentId}/collaboration/stream?clientId=${encodeURIComponent(
        collabClientIdRef.current
      )}${shareQuery}`
    );

    stream.addEventListener("steps", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as CollaborationStepResponse;
      applyCollaborationPayload(payload);
    });

    const handlePresence = (event: Event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { presence?: RemotePresenceView[] };
      const nextPresence = Array.isArray(payload.presence) ? payload.presence : [];
      setRemotePresence(nextPresence.filter((presence) => presence.clientId !== collabClientIdRef.current));
    };

    stream.addEventListener("presence", handlePresence);
    stream.addEventListener("ready", handlePresence);
    stream.onerror = () => {
      setRemoteNotice("Reconnecting live collaboration...");
    };
    sendPresence(false, true);
    const stepPull = window.setInterval(() => {
      void pullCollaborationSteps();
    }, 500);
    const presencePoll = window.setInterval(async () => {
      const presenceShareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
      const response = await fetch(
        `/api/documents/${documentId}/collaboration/presence${presenceShareQuery}`,
        { cache: "no-store" }
      ).catch(() => null);
      const data = await response?.json().catch(() => null);
      const nextPresence: RemotePresenceView[] = Array.isArray(data?.presence) ? data.presence : [];
      setRemotePresence(nextPresence.filter((presence) => presence.clientId !== collabClientIdRef.current));
    }, 500);

    return () => {
      window.clearInterval(stepPull);
      window.clearInterval(presencePoll);
      stream.close();
      void fetch(`/api/documents/${documentId}/collaboration/presence`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          clientId: collabClientIdRef.current,
          shareToken
        })
      }).catch(() => undefined);
    };
  }, [documentId, editor, shareToken]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      updateThreadOffsets();
    });
  }, [editor, threads, activeThreadId]);

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
      if (presenceTimerRef.current) {
        window.clearTimeout(presenceTimerRef.current);
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
      setGlobalError(data?.error ?? "Unable to save repository settings.");
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
      setGlobalError("Widget config needs build command and embed source.");
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
      setGlobalError(data?.error ?? "Unable to create widget.");
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

    const marked = editor
      .chain()
      .setTextSelection({ from: selectedRange.from, to: selectedRange.to })
      .setMark("commentAnchor", { threadId })
      .setTextSelection({ from: selectedRange.to, to: selectedRange.to })
      .run();

    if (!marked) {
      setGlobalError("Unable to anchor the comment to the selected text.");
      setCommentBusy(false);
      return;
    }

    await flushCollaborationSteps();
    const nextContent = editor.getJSON();

    const response = await fetch(`/api/documents/${documentId}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        threadId,
        body: composerBody.trim(),
        anchorText: selectedRange.text,
        anchorContext: selectedRange.context,
        fromPos: selectedRange.from,
        toPos: selectedRange.to,
        content: nextContent,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.thread) {
      isApplyingRemoteUpdateRef.current = true;
      editor.commands.setContent(previousContent, false);
      isApplyingRemoteUpdateRef.current = false;
      setGlobalError(data?.error ?? "Unable to create thread.");
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
    const triggerId = buildAiRunSelectionTriggerId(selectionId, editSelection.from, editSelection.to);
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
      instruction,
      status: "RUNNING",
      progress: "Starting Claude research agent.",
      startedAt: new Date().toISOString()
    });
    setSelectionPopoverMode(null);
    setSelection(null);
    setEditInstruction("");

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
        fromPos: editSelection.from,
        toPos: editSelection.to,
        shareToken
      })
    }).catch(() => null);

    const data = await response?.json().catch(() => null);

    if (!response?.ok || !data?.replacementText) {
      setGlobalError(data?.error ?? "AI edit failed.");
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

    const sourceLinks = Array.isArray(data.visitedSources) ? data.visitedSources : [];
    const aiImages: AiEditImage[] = Array.isArray(data.images) ? data.images : [];
    const aiWidgets: AiEditWidget[] = Array.isArray(data.widgets) ? data.widgets : [];
    const commitSha = typeof data.commitSha === "string" ? data.commitSha : null;
    const commitUrl = typeof data.commitUrl === "string" ? data.commitUrl : null;
    const aiRunId = typeof data.aiRunId === "string" ? data.aiRunId : null;

    const replacementRange = getAiEditSelectionRange(editor.state, selectionId) ?? {
      from: editSelection.from,
      to: editSelection.to
    };

    editor
      .chain()
      .focus()
      .insertContentAt(
        replacementRange,
        buildAiEditInsertContent({
          replacementText: data.replacementText,
          sourceLinks,
          images: aiImages,
          widgets: aiWidgets,
          documentId,
          shareToken
        })
      )
      .run();
    editor.view.dispatch(removeAiEditSelection(editor.state, selectionId));
    normalizeCurrentEditorWidgets();
    hasUnsavedChangesRef.current = true;
    setSaveState("saving");
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await flushCollaborationSteps();
    const contentToSave = editor.getJSON();
    await saveDocument(contentToSave, {
      sourceLinks,
      commitSha,
      commitUrl,
      aiRunId,
      forceVersion: true
    });

    setActiveAiRun(null);
    setActiveAiTarget(null);
    notifyAgentCompleted({
      id: aiRunId ?? `finished-selection-edit-${Date.now()}`,
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
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.comment) {
      setGlobalError(data?.error ?? "Unable to send reply.");
      setReplyBusyThreadId(null);
      return;
    }

    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
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

    if (!response.ok || !data?.comment) {
      setGlobalError(data?.error ?? "AI reply failed.");
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

    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              comments: [...thread.comments, data.comment]
            }
          : thread
      )
    );
    setActiveAiRun(null);
    setActiveAiTarget(null);
    setAiBusyThreadId(null);
    notifyAgentCompleted({
      id: data.comment.aiRunId ?? `finished-comment-reply-${Date.now()}`,
      triggerType: "COMMENT_THREAD",
      triggerId: threadId,
      instruction: "Write the next assistant reply for this comment thread."
    });
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
        shareToken
      })
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.thread) {
      setGlobalError(data?.error ?? "Unable to update comment tags.");
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
      setGlobalError(data?.error ?? "Agent message failed.");
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
    setAgentBusy(false);
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
      setGlobalError(data?.error ?? "Unable to create share link.");
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
      setGlobalError("Unable to revoke share link.");
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
      setGlobalError(data?.error ?? "Unable to add collaborator.");
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

  function focusThread(thread: ThreadView) {
    setActiveThreadId(thread.id);
    setSelectionPopoverMode(null);

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
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.deletedCommentId) {
      setGlobalError(data?.error ?? "Unable to delete comment.");
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
        return true;
      }),
    [availableCommentTags, commentTagFilters, threads]
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

    const selectionRuns: Array<{
      run: ActiveAiRunView;
      markerId: string;
      from: number;
      to: number;
    }> = [];

    for (const run of activeAiRuns) {
      if (run.status !== "RUNNING" || run.triggerType !== "SELECTION_EDIT") continue;
      const range = parseAiRunSelectionRange(run.triggerId);
      if (!range) continue;
      selectionRuns.push({
        run,
        markerId: range.id ?? `run-${run.id}`,
        from: range.from,
        to: range.to
      });
    }

    editor.view.dispatch(syncAiEditSelectionRuns(editor.state, selectionRuns));
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
      {globalError ? <div className="error-banner">{globalError}</div> : null}

      {agentPanelOpen ? null : (
      <>
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
            <span className="save-indicator">
              {saveState === "saving"
                ? "Saving..."
                : saveState === "saved"
                  ? "Saved"
                  : saveState === "error"
                    ? "Save failed"
                    : "Ready"}
            </span>
          </div>

          <details className="header-menu">
            <summary>Format</summary>
            <div className="header-menu-panel editor-toolbar" role="toolbar" aria-label="Document formatting">
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
          </details>

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
                    ? `${repoUrl}${repoBranch ? ` on ${repoBranch}` : ""}`
                    : "Link a GitHub repo to give the AI a checked-out workspace."}
                </p>
              </div>
              {canWriteDocument ? (
                <div className="research-repo-controls">
                  <input
                    aria-label="GitHub repository URL"
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/org/repo"
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
            <details className="header-menu header-menu-right">
              <summary>More</summary>
              <div className="header-menu-panel header-actions-panel">
                <div className="presence-chip">
                  {isAuthenticated ? `Signed in as ${currentUserName}` : "Browsing via share link"}
                </div>
                <div className="document-menu-status">
                  <span className="permission-pill">{permissionLabel(initialPermission)}</span>
                  {viaShareLink ? <span className="subtle-pill">Link access</span> : null}
                  {remoteNotice ? <span className="subtle-pill">{remoteNotice}</span> : null}
                </div>
                <button
                  className="ghost-button"
                  onClick={() => setHistoryOpen(true)}
                  type="button"
                >
                  Version history
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>

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

      {activeAiRuns.length > 1 ? (
        <div className="agent-progress-banner">
          <div>
            <strong>{activeAiRuns.length} agents running</strong>
            <p>{activeAiRuns.map((run) => getAiRunProgressLabel(run)).join(" · ")}</p>
          </div>
          <button className="ghost-button" onClick={() => setAgentPanelOpen(true)} type="button">
            Open agent view
          </button>
        </div>
      ) : null}

      <div
        className="editor-stage"
        data-outline-collapsed={outlineCollapsed ? "true" : "false"}
        style={{ "--outline-width": `${outlineCollapsed ? 36 : Math.round(outlineWidth)}px` } as React.CSSProperties}
      >
        <DocOutline
          editor={editor}
          collapsed={outlineCollapsed}
          width={outlineWidth}
          onToggleCollapsed={() => setOutlineCollapsed((value) => !value)}
          onWidthChange={setOutlineWidth}
        />
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
          </div>
        </div>

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
        />
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
          onClose={() => setHistoryOpen(false)}
          onSelectVersion={setSelectedVersionId}
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
