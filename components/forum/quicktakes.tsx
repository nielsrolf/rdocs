"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { MarkdownBody } from "@/components/document-workspace/markdown";

import { ForumComments, type ForumCommentView } from "./forum-comments";
import { VoteWidget } from "./vote-widget";
import { MentionTextarea } from "./mention-textarea";

// Serialized QuicktakeSummary (lib/quicktakes.ts) — dates as ISO strings.
export type QuicktakeView = {
  id: string;
  body: string;
  createdAt: string;
  owner: { id: string; name: string };
  isOwner: boolean;
  isPublic: boolean;
  groupName: string | null;
  score: number;
  ownVote: number;
  commentCount: number;
};

export type QuicktakeGroupOption = { id: string; name: string };

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

function CopyLinkButton({ path, label }: { path: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="forum-copy-link"
      title="Copy link"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`${window.location.origin}${path}`);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (http, permissions) — leave the button as-is.
        }
      }}
    >
      {copied ? "Copied!" : label ?? "Copy link"}
    </button>
  );
}

export function QuicktakeCard({
  take,
  canVote,
  canComment = false,
  currentUserName = "Guest",
  inlineComments = false,
  onDeleted
}: {
  take: QuicktakeView;
  canVote: boolean;
  // Whether the viewer may comment (signed-in viewers can comment on
  // everything the feed shows them: public takes via the forum-public
  // widening, group takes via their COMMENT grant, own takes as owner).
  canComment?: boolean;
  currentUserName?: string;
  // Expand the comment thread in place (feeds) instead of linking to the
  // permalink page (which already renders the thread below the card).
  inlineComments?: boolean;
  onDeleted?: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<ForumCommentView[] | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);

  async function toggleComments() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (comments === null) {
      setLoadingComments(true);
      try {
        const response = await fetch(`/api/documents/${take.id}/forum-comments`, {
          cache: "no-store"
        });
        if (response.ok) {
          const data = (await response.json()) as { comments: ForumCommentView[] };
          setComments(data.comments);
        }
      } finally {
        setLoadingComments(false);
      }
    }
  }

  const commentLabel = `${take.commentCount} comment${take.commentCount === 1 ? "" : "s"}`;
  return (
    <article className="quicktake-card" id={`quicktake-${take.id}`}>
      <VoteWidget
        targetType="document"
        targetId={take.id}
        initialScore={take.score}
        initialOwnVote={take.ownVote}
        canVote={canVote}
      />
      <div className="quicktake-content">
        <div className="quicktake-meta">
          <span className="quicktake-author">{take.owner.name}</span>
          <span>·</span>
          <span>{formatDate(take.createdAt)}</span>
          <span>·</span>
          <span className="quicktake-visibility">
            {take.isPublic ? "Public" : take.groupName ? `Group: ${take.groupName}` : "Private"}
          </span>
        </div>
        <MarkdownBody body={take.body} className="quicktake-body markdown-body" />
        <div className="quicktake-actions">
          {inlineComments ? (
            <button type="button" className="forum-copy-link" onClick={toggleComments}>
              {expanded ? "Hide comments" : commentLabel}
            </button>
          ) : (
            <Link href={`/forum/quicktakes/${take.id}`} className="forum-copy-link">
              {commentLabel}
            </Link>
          )}
          <CopyLinkButton path={`/forum/quicktakes/${take.id}`} />
          {take.isOwner && onDeleted ? (
            <button
              type="button"
              className="forum-copy-link quicktake-delete"
              disabled={deleting}
              onClick={async () => {
                if (!window.confirm("Delete this quicktake?")) return;
                setDeleting(true);
                try {
                  const response = await fetch(`/api/quicktakes/${take.id}`, { method: "DELETE" });
                  if (response.ok) onDeleted(take.id);
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          ) : null}
        </div>
        {expanded ? (
          <div className="quicktake-comments">
            {loadingComments ? (
              <p className="forum-empty">Loading comments…</p>
            ) : (
              <ForumComments
                documentId={take.id}
                initialComments={comments ?? []}
                canComment={canComment}
                canVote={canVote}
                currentUserName={currentUserName}
              />
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}

// Composer + per-user visibility setting ("in my settings I can specify a
// group") kept together so the sharing state is visible right where you post.
function QuicktakeComposer({
  groups,
  initialGroupId,
  onPosted
}: {
  groups: QuicktakeGroupOption[];
  initialGroupId: string | null;
  onPosted: (take: QuicktakeView) => void;
}) {
  const [body, setBody] = useState("");
  const [groupId, setGroupId] = useState<string | null>(initialGroupId);
  const [busy, setBusy] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function updateVisibility(next: string | null) {
    const previous = groupId;
    setGroupId(next);
    setSavingVisibility(true);
    setError(null);
    try {
      const response = await fetch("/api/user/quicktake-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: next })
      });
      if (!response.ok) {
        setGroupId(previous);
        setError("Could not update quicktake visibility.");
      }
    } catch {
      setGroupId(previous);
      setError("Could not update quicktake visibility.");
    } finally {
      setSavingVisibility(false);
    }
  }

  return (
    <form
      className="quicktake-composer"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmed = body.trim();
        if (!trimmed) return;
        setBusy(true);
        setError(null);
        try {
          const response = await fetch("/api/quicktakes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: trimmed })
          });
          if (!response.ok) {
            const data = (await response.json().catch(() => null)) as { error?: string } | null;
            setError(data?.error ?? "Could not post the quicktake.");
            return;
          }
          const data = (await response.json()) as { quicktake: QuicktakeView };
          setBody("");
          onPosted(data.quicktake);
        } finally {
          setBusy(false);
        }
      }}
    >
      <MentionTextarea
        value={body}
        onChange={setBody}
        placeholder="Share a quick take… (markdown + LaTeX supported)"
        rows={3}
        disabled={busy}
        maxLength={4000}
      />
      <div className="quicktake-composer-footer">
        <label className="quicktake-visibility-select">
          Visible to
          <select
            value={groupId ?? ""}
            disabled={savingVisibility}
            onChange={(event) => updateVisibility(event.target.value || null)}
          >
            <option value="">Everyone (public)</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                Group: {group.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="forum-btn" disabled={busy || body.trim().length === 0}>
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
      <p className="quicktake-visibility-hint">
        This setting applies to all your quicktakes, past and future.
      </p>
      {error ? <p className="forum-error">{error}</p> : null}
    </form>
  );
}

// Full quicktakes feed with composer, used on /forum/quicktakes. Signed-out
// visitors get the read-only public feed.
export function QuicktakeFeed({
  initialQuicktakes,
  groups,
  initialGroupId,
  isSignedIn,
  currentUserName = "Guest"
}: {
  initialQuicktakes: QuicktakeView[];
  groups: QuicktakeGroupOption[];
  initialGroupId: string | null;
  isSignedIn: boolean;
  currentUserName?: string;
}) {
  const router = useRouter();
  const [takes, setTakes] = useState(initialQuicktakes);

  return (
    <div className="quicktake-feed">
      {isSignedIn ? (
        <QuicktakeComposer
          groups={groups}
          initialGroupId={initialGroupId}
          onPosted={(take) => {
            setTakes((current) => [take, ...current]);
            router.refresh();
          }}
        />
      ) : null}
      {takes.map((take) => (
        <QuicktakeCard
          key={take.id}
          take={take}
          canVote={isSignedIn}
          canComment={isSignedIn}
          currentUserName={currentUserName}
          inlineComments
          onDeleted={(id) => setTakes((current) => current.filter((t) => t.id !== id))}
        />
      ))}
      {takes.length === 0 ? (
        <p className="forum-empty">
          No quicktakes yet.{isSignedIn ? " Post the first one above." : " Sign in to post one."}
        </p>
      ) : null}
    </div>
  );
}
