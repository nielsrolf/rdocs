"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { CommentAvatar } from "@/components/document-workspace/atoms";
import { MarkdownBody } from "@/components/document-workspace/markdown";
import { DEFAULT_COMMENT_TAGS, type ThreadView } from "@/components/document-workspace/types";
import { filterInboxThreads } from "@/lib/comment-inbox-filter";
import { formatDateTime, truncate } from "@/lib/utils";

export type InboxThreadView = ThreadView & {
  documentId: string;
  documentTitle: string;
};

type CommentInboxProps = {
  initialThreads: InboxThreadView[];
  allTags: string[];
};

function clientId() {
  // Best-effort unique id so our own SSE broadcast echoes are ignored by the
  // editor if the user has the doc open in another tab. Randomness is fine here.
  return `inbox-${Math.random().toString(36).slice(2)}`;
}

export function CommentInbox({ initialThreads, allTags }: CommentInboxProps) {
  const [threads, setThreads] = useState(initialThreads);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [newTagThreadId, setNewTagThreadId] = useState<string | null>(null);
  const [newTagDraft, setNewTagDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const visibleThreads = useMemo(
    () => filterInboxThreads(threads, selectedTags),
    [threads, selectedTags]
  );

  // Group the filtered threads by their parent document, preserving the
  // updatedAt ordering already applied server-side.
  const groups = useMemo(() => {
    const byDoc = new Map<string, { title: string; threads: InboxThreadView[] }>();
    for (const thread of visibleThreads) {
      const existing = byDoc.get(thread.documentId);
      if (existing) {
        existing.threads.push(thread);
      } else {
        byDoc.set(thread.documentId, { title: thread.documentTitle, threads: [thread] });
      }
    }
    return Array.from(byDoc.entries()).map(([documentId, value]) => ({ documentId, ...value }));
  }, [visibleThreads]);

  function toggleFilterTag(tag: string) {
    setSelectedTags((prev) =>
      prev.some((t) => t.toLowerCase() === tag.toLowerCase())
        ? prev.filter((t) => t.toLowerCase() !== tag.toLowerCase())
        : [...prev, tag]
    );
  }

  function replaceThread(next: ThreadView, documentId: string, documentTitle: string) {
    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === next.id ? { ...next, documentId, documentTitle } : thread
      )
    );
  }

  async function submitReply(thread: InboxThreadView) {
    const body = (replyDrafts[thread.id] ?? "").trim();
    if (!body) return;
    setBusyThreadId(thread.id);
    setError(null);
    try {
      const res = await fetch(`/api/comments/${thread.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, clientId: clientId() })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Failed to post reply.");
      }
      const data = await res.json();
      setThreads((prev) =>
        prev.map((t) =>
          t.id === thread.id ? { ...t, comments: [...t.comments, data.comment] } : t
        )
      );
      setReplyDrafts((prev) => ({ ...prev, [thread.id]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post reply.");
    } finally {
      setBusyThreadId(null);
    }
  }

  async function patchTags(thread: InboxThreadView, tags: string[], status?: "OPEN" | "RESOLVED") {
    setBusyThreadId(thread.id);
    setError(null);
    try {
      const res = await fetch(`/api/comments/${thread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags, status, clientId: clientId() })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Failed to update tags.");
      }
      const data = await res.json();
      replaceThread(data.thread, thread.documentId, thread.documentTitle);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update tags.");
    } finally {
      setBusyThreadId(null);
    }
  }

  function toggleThreadTag(thread: InboxThreadView, tag: string) {
    const has = thread.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
    const nextTags = has
      ? thread.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase())
      : [...thread.tags, tag];
    // Mirror the editor: toggling "Resolved" also flips the thread status.
    const isResolvedTag = tag.toLowerCase() === "resolved";
    const status = isResolvedTag ? (has ? "OPEN" : "RESOLVED") : undefined;
    void patchTags(thread, nextTags, status);
  }

  function commitNewTag(thread: InboxThreadView) {
    const tag = newTagDraft.trim();
    setNewTagThreadId(null);
    setNewTagDraft("");
    if (!tag) return;
    if (thread.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    void patchTags(thread, [...thread.tags, tag]);
  }

  const hasThreads = threads.length > 0;

  return (
    <section className="surface-card comment-inbox">
      <div className="comment-inbox-filter">
        <span className="eyebrow">Filter by tag</span>
        <div className="comment-inbox-filter-chips">
          {allTags.length === 0 ? (
            <span className="comment-inbox-empty-hint">No tags yet.</span>
          ) : (
            allTags.map((tag) => {
              const active = selectedTags.some((t) => t.toLowerCase() === tag.toLowerCase());
              return (
                <button
                  className={active ? "comment-tag-chip comment-tag-chip-active" : "comment-tag-chip"}
                  key={tag}
                  onClick={() => toggleFilterTag(tag)}
                  type="button"
                >
                  {tag}
                </button>
              );
            })
          )}
          {selectedTags.length > 0 ? (
            <button className="ghost-button" onClick={() => setSelectedTags([])} type="button">
              Clear
            </button>
          ) : null}
        </div>
        {selectedTags.length > 1 ? (
          <p className="comment-inbox-and-hint">Showing comments with all selected tags.</p>
        ) : null}
      </div>

      {error ? <p className="comment-inbox-error">{error}</p> : null}

      {!hasThreads ? (
        <div className="empty-state">
          <p>No comments in your documents yet.</p>
        </div>
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <p>No comments match the selected tags.</p>
        </div>
      ) : (
        <div className="comment-inbox-groups">
          {groups.map((group) => (
            <div className="comment-inbox-group" key={group.documentId}>
              <div className="comment-inbox-group-head">
                <Link className="comment-inbox-doc-title" href={`/documents/${group.documentId}`}>
                  {group.title || "Untitled"}
                </Link>
                <span className="comment-inbox-group-count">
                  {group.threads.length} {group.threads.length === 1 ? "comment" : "comments"}
                </span>
              </div>

              <div className="comment-inbox-thread-list">
                {group.threads.map((thread) => (
                  <div className="comment-inbox-thread" key={thread.id}>
                    {thread.anchorText ? (
                      <blockquote className="comment-inbox-anchor">
                        {truncate(thread.anchorText, 140)}
                      </blockquote>
                    ) : null}

                    <div className="comment-inbox-comments">
                      {thread.comments.map((comment) => (
                        <div className="comment-inbox-comment" key={comment.id}>
                          <div className="comment-inbox-comment-head">
                            <CommentAvatar comment={comment} />
                            <span className="comment-inbox-author">
                              {comment.author?.name ?? comment.guestName ?? "Guest"}
                            </span>
                            <span className="comment-inbox-time">
                              {formatDateTime(comment.createdAt)}
                            </span>
                          </div>
                          <MarkdownBody
                            body={comment.body}
                            className="comment-bubble-body markdown-body"
                          />
                        </div>
                      ))}
                    </div>

                    <div
                      className="comment-tag-row"
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      {[
                        ...DEFAULT_COMMENT_TAGS,
                        ...thread.tags.filter(
                          (tag) =>
                            !DEFAULT_COMMENT_TAGS.some((d) => d.toLowerCase() === tag.toLowerCase())
                        )
                      ].map((tag) => {
                        const active = thread.tags.some(
                          (candidate) => candidate.toLowerCase() === tag.toLowerCase()
                        );
                        return (
                          <button
                            className={
                              active ? "comment-tag-chip comment-tag-chip-active" : "comment-tag-chip"
                            }
                            disabled={busyThreadId === thread.id}
                            key={tag}
                            onClick={() => toggleThreadTag(thread, tag)}
                            type="button"
                          >
                            {tag}
                          </button>
                        );
                      })}
                      {newTagThreadId === thread.id ? (
                        <input
                          autoFocus
                          className="comment-tag-add-input"
                          maxLength={48}
                          onBlur={() => commitNewTag(thread)}
                          onChange={(event) => setNewTagDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitNewTag(thread);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setNewTagThreadId(null);
                              setNewTagDraft("");
                            }
                          }}
                          placeholder="New tag"
                          value={newTagDraft}
                        />
                      ) : (
                        <button
                          className="comment-tag-add"
                          disabled={busyThreadId === thread.id}
                          onClick={() => {
                            setNewTagThreadId(thread.id);
                            setNewTagDraft("");
                          }}
                          type="button"
                        >
                          + Tag
                        </button>
                      )}
                    </div>

                    <div className="comment-inbox-reply">
                      <textarea
                        className="comment-inbox-reply-input"
                        onChange={(event) =>
                          setReplyDrafts((prev) => ({ ...prev, [thread.id]: event.target.value }))
                        }
                        placeholder="Reply…"
                        rows={2}
                        value={replyDrafts[thread.id] ?? ""}
                      />
                      <div className="comment-inbox-reply-actions">
                        <Link
                          className="ghost-button"
                          href={`/documents/${thread.documentId}?comment=${thread.id}`}
                        >
                          Open in document →
                        </Link>
                        <button
                          className="primary-button"
                          disabled={
                            busyThreadId === thread.id || !(replyDrafts[thread.id] ?? "").trim()
                          }
                          onClick={() => submitReply(thread)}
                          type="button"
                        >
                          {busyThreadId === thread.id ? "Posting…" : "Reply"}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
