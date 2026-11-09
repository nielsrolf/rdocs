"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { MarkdownBody } from "@/components/document-workspace/markdown";
import type { VoteTally } from "@/lib/forum-votes";
import { MARKDOWN_SHORTCUT_HINT } from "@/lib/markdown-shortcuts";

import { publishForumComments } from "./forum-comment-store";
import { VoteWidget } from "./vote-widget";
import { MentionTextarea } from "./mention-textarea";

export type ForumCommentView = {
  id: string;
  threadId: string;
  parentId: string | null;
  body: string;
  authorName: string;
  authorId: string | null;
  isAi: boolean;
  createdAt: string;
  canEdit: boolean;
  anchorQuote: string | null;
  replies: ForumCommentView[];
} & VoteTally;

type ForumCommentsProps = {
  documentId: string;
  initialComments: ForumCommentView[];
  canComment: boolean;
  canVote: boolean;
  currentUserName: string;
};

function formatDate(value: string) {
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  } catch {
    return value;
  }
}

function ReplyForm({
  onSubmit,
  onCancel,
  busy,
  initialBody = "",
  submitLabel = "Post",
  busyLabel = "Posting…",
  placeholder = "Write a comment…"
}: {
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  busy: boolean;
  // Editing an existing comment reuses the same form with its current text.
  initialBody?: string;
  submitLabel?: string;
  busyLabel?: string;
  placeholder?: string;
}) {
  const [body, setBody] = useState(initialBody);
  return (
    <form
      className="forum-reply-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmed = body.trim();
        if (!trimmed) return;
        await onSubmit(trimmed);
        setBody("");
      }}
    >
      <MentionTextarea
        value={body}
        onChange={setBody}
        placeholder={placeholder}
        rows={3}
        disabled={busy}
      />
      <div className="forum-reply-actions">
        <span className="forum-editor-hint">{MARKDOWN_SHORTCUT_HINT}</span>
        {onCancel ? (
          <button type="button" className="forum-btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="forum-btn" disabled={busy || body.trim().length === 0}>
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}

const COMMENT_HASH_PREFIX = "comment-";
const COMMENT_LINK_FLASH_CLASS = "forum-comment-link-flash";

// Opened via a "#comment-<id>" permalink: scroll that comment into view and
// briefly highlight it so the reader sees which comment the link meant.
// Scoped to `root` because a feed renders one ForumComments per quicktake.
// A target inside folded replies is unfolded first (`reveal`), then scrolled
// to on the next frames once it is laid out again.
function useCommentLinkFlash(
  root: RefObject<HTMLElement | null>,
  reveal: RefObject<(commentId: string) => boolean>
) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flash = () => {
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (!hash.startsWith(COMMENT_HASH_PREFIX)) return;
      const target = document.getElementById(hash);
      if (!target || !root.current?.contains(target)) return;
      if (reveal.current?.(hash.slice(COMMENT_HASH_PREFIX.length))) {
        window.requestAnimationFrame(() => window.requestAnimationFrame(flash));
        return;
      }
      const main = target.querySelector<HTMLElement>(":scope > .forum-comment-main") ?? target;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      // Remove + reflow + re-add restarts the animation on a repeated link.
      main.classList.remove(COMMENT_LINK_FLASH_CLASS);
      void main.offsetWidth;
      main.classList.add(COMMENT_LINK_FLASH_CLASS);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => main.classList.remove(COMMENT_LINK_FLASH_CLASS), 4000);
    };
    flash();
    window.addEventListener("hashchange", flash);
    return () => {
      window.removeEventListener("hashchange", flash);
      if (timer) clearTimeout(timer);
    };
  }, [root, reveal]);
}

// Heading-style permalink for a comment: copies the current page URL with a
// #comment-<id> fragment ("look at this comment: <link>").
function CommentLinkButton({ commentId }: { commentId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="forum-copy-link"
      title="Copy link to this comment"
      onClick={async () => {
        const url = `${window.location.origin}${window.location.pathname}#comment-${commentId}`;
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable — at least move the fragment so the user
          // can copy from the address bar.
          window.location.hash = `comment-${commentId}`;
        }
      }}
    >
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}

