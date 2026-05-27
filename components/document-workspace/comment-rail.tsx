import { getSourceLabel } from "@/lib/sources";
import { formatDateTime, truncate } from "@/lib/utils";

import { ClaudeWorkingInline, CommentAvatar } from "./atoms";
import { MarkdownBody } from "./markdown";
import {
  DEFAULT_COMMENT_TAGS,
  type ActiveAiRunView,
  type ThreadView
} from "./types";
import { getThreadTags, isThreadUnread } from "./utils";

export function CommentRail({
  threads,
  orderedThreads,
  activeThreadId,
  threadOffsets,
  railHeight,
  activeAiRun,
  commentThreadRunsByThread,
  aiBusyThreadId,
  replyBusyThreadId,
  deleteBusyCommentId,
  canWriteComments,
  isOwner,
  currentUserId,
  newTagThreadId,
  newTagDraft,
  onFocusThread,
  onToggleThreadTag,
  onStartNewTag,
  onChangeNewTagDraft,
  onCommitNewTag,
  onCancelNewTag,
  getReplyDraft,
  onChangeReplyDraft,
  onSubmitReply,
  onAskAi,
  onDeleteComment
}: {
  threads: ThreadView[];
  orderedThreads: ThreadView[];
  activeThreadId: string | null;
  threadOffsets: Record<string, number>;
  railHeight: number;
  activeAiRun: ActiveAiRunView | null;
  commentThreadRunsByThread: Map<string, ActiveAiRunView>;
  aiBusyThreadId: string | null;
  replyBusyThreadId: string | null;
  deleteBusyCommentId: string | null;
  canWriteComments: boolean;
  isOwner: boolean;
  currentUserId: string | null;
  newTagThreadId: string | null;
  newTagDraft: string;
  onFocusThread: (thread: ThreadView) => void;
  onToggleThreadTag: (thread: ThreadView, tag: string) => void;
  onStartNewTag: (threadId: string) => void;
  onChangeNewTagDraft: (value: string) => void;
  onCommitNewTag: (thread: ThreadView) => void;
  onCancelNewTag: () => void;
  getReplyDraft: (threadId: string) => string;
  onChangeReplyDraft: (threadId: string, value: string) => void;
  onSubmitReply: (threadId: string) => void;
  onAskAi: (threadId: string) => void;
  onDeleteComment: (commentId: string) => void;
}) {
  return (
    <aside className="comment-rail" style={{ minHeight: railHeight }}>
      {threads.length === 0 ? (
        <div className="comment-rail-empty">
          <p>
            {canWriteComments
              ? "Select text to add a comment."
              : "Comments will appear here when collaborators start a thread."}
          </p>
        </div>
      ) : orderedThreads.length === 0 ? (
        <div className="comment-rail-empty">
          <p>No comments match this filter.</p>
        </div>
      ) : (
        orderedThreads.map((thread) => {
          const isActive = activeThreadId === thread.id;
          const threadRun = commentThreadRunsByThread.get(thread.id) ?? null;
          const isThreadAiBusy = aiBusyThreadId === thread.id || threadRun !== null;
          const allComments = thread.comments;
          const visibleComments = isActive ? allComments : allComments.slice(0, 1);
          const hiddenReplyCount = allComments.length - visibleComments.length;
          const unread = !isActive && isThreadUnread(thread, currentUserId);
          const canDeleteCommentFor = (comment: typeof allComments[number]) =>
            isOwner || comment.author?.id === currentUserId || Boolean(comment.aiModel);

          return (
            <article
              className={`comment-thread-card${isActive ? " comment-thread-card-active" : ""}${unread ? " comment-thread-card-unread" : ""}`}
              key={thread.id}
              onMouseDown={() => {
                if (!isActive) onFocusThread(thread);
              }}
              style={{ top: threadOffsets[thread.id] ?? 16 }}
            >
              <button className="comment-thread-anchor" onClick={() => onFocusThread(thread)} type="button">
                <span className="comment-anchor-quote">“{truncate(thread.anchorText, 52)}”</span>
              </button>

              <div className="comment-bubble-list">
                {visibleComments.map((comment) => (
                  <div className="comment-bubble" key={comment.id}>
                    <div className="comment-bubble-header">
                      <div className="comment-author-chip">
                        <CommentAvatar comment={comment} />
                        <strong>{comment.author?.name ?? "Claude"}</strong>
                      </div>
                      <div className="comment-bubble-meta">
                        <span>{formatDateTime(comment.createdAt)}</span>
                        {isActive && canDeleteCommentFor(comment) ? (
                          <button
                            className="comment-delete-button"
                            disabled={deleteBusyCommentId === comment.id}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteComment(comment.id);
                            }}
                            type="button"
                          >
                            {deleteBusyCommentId === comment.id ? "Deleting..." : "Delete"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <MarkdownBody
                      body={comment.body}
                      className={
                        isActive
                          ? "comment-bubble-body markdown-body"
                          : "comment-bubble-body markdown-body comment-bubble-body-compact"
                      }
                    />
                    {isActive && comment.aiModel ? (
                      <div className="comment-ai-meta">
                        <span className="subtle-pill">{comment.aiModel}</span>
                        {comment.sourceLinks.length > 0 ? (
                          <details className="comment-sources">
                            <summary>Visited websites</summary>
                            <div className="comment-sources-list">
                              {comment.sourceLinks.map((sourceLink, index) => (
                                <a
                                  href={sourceLink}
                                  key={`${comment.id}-${sourceLink}`}
                                  rel="noopener noreferrer"
                                  target="_blank"
                                >
                                  [{index + 1}] {getSourceLabel(sourceLink)}
                                </a>
                              ))}
                            </div>
                          </details>
                        ) : null}
                        {comment.commitUrl ? (
                          <a
                            className="comment-commit-link"
                            href={comment.commitUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Commit {comment.commitSha?.slice(0, 7)}
                          </a>
                        ) : comment.commitSha ? (
                          <span className="subtle-pill">Commit {comment.commitSha.slice(0, 7)}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              {!isActive && hiddenReplyCount > 0 ? (
                <button
                  className="comment-thread-show-more"
                  onClick={(event) => {
                    event.stopPropagation();
                    onFocusThread(thread);
                  }}
                  type="button"
                >
                  Show {hiddenReplyCount} more {hiddenReplyCount === 1 ? "reply" : "replies"}
                </button>
              ) : null}

              {isThreadAiBusy ? (
                <ClaudeWorkingInline
                  activeAiRun={threadRun ?? activeAiRun}
                  compact={!isActive}
                />
              ) : null}

              {isActive ? (
                <div className="comment-tag-row" onMouseDown={(event) => event.stopPropagation()}>
                  {[...DEFAULT_COMMENT_TAGS, ...getThreadTags(thread).filter((tag) => !DEFAULT_COMMENT_TAGS.includes(tag))].map(
                    (tag) => {
                      const active = getThreadTags(thread).some(
                        (candidate) => candidate.toLowerCase() === tag.toLowerCase()
                      );
                      return (
                        <button
                          className={active ? "comment-tag-chip comment-tag-chip-active" : "comment-tag-chip"}
                          disabled={!canWriteComments}
                          key={tag}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleThreadTag(thread, tag);
                          }}
                          type="button"
                        >
                          {tag}
                        </button>
                      );
                    }
                  )}
                  {canWriteComments ? (
                    newTagThreadId === thread.id ? (
                      <input
                        autoFocus
                        className="comment-tag-add-input"
                        maxLength={48}
                        onBlur={() => onCommitNewTag(thread)}
                        onChange={(event) => onChangeNewTagDraft(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            onCommitNewTag(thread);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            onCancelNewTag();
                          }
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        placeholder="New tag"
                        value={newTagDraft}
                      />
                    ) : (
                      <button
                        className="comment-tag-add"
                        onClick={(event) => {
                          event.stopPropagation();
                          onStartNewTag(thread.id);
                        }}
                        type="button"
                      >
                        +
                      </button>
                    )
                  ) : null}
                </div>
              ) : null}

              {isActive && canWriteComments ? (
                <div className="thread-actions">
                  <textarea
                    onChange={(event) => onChangeReplyDraft(thread.id, event.target.value)}
                    placeholder="Reply"
                    rows={3}
                    value={getReplyDraft(thread.id)}
                  />
                  <div className="comment-composer-actions">
                    <button
                      className="ghost-button"
                      disabled={replyBusyThreadId === thread.id || !getReplyDraft(thread.id).trim()}
                      onClick={() => onSubmitReply(thread.id)}
                      type="button"
                    >
                      {replyBusyThreadId === thread.id ? "Sending..." : "Reply"}
                    </button>
                    <button
                      className="primary-button"
                      disabled={aiBusyThreadId === thread.id}
                      onClick={() => onAskAi(thread.id)}
                      type="button"
                    >
                      {aiBusyThreadId === thread.id ? "Claude is thinking..." : "Ask AI"}
                    </button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })
      )}
    </aside>
  );
}
