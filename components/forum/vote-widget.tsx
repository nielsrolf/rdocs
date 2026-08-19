"use client";

import { useState } from "react";

type VoteWidgetProps = {
  targetType: "document" | "comment";
  targetId: string;
  initialScore: number;
  initialOwnVote: number;
  // Signed-out viewers see the score but can't vote.
  canVote: boolean;
  orientation?: "vertical" | "horizontal";
};

// LessWrong-style up/down vote control shared by forum posts and comments.
export function VoteWidget({
  targetType,
  targetId,
  initialScore,
  initialOwnVote,
  canVote,
  orientation = "vertical"
}: VoteWidgetProps) {
  const [score, setScore] = useState(initialScore);
  const [ownVote, setOwnVote] = useState(initialOwnVote);
  const [busy, setBusy] = useState(false);

  async function vote(direction: 1 | -1) {
    if (!canVote || busy) return;
    const next = ownVote === direction ? 0 : direction;
    setBusy(true);
    try {
      const endpoint =
        targetType === "document"
          ? `/api/documents/${targetId}/vote`
          : `/api/comments/comment/${targetId}/vote`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: next })
      });
      if (!response.ok) return;
      const data = (await response.json()) as { score: number; ownVote: number };
      setScore(data.score);
      setOwnVote(data.ownVote);
    } catch {
      // Leave prior state; the next click retries.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`forum-vote forum-vote-${orientation}`} data-busy={busy ? "true" : "false"}>
      <button
        type="button"
        className={`forum-vote-btn${ownVote === 1 ? " forum-vote-active" : ""}`}
        aria-label="Upvote"
        disabled={!canVote || busy}
        onClick={() => vote(1)}
      >
        ▲
      </button>
      <span className="forum-vote-score">{score}</span>
      <button
        type="button"
        className={`forum-vote-btn${ownVote === -1 ? " forum-vote-active" : ""}`}
        aria-label="Downvote"
        disabled={!canVote || busy}
        onClick={() => vote(-1)}
      >
        ▼
      </button>
    </div>
  );
}
