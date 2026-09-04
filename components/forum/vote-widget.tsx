"use client";

import { useState } from "react";

import type { VoteKind, VoteTally } from "@/lib/forum-votes";

type VoteWidgetProps = {
  targetType: "document" | "comment";
  targetId: string;
  tally: VoteTally;
  // Signed-out viewers see the scores but can't vote.
  canVote: boolean;
  orientation?: "vertical" | "horizontal";
};

// LessWrong-style two-axis vote control shared by forum posts, quicktakes and
// comments: ▲/▼ is the general (karma) vote that ranks the feed, ✓/✗ is
// agree/disagree and only records where readers stand.
export function VoteWidget({
  targetType,
  targetId,
  tally: initialTally,
  canVote,
  orientation = "vertical"
}: VoteWidgetProps) {
  const [tally, setTally] = useState(initialTally);
  const [busy, setBusy] = useState(false);

  async function vote(kind: VoteKind, direction: 1 | -1) {
    if (!canVote || busy) return;
    const own = kind === "karma" ? tally.ownVote : tally.ownAgreement;
    const next = own === direction ? 0 : direction;
    setBusy(true);
    try {
      const endpoint =
        targetType === "document"
          ? `/api/documents/${targetId}/vote`
          : `/api/comments/comment/${targetId}/vote`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: next, kind })
      });
      if (!response.ok) return;
      setTally((await response.json()) as VoteTally);
    } catch {
      // Leave prior state; the next click retries.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`forum-vote forum-vote-${orientation}`} data-busy={busy ? "true" : "false"}>
      <div className="forum-vote-axis forum-vote-karma" title="Overall vote">
        <button
          type="button"
          className={`forum-vote-btn${tally.ownVote === 1 ? " forum-vote-active" : ""}`}
          aria-label="Upvote"
          disabled={!canVote || busy}
          onClick={() => vote("karma", 1)}
        >
          ▲
        </button>
        <span className="forum-vote-score">{tally.score}</span>
        <button
          type="button"
          className={`forum-vote-btn${tally.ownVote === -1 ? " forum-vote-active" : ""}`}
          aria-label="Downvote"
          disabled={!canVote || busy}
          onClick={() => vote("karma", -1)}
        >
          ▼
        </button>
      </div>
      <div className="forum-vote-axis forum-vote-agreement" title="Agree / disagree">
        <button
          type="button"
          className={`forum-vote-btn${tally.ownAgreement === 1 ? " forum-vote-active" : ""}`}
          aria-label="Agree"
          disabled={!canVote || busy}
          onClick={() => vote("agreement", 1)}
        >
          ✓
        </button>
        <span className="forum-vote-score forum-vote-agreement-score">{tally.agreement}</span>
        <button
          type="button"
          className={`forum-vote-btn${tally.ownAgreement === -1 ? " forum-vote-active" : ""}`}
          aria-label="Disagree"
          disabled={!canVote || busy}
          onClick={() => vote("agreement", -1)}
        >
          ✗
        </button>
      </div>
    </div>
  );
}
