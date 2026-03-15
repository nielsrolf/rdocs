"use client";

import { Extension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Underline from "@tiptap/extension-underline";
import { Fragment } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { MutableRefObject, useEffect, useMemo, useRef, useState } from "react";

import { PermissionLevelValue, ThreadStatusValue, permissionLevels } from "@/lib/contracts";
import { permissionLabel, truncate } from "@/lib/utils";

type CommentView = {
  id: string;
  body: string;
  aiModel: string | null;
  createdAt: string | Date;
  author: {
    id: string;
    name: string;
  } | null;
};

type ThreadView = {
  id: string;
  anchorText: string;
  anchorContext: string | null;
  fromPos: number | null;
  toPos: number | null;
  status: ThreadStatusValue;
  createdAt: string | Date;
  createdBy: {
    id: string;
    name: string;
  };
  comments: CommentView[];
};

type ShareLinkView = {
  id: string;
  token: string;
  permission: PermissionLevelValue;
  createdAt: string | Date;
};

type MemberView = {
  id: string;
  permission: PermissionLevelValue;
  user: {
    id: string;
    name: string;
    email: string;
  };
};

type DocumentWorkspaceProps = {
  currentUserId: string | null;
  currentUserName: string;
  documentId: string;
  initialTitle: string;
  initialContent: unknown;
  initialPermission: PermissionLevelValue;
  initialMembers: MemberView[];
  initialThreads: ThreadView[];
  initialShareLinks: ShareLinkView[];
  isAuthenticated: boolean;
  isOwner: boolean;
  shareToken: string | null;
  viaShareLink: boolean;
};

type SelectionState = {
  text: string;
  from: number;
  to: number;
  context: string;
  bubbleTop: number;
  bubbleLeft: number;
};

type SelectionPopoverMode = "menu" | "comment" | "edit";

type HighlightThread = {
  id: string;
  fromPos: number | null;
  toPos: number | null;
};

type ToolbarButtonProps = {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
};

function getSelectionContext(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function getSelectionContextFromEditor(editor: NonNullable<ReturnType<typeof useEditor>>, from: number, to: number) {
  const start = Math.max(0, from - 500);
  const end = Math.min(editor.state.doc.content.size, to + 500);
  return editor.state.doc.textBetween(start, end, " ").replace(/\s+/g, " ").trim();
}

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatTime(value: string | Date) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function ToolbarButton({ active = false, disabled = false, label, onClick }: ToolbarButtonProps) {
  return (
    <button
      className={`editor-toolbar-button ${active ? "editor-toolbar-button-active" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Image read failed."));
    };
    reader.onerror = () => reject(new Error("Image read failed."));
    reader.readAsDataURL(file);
  });
}

async function insertImagesAtPosition(
  view: NonNullable<NonNullable<ReturnType<typeof useEditor>>["view"]>,
  files: File[],
  dropCoordinates?: { left: number; top: number }
) {
  const imageFiles = files.filter((file) => file.type.startsWith("image/"));
  if (imageFiles.length === 0) {
    return false;
  }

  const imageType = view.state.schema.nodes.image;
  if (!imageType) {
    return false;
  }

  const paragraphType = view.state.schema.nodes.paragraph;
  const targetPosition =
    dropCoordinates != null ? view.posAtCoords(dropCoordinates)?.pos ?? view.state.selection.from : view.state.selection.from;

  const dataUrls = await Promise.all(imageFiles.map((file) => readFileAsDataUrl(file)));
  const nodes = dataUrls.flatMap((src, index) => {
    const imageNode = imageType.create({
      src,
      alt: imageFiles[index]?.name || "Pasted image"
    });

    return paragraphType ? [imageNode, paragraphType.create()] : [imageNode];
  });

  const transaction = view.state.tr.insert(targetPosition, Fragment.fromArray(nodes));
  view.dispatch(transaction.scrollIntoView());
  view.focus();
  return true;
}

function createCommentHighlightExtension(
  threadsRef: MutableRefObject<HighlightThread[]>,
  activeThreadIdRef: MutableRefObject<string | null>,
  onActivateThread: (threadId: string | null) => void
) {
  return Extension.create({
    name: "commentHighlight",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("commentHighlight"),
          props: {
            decorations(state) {
              const decorations = threadsRef.current.flatMap((thread) => {
                if (
                  thread.fromPos == null ||
                  thread.toPos == null ||
                  thread.fromPos >= thread.toPos ||
                  thread.toPos > state.doc.content.size
                ) {
                  return [];
                }

                const isActive = thread.id === activeThreadIdRef.current;
                return [
                  Decoration.inline(thread.fromPos, thread.toPos, {
                    class: isActive
                      ? "comment-anchor-highlight comment-anchor-highlight-active"
                      : "comment-anchor-highlight"
                  })
                ];
              });

              return DecorationSet.create(state.doc, decorations);
            },
            handleClick(_view, pos) {
              const thread = threadsRef.current.find(
                (candidate) =>
                  candidate.fromPos != null &&
                  candidate.toPos != null &&
                  pos >= candidate.fromPos &&
                  pos <= candidate.toPos
              );

              onActivateThread(thread?.id ?? null);
              return false;
            }
          }
        })
      ];
    }
  });
}

export function DocumentWorkspace({
  currentUserId,
  currentUserName,
  documentId,
  initialTitle,
  initialContent,
  initialPermission,
  initialMembers,
  initialThreads,
  initialShareLinks,
  isAuthenticated,
  isOwner,
  shareToken,
  viaShareLink
}: DocumentWorkspaceProps) {
  const [title, setTitle] = useState(initialTitle);
  const [members, setMembers] = useState<MemberView[]>(initialMembers);
  const [threads, setThreads] = useState<ThreadView[]>(initialThreads);
  const [shareLinks, setShareLinks] = useState<ShareLinkView[]>(initialShareLinks);
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
  const [editBusy, setEditBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePermission, setInvitePermission] = useState<PermissionLevelValue>("COMMENT");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [deleteBusyCommentId, setDeleteBusyCommentId] = useState<string | null>(null);
  const [threadOffsets, setThreadOffsets] = useState<Record<string, number>>({});
  const [railHeight, setRailHeight] = useState(640);
  const saveTimerRef = useRef<number | null>(null);
  const titleRef = useRef(initialTitle);
  const replyDraftsRef = useRef<Record<string, string>>({});
  const [replyDraftTick, setReplyDraftTick] = useState(0);
  const editorPageRef = useRef<HTMLDivElement | null>(null);
  const threadsRef = useRef<HighlightThread[]>(initialThreads);
  const activeThreadIdRef = useRef<string | null>(initialThreads[0]?.id ?? null);
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

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  function updateThreadOffsets() {
    if (!editor || !editorPageRef.current) {
      return;
    }

    const pageRect = editorPageRef.current.getBoundingClientRect();
    const nextOffsets = threads
      .map((thread) => {
        try {
          const top =
            thread.fromPos != null ? editor.view.coordsAtPos(thread.fromPos).top - pageRect.top : 0;
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
      cursor = top + (item.id === activeThreadId ? 244 : 124);
    });

    setThreadOffsets(normalized);
    setRailHeight(Math.max(editorPageRef.current.offsetHeight, cursor + 32));
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Image.configure({
        allowBase64: true,
        inline: false
      }),
      commentHighlightExtension,
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
      TableCell
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
      }
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      if (from === to || !editorPageRef.current) {
        setSelection(null);
        setSelectionPopoverMode(null);
        return;
      }

      const text = editor.state.doc.textBetween(from, to, " ").trim();
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
      if (!canWriteDocument) {
        return;
      }

      setSaveState("saving");
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = window.setTimeout(async () => {
        const response = await fetch(`/api/documents/${documentId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            title: titleRef.current,
            content: editor.getJSON(),
            shareToken
          })
        });

        setSaveState(response.ok ? "saved" : "error");
      }, 700);

      window.requestAnimationFrame(() => {
        updateThreadOffsets();
      });
    }
  });

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threads]
  );

  useEffect(() => {
    threadsRef.current = threads;
    activeThreadIdRef.current = activeThreadId;

    if (editor) {
      editor.view.dispatch(editor.state.tr.setMeta("comment-highlight-refresh", Date.now()));
    }
  }, [activeThreadId, editor, threads]);

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
    };
  }, [editor, threads, activeThreadId]);

  function getReplyDraft(threadId: string) {
    void replyDraftTick;
    return replyDraftsRef.current[threadId] ?? "";
  }

  function setReplyDraft(threadId: string, value: string) {
    replyDraftsRef.current[threadId] = value;
    setReplyDraftTick((count) => count + 1);
  }

  async function handleSaveTitleBlur() {
    if (!canWriteDocument || !editor) {
      return;
    }

    setSaveState("saving");
    const response = await fetch(`/api/documents/${documentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        content: editor.getJSON(),
        shareToken
      })
    });

    setSaveState(response.ok ? "saved" : "error");
  }

  async function handleCreateComment() {
    if (!selection || !composerBody.trim()) {
      return;
    }

    setCommentBusy(true);
    setGlobalError(null);

    const response = await fetch(`/api/documents/${documentId}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        body: composerBody.trim(),
        anchorText: selection.text,
        anchorContext: selection.context,
        fromPos: selection.from,
        toPos: selection.to,
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.thread) {
      setGlobalError(data?.error ?? "Unable to create thread.");
      setCommentBusy(false);
      return;
    }

    setThreads((current) => [data.thread, ...current]);
    setActiveThreadId(data.thread.id);
    setSelection(null);
    setComposerBody("");
    setSelectionPopoverMode(null);
    setCommentBusy(false);
  }

  async function handleAiEdit() {
    if (!selection || !editInstruction.trim() || !editor) {
      return;
    }

    setEditBusy(true);
    setGlobalError(null);

    const response = await fetch(`/api/documents/${documentId}/ai-edit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        selectedText: selection.text,
        selectedContext: selection.context,
        instruction: editInstruction.trim(),
        shareToken
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.replacementText) {
      setGlobalError(data?.error ?? "AI edit failed.");
      setEditBusy(false);
      return;
    }

    editor
      .chain()
      .focus()
      .insertContentAt({ from: selection.from, to: selection.to }, data.replacementText)
      .run();

    setSelection(null);
    setSelectionPopoverMode(null);
    setEditInstruction("");
    setEditBusy(false);
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
    setAiBusyThreadId(null);
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

    if (editor && thread.fromPos != null && thread.toPos != null) {
      try {
        editor.commands.setTextSelection({ from: thread.fromPos, to: thread.toPos });
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

  const orderedThreads = useMemo(() => {
    const inactiveThreads = threads.filter((thread) => thread.id !== activeThreadId);
    const activeThread = threads.find((thread) => thread.id === activeThreadId);
    return activeThread ? [...inactiveThreads, activeThread] : inactiveThreads;
  }, [activeThreadId, threads]);

  return (
    <section className="workspace-shell">
      {globalError ? <div className="error-banner">{globalError}</div> : null}

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
            <div className="status-row">
              <span className="permission-pill">{permissionLabel(initialPermission)}</span>
              {viaShareLink ? <span className="subtle-pill">Opened via link</span> : null}
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
          </div>

          <div className="document-topbar-actions">
            <div className="presence-chip">
              {isAuthenticated ? `Signed in as ${currentUserName}` : "Browsing via share link"}
            </div>
            {isOwner ? (
              <button className="primary-button" onClick={() => setShareModalOpen(true)} type="button">
                Share
              </button>
            ) : null}
          </div>
        </div>

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
          </div>

          <div className="editor-toolbar-hint">Paste or drop images into the page</div>
        </div>
      </div>

      <div className="editor-stage">
        <div className="editor-page-shell">
          <div className="editor-page" ref={editorPageRef}>
            {selection && (canWriteComments || canWriteDocument) ? (
              <div
                className="selection-bubble-wrap"
                style={{
                  left: selection.bubbleLeft,
                  top: selection.bubbleTop
                }}
              >
                {selectionPopoverMode === "menu" ? (
                  <div className="selection-bubble-menu">
                    {canWriteComments ? (
                      <button
                        className="selection-bubble"
                        onClick={() => setSelectionPopoverMode("comment")}
                        type="button"
                      >
                        Add comment
                      </button>
                    ) : null}
                    {canWriteDocument ? (
                      <button
                        className="selection-bubble selection-bubble-secondary"
                        onClick={() => setSelectionPopoverMode("edit")}
                        type="button"
                      >
                        Edit with AI
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {selectionPopoverMode === "comment" ? (
                  <div className="comment-composer-popover">
                    <div className="composer-selection-preview">“{truncate(selection.text, 80)}”</div>
                    <textarea
                      onChange={(event) => setComposerBody(event.target.value)}
                      placeholder="Add a comment"
                      rows={4}
                      value={composerBody}
                    />
                    <div className="comment-composer-actions">
                      <button
                        className="ghost-button"
                        onClick={() => {
                          setSelectionPopoverMode("menu");
                          setComposerBody("");
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="primary-button"
                        disabled={!composerBody.trim() || commentBusy}
                        onClick={handleCreateComment}
                        type="button"
                      >
                        {commentBusy ? "Posting..." : "Comment"}
                      </button>
                    </div>
                  </div>
                ) : null}

                {selectionPopoverMode === "edit" ? (
                  <div className="comment-composer-popover">
                    <div className="composer-selection-preview">“{truncate(selection.text, 80)}”</div>
                    <textarea
                      onChange={(event) => setEditInstruction(event.target.value)}
                      placeholder="Tell AI how to rewrite the selection"
                      rows={4}
                      value={editInstruction}
                    />
                    <div className="comment-composer-actions">
                      <button
                        className="ghost-button"
                        onClick={() => {
                          setSelectionPopoverMode("menu");
                          setEditInstruction("");
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="primary-button"
                        disabled={!editInstruction.trim() || editBusy}
                        onClick={handleAiEdit}
                        type="button"
                      >
                        {editBusy ? "Editing..." : "Apply edit"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <EditorContent editor={editor} />
          </div>
        </div>

        <aside className="comment-rail" style={{ minHeight: railHeight }}>
          {threads.length === 0 ? (
            <div className="comment-rail-empty">
              <p>
                {canWriteComments
                  ? "Select text to add a comment."
                  : "Comments will appear here when collaborators start a thread."}
              </p>
            </div>
          ) : (
            orderedThreads.map((thread) => {
              const isActive = activeThread?.id === thread.id;
              const latestComment = thread.comments[thread.comments.length - 1];

              return (
                <article
                  className={`comment-thread-card ${isActive ? "comment-thread-card-active" : ""}`}
                  key={thread.id}
                  onMouseDown={() => focusThread(thread)}
                  style={{ top: threadOffsets[thread.id] ?? 16 }}
                >
                  <button className="comment-thread-anchor" onClick={() => focusThread(thread)} type="button">
                    <span className="comment-anchor-quote">“{truncate(thread.anchorText, 52)}”</span>
                    <span className="comment-anchor-meta">
                      {thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}
                    </span>
                  </button>

                  {!isActive ? (
                    <div className="comment-thread-preview">
                      <div className="comment-author-chip">
                        <span className="avatar-dot">
                          {getInitials(latestComment?.author?.name ?? "Claude")}
                        </span>
                        <strong>{latestComment?.author?.name ?? "Claude"}</strong>
                      </div>
                      <p>{truncate(latestComment?.body ?? "", 140)}</p>
                    </div>
                  ) : (
                    <>
                      <div className="comment-bubble-list">
                        {thread.comments.map((comment) => (
                          <div className="comment-bubble" key={comment.id}>
                            <div className="comment-bubble-header">
                              <div className="comment-author-chip">
                                <span className="avatar-dot">
                                  {getInitials(comment.author?.name ?? "Claude")}
                                </span>
                                <strong>{comment.author?.name ?? "Claude"}</strong>
                              </div>
                              <div className="comment-bubble-meta">
                                <span>{formatTime(comment.createdAt)}</span>
                                {isOwner ||
                                comment.author?.id === currentUserId ||
                                comment.aiModel ? (
                                  <button
                                    className="comment-delete-button"
                                    disabled={deleteBusyCommentId === comment.id}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleDeleteComment(comment.id);
                                    }}
                                    type="button"
                                  >
                                    {deleteBusyCommentId === comment.id ? "Deleting..." : "Delete"}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                            <p>{comment.body}</p>
                            {comment.aiModel ? (
                              <span className="subtle-pill">{comment.aiModel}</span>
                            ) : null}
                          </div>
                        ))}
                      </div>

                      {canWriteComments ? (
                        <div className="thread-actions">
                          <textarea
                            onChange={(event) => setReplyDraft(thread.id, event.target.value)}
                            placeholder="Reply"
                            rows={3}
                            value={getReplyDraft(thread.id)}
                          />
                          <div className="comment-composer-actions">
                            <button
                              className="ghost-button"
                              disabled={
                                replyBusyThreadId === thread.id || !getReplyDraft(thread.id).trim()
                              }
                              onClick={() => handleReply(thread.id)}
                              type="button"
                            >
                              {replyBusyThreadId === thread.id ? "Sending..." : "Reply"}
                            </button>
                            <button
                              className="primary-button"
                              disabled={aiBusyThreadId === thread.id}
                              onClick={() => handleAskAi(thread.id)}
                              type="button"
                            >
                              {aiBusyThreadId === thread.id ? "Claude is thinking..." : "Ask AI"}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </article>
              );
            })
          )}
        </aside>
      </div>

      <div className="future-ai-card">
        <div>
          <strong>Next AI step</strong>
          <p>
            The editor now preserves more Google Docs formatting on paste. The next step is
            selection-based AI rewriting that updates the document directly instead of only replying
            in comments.
          </p>
        </div>
      </div>

      {shareModalOpen ? (
        <div className="share-modal-backdrop" onClick={() => setShareModalOpen(false)} role="presentation">
          <div
            aria-modal="true"
            className="share-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="share-modal-header">
              <div>
                <h2>Share document</h2>
                <p>Add collaborators or create permissioned links.</p>
              </div>
              <button className="ghost-button" onClick={() => setShareModalOpen(false)} type="button">
                Close
              </button>
            </div>

            <div className="member-invite-form">
              <input
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="Collaborator email"
                type="email"
                value={inviteEmail}
              />
              <div className="comment-composer-actions">
                <select
                  onChange={(event) => setInvitePermission(event.target.value as PermissionLevelValue)}
                  value={invitePermission}
                >
                  {permissionLevels.map((permission) => (
                    <option key={permission} value={permission}>
                      {permissionLabel(permission)}
                    </option>
                  ))}
                </select>
                <button
                  className="primary-button"
                  disabled={inviteBusy || !inviteEmail.trim()}
                  onClick={handleInviteCollaborator}
                  type="button"
                >
                  {inviteBusy ? "Inviting..." : "Invite by email"}
                </button>
              </div>
            </div>

            <div className="share-modal-section">
              <h3>People with access</h3>
              <div className="member-list">
                {members.length === 0 ? (
                  <p className="muted-copy">No direct collaborators yet.</p>
                ) : (
                  members.map((member) => (
                    <div className="member-row" key={member.id}>
                      <div>
                        <strong>{member.user.name}</strong>
                        <span>{member.user.email}</span>
                      </div>
                      <span className="permission-pill">{permissionLabel(member.permission)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="share-modal-section">
              <h3>Share links</h3>
              <div className="share-actions">
                {permissionLevels.map((permission) => (
                  <button
                    className="ghost-button"
                    disabled={creatingLink === permission}
                    key={permission}
                    onClick={() => handleCreateShareLink(permission)}
                    type="button"
                  >
                    {creatingLink === permission ? "Creating..." : `New ${permission.toLowerCase()} link`}
                  </button>
                ))}
              </div>

              <div className="share-link-list">
                {shareLinks.length === 0 ? (
                  <p className="muted-copy">No active share links yet.</p>
                ) : (
                  shareLinks.map((link) => {
                    const path = `/share/${link.token}`;

                    return (
                      <div className="share-link-row" key={link.id}>
                        <div>
                          <strong>{permissionLabel(link.permission)}</strong>
                          <span>{path}</span>
                        </div>
                        <div className="share-link-actions">
                          <button
                            className="ghost-button"
                            onClick={() =>
                              navigator.clipboard.writeText(`${window.location.origin}${path}`)
                            }
                            type="button"
                          >
                            Copy
                          </button>
                          <button
                            className="ghost-button danger-button"
                            onClick={() => handleRevokeShareLink(link.id)}
                            type="button"
                          >
                            Revoke
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
