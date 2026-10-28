"use client";

import { countComments, type ForumCommentView } from "./forum-comments";
import { useForumComments } from "./forum-comment-store";

// LessWrong-style "Comments" block at the bottom of the forum outline sidebar:
// one row per top-level comment with its author and karma; a click jumps to
// it through the same #comment-<id> permalink the comment's "Copy link" uses.
export function ForumCommentOutline({
  documentId,
  initialComments
}: {
  documentId: string;
  initialComments: ForumCommentView[];
}) {
  const comments = useForumComments(documentId, initialComments);
  const total = countComments(comments);

  function jumpTo(commentId: string) {
    const hash = `#comment-${commentId}`;
    if (window.location.hash === hash) {
      // Same fragment again: no hashchange fires, so trigger the scroll+flash.
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      window.location.hash = hash;
    }
  }

  return (
    <section className="forum-outline-comments" aria-label="Comments outline">
      <button
        type="button"
        className="forum-outline-comments-heading"
        onClick={() => document.querySelector(".forum-comments")?.scrollIntoView({ behavior: "smooth" })}
      >
        Comments{total > 0 ? ` (${total})` : ""}
      </button>
      {comments.length > 0 ? (
        <ul className="forum-outline-comment-list">
          {comments.map((comment) => {
            const replies = countComments(comment.replies);
            return (
              <li key={comment.id}>
                <button
                  type="button"
                  className="forum-outline-comment"
                  onClick={() => jumpTo(comment.id)}
                  title={comment.body.slice(0, 200)}
                >
                  <span className="forum-outline-comment-score">{comment.score}</span>
                  <span className="forum-outline-comment-author">
                    {comment.authorName}
                    {comment.isAi ? " (AI)" : ""}
                  </span>
                  {replies > 0 ? <span className="forum-outline-comment-replies">+{replies}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
