"use client";

import { useState } from "react";

import { MarkdownBody } from "@/components/document-workspace/markdown";

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
  score: number;
  ownVote: number;
  anchorQuote: string | null;
  replies: ForumCommentView[];
};

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
  busy
}: {
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  busy: boolean;
}) {
  const [body, setBody] = useState("");
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
        placeholder="Write a comment…"
        rows={3}
        disabled={busy}
      />
      <div className="forum-reply-actions">
        {onCancel ? (
          <button type="button" className="forum-btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="forum-btn" disabled={busy || body.trim().length === 0}>
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
    </form>
  );
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
  busyParentId,
  depth
}: {
  comment: ForumCommentView;
  canComment: boolean;
  canVote: boolean;
  onReply: (threadId: string, parentId: string, body: string) => Promise<void>;
  busyParentId: string | null;
  depth: number;
}) {
  const [replying, setReplying] = useState(false);
  const busy = busyParentId === comment.id;
  return (
    <div className="forum-comment" data-depth={depth} id={`comment-${comment.id}`}>
      <div className="forum-comment-main">
        <VoteWidget
          targetType="comment"
          targetId={comment.id}
          initialScore={comment.score}
          initialOwnVote={comment.ownVote}
          canVote={canVote}
        />
        <div className="forum-comment-content">
          <div className="forum-comment-meta">
            <span className="forum-comment-author">{comment.authorName}</span>
            {comment.isAi ? <span className="forum-badge-ai">AI</span> : null}
            <span className="forum-comment-date">{formatDate(comment.createdAt)}</span>
            <CommentLinkButton commentId={comment.id} />
          </div>
          {comment.anchorQuote ? (
            <blockquote className="forum-anchor-quote">{comment.anchorQuote}</blockquote>
          ) : null}
          <MarkdownBody body={comment.body} className="forum-comment-body markdown-body" />
          {canComment ? (
            <div className="forum-comment-actions">
              <button
                type="button"
                className="forum-btn-ghost"
                onClick={() => setReplying((value) => !value)}
              >
                Reply
              </button>
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
        <div className="forum-comment-children">
          {comment.replies.map((reply) => (
            <CommentNode
              key={reply.id}
              comment={reply}
              canComment={canComment}
              canVote={canVote}
              onReply={onReply}
              busyParentId={busyParentId}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function countComments(comments: ForumCommentView[]): number {
  return comments.reduce((sum, c) => sum + 1 + countComments(c.replies), 0);
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
    <section className="forum-comments" aria-label="Comments">
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
          busyParentId={busyParentId}
          depth={0}
        />
      ))}
      {comments.length === 0 ? <p className="forum-empty">No comments yet.</p> : null}
    </section>
  );
}