function CommentNode({
  comment,
  canComment,
  canVote,
  onReply,
  onEdit,
  onTally,
  folded,
  onToggleFold,
  busyParentId,
  depth
}: {
  comment: ForumCommentView;
  canComment: boolean;
  canVote: boolean;
  onReply: (threadId: string, parentId: string, body: string) => Promise<void>;
  onEdit: (commentId: string, body: string) => Promise<boolean>;
  onTally: (commentId: string, tally: VoteTally) => void;
  folded: ReadonlySet<string>;
  onToggleFold: (commentId: string) => void;
  busyParentId: string | null;
  depth: number;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = busyParentId === comment.id;
  const isFolded = folded.has(comment.id);
  const replyCount = countComments(comment.replies);
  const replyLabel = `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`;
  return (
    <div className="forum-comment" data-depth={depth} id={`comment-${comment.id}`}>
      <div className="forum-comment-main">
        <div className="forum-comment-content">
          <div className="forum-comment-meta">
            <span className="forum-comment-author">{comment.authorName}</span>
            {comment.isAi ? <span className="forum-badge-ai">AI</span> : null}
            <span className="forum-comment-date">{formatDate(comment.createdAt)}</span>
            <CommentLinkButton commentId={comment.id} />
            {/* Votes live in the header row (LessWrong-style) so a short
                comment isn't stretched to the height of a stacked widget. */}
            <VoteWidget
              targetType="comment"
              targetId={comment.id}
              tally={comment}
              canVote={canVote}
              orientation="horizontal"
              onTallyChange={(tally) => onTally(comment.id, tally)}
            />
          </div>
          {comment.anchorQuote ? (
            <blockquote className="forum-anchor-quote">{comment.anchorQuote}</blockquote>
          ) : null}
          {editing ? (
            <ReplyForm
              busy={saving}
              initialBody={comment.body}
              submitLabel="Save"
              busyLabel="Saving…"
              placeholder="Edit your comment…"
              onCancel={() => setEditing(false)}
              onSubmit={async (body) => {
                setSaving(true);
                try {
                  if (await onEdit(comment.id, body)) setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
            />
          ) : (
            <MarkdownBody body={comment.body} className="forum-comment-body markdown-body" />
          )}
          {(canComment || comment.canEdit || replyCount > 0) && !editing ? (
            <div className="forum-comment-actions">
              {replyCount > 0 ? (
                <button
                  type="button"
                  className="forum-btn-ghost forum-fold-toggle"
                  aria-expanded={!isFolded}
                  onClick={() => onToggleFold(comment.id)}
                >
                  {isFolded ? `▸ Show ${replyLabel}` : `▾ Hide ${replyLabel}`}
                </button>
              ) : null}
              {canComment ? (
                <button
                  type="button"
                  className="forum-btn-ghost"
                  onClick={() => setReplying((value) => !value)}
                >
                  Reply
                </button>
              ) : null}
              {comment.canEdit ? (
                <button type="button" className="forum-btn-ghost" onClick={() => setEditing(true)}>
                  Edit
                </button>
              ) : null}
            </div>
          ) : null}
          {replying ? (
            <ReplyForm
              busy={busy}
              onCancel={() => setReplying(false)}
              onSubmit={async (body) => {
                await onReply(comment.threadId, comment.id, body);
                setReplying(false);
              }}
            />
          ) : null}
        </div>
      </div>
      {comment.replies.length > 0 ? (
        // Folded replies stay mounted (hidden) so open reply forms keep their
        // drafts and permalinks can still find their target to unfold it.
        <FoldedChildren folded={isFolded} onReveal={() => onToggleFold(comment.id)}>
          <button
            type="button"
            className="forum-thread-line"
            aria-label={`Hide ${replyLabel}`}
            title={`Hide ${replyLabel}`}
            onClick={() => onToggleFold(comment.id)}
          />
          {comment.replies.map((reply) => (
            <CommentNode
              key={reply.id}
              comment={reply}
              canComment={canComment}
              canVote={canVote}
              onReply={onReply}
              onEdit={onEdit}
              onTally={onTally}
              folded={folded}
              onToggleFold={onToggleFold}
              busyParentId={busyParentId}
              depth={depth + 1}
            />
          ))}
        </FoldedChildren>
      ) : null}
    </div>
  );
}

// Folded replies are `hidden="until-found"`, not plain `hidden`: the browser's
// Cmd/Ctrl-F still searches them and fires `beforematch` on a hit, which
// unfolds the thread. React 18 only renders boolean `hidden`, so the attribute
// is managed on the node directly. Browsers without until-found treat it as
// plain `hidden`.
function FoldedChildren({
  folded,
  onReveal,
  children
}: {
  folded: boolean;
  onReveal: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (folded) node.setAttribute("hidden", "until-found");
    else node.removeAttribute("hidden");
  }, [folded]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const handler = () => {
      // The browser has already removed `hidden`; sync the fold state.
      if (node.dataset.folded === "true") onRevealRef.current();
    };
    node.addEventListener("beforematch", handler);
    return () => node.removeEventListener("beforematch", handler);
  }, []);
  return (
    <div ref={ref} className="forum-comment-children" data-folded={folded ? "true" : "false"}>
      {children}
    </div>
  );
}

export function replaceCommentBody(
  comments: ForumCommentView[],
  commentId: string,
  body: string
): ForumCommentView[] {
  return comments.map((comment) =>
    comment.id === commentId
      ? { ...comment, body }
      : { ...comment, replies: replaceCommentBody(comment.replies, commentId, body) }
  );
}

export function patchComment(
  comments: ForumCommentView[],
  commentId: string,
  patch: Partial<ForumCommentView>
): ForumCommentView[] {
  return comments.map((comment) =>
    comment.id === commentId
      ? { ...comment, ...patch }
      : { ...comment, replies: patchComment(comment.replies, commentId, patch) }
  );
}

export function countComments(comments: ForumCommentView[]): number {
  return comments.reduce((sum, c) => sum + 1 + countComments(c.replies), 0);
}

// Ids of the comments enclosing `commentId`, outermost first ([] for a
// top-level comment or an unknown id) — the folds a permalink must open.
export function forumCommentAncestorIds(comments: ForumCommentView[], commentId: string): string[] {
  for (const comment of comments) {
    if (comment.id === commentId) return [];
    const inner = forumCommentAncestorIds(comment.replies, commentId);
    if (inner.length > 0 || comment.replies.some((reply) => reply.id === commentId)) {
      return [comment.id, ...inner];
    }
  }
  return [];
}

// Bottom-of-post nested comment section for the forum view. Studio-anchored
// threads render with their "> quoted anchor" prefix; forum threads are plain
// top-level comments. All of it is the SAME comment system as the studio rail.
export function ForumComments({
  documentId,
  initialComments,
  canComment,
  canVote
}: ForumCommentsProps) {
  const [comments, setComments] = useState(initialComments);
  const [busyParentId, setBusyParentId] = useState<string | null>(null);
  const [topBusy, setTopBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLElement | null>(null);
  // Unfolds whatever hides `commentId`; true when something had to open.
  const revealRef = useRef<(commentId: string) => boolean>(() => false);
  revealRef.current = (commentId) => {
    const closed = forumCommentAncestorIds(comments, commentId).filter((id) => folded.has(id));
    if (closed.length === 0) return false;
    setFolded((current) => {
      const next = new Set(current);
      closed.forEach((id) => next.delete(id));
      return next;
    });
    return true;
  };
  useCommentLinkFlash(rootRef, revealRef);

  useEffect(() => {
    publishForumComments(documentId, comments);
  }, [documentId, comments]);

  function toggleFold(commentId: string) {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(commentId)) next.delete(commentId);
      else next.add(commentId);
      return next;
    });
  }

  function updateTally(commentId: string, tally: VoteTally) {
    setComments((current) => patchComment(current, commentId, tally));
  }

  async function refresh() {
    const response = await fetch(`/api/documents/${documentId}/forum-comments`, {
      cache: "no-store"
    });
    if (!response.ok) return;
    const data = (await response.json()) as { comments: ForumCommentView[] };
    setComments(data.comments);
  }

  async function submitTopLevel(body: string) {
    setTopBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, origin: "forum", anchorText: "" })
      });
      if (!response.ok) {
        setError("Could not post the comment. Please try again.");
        return;
      }
      await refresh();
    } finally {
      setTopBusy(false);
    }
  }

  // Edits patch the local tree in place (no refetch) so the reader's scroll
  // position and any open reply forms survive.
  async function submitEdit(commentId: string, body: string): Promise<boolean> {
    setError(null);
    const response = await fetch(`/api/comments/comment/${commentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body })
    });
    if (!response.ok) {
      setError("Could not save the comment. Please try again.");
      return false;
    }
    setComments((current) => patchComment(current, commentId, { body }));
    return true;
  }

  async function submitReply(threadId: string, parentId: string, body: string) {
    setBusyParentId(parentId);
    setError(null);
    try {
      const response = await fetch(`/api/comments/${threadId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, parentId })
      });
      if (!response.ok) {
        setError("Could not post the reply. Please try again.");
        return;
      }
      await refresh();
    } finally {
      setBusyParentId(null);
    }
  }

  return (
    <section className="forum-comments" aria-label="Comments" ref={rootRef}>
      <h2 className="forum-comments-heading">
        {countComments(comments)} comment{countComments(comments) === 1 ? "" : "s"}
      </h2>
      {canComment ? <ReplyForm busy={topBusy} onSubmit={submitTopLevel} /> : null}
      {error ? <p className="forum-error">{error}</p> : null}
      {comments.map((comment) => (
        <CommentNode
          key={comment.id}
          comment={comment}
          canComment={canComment}
          canVote={canVote}
          onReply={submitReply}
          onEdit={submitEdit}
          onTally={updateTally}
          folded={folded}
          onToggleFold={toggleFold}
          busyParentId={busyParentId}
          depth={0}
        />
      ))}
      {comments.length === 0 ? <p className="forum-empty">No comments yet.</p> : null}
    </section>
  );
}
