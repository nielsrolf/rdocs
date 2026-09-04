"use client";

import { useEffect, useRef, useState } from "react";

import { isStrongVote, STRONG_VOTE_WEIGHT, type VoteKind, type VoteTally } from "@/lib/forum-votes";

type VoteWidgetProps = {
  targetType: "document" | "comment";
  targetId: string;
  tally: VoteTally;
  // Signed-out viewers see the scores but can't vote.
  canVote: boolean;
  orientation?: "vertical" | "horizontal";
};

// How long ▲/▼ must be held before the press becomes a strong vote.
export const STRONG_VOTE_HOLD_MS = 550;

// Pure decision table for the karma buttons, shared by the pointer handlers
// and the unit test: a tap toggles a normal vote, a hold toggles a strong one.
export function nextKarmaVote(own: number, direction: 1 | -1, strong: boolean): number {
  const target = strong ? direction * STRONG_VOTE_WEIGHT : direction;
  return own === target ? 0 : target;
}

// LessWrong-style two-axis vote control shared by forum posts, quicktakes and
// comments: ▲/▼ is the general (karma) vote that ranks the feed — tap for a
// normal vote, click-and-hold for a strong one — and ✓/✗ is agree/disagree,
// which only records where readers stand.
export function VoteWidget({
  targetType,
  targetId,
  tally: initialTally,
  canVote,
  orientation = "vertical"
}: VoteWidgetProps) {
  const [tally, setTally] = useState(initialTally);
  const [busy, setBusy] = useState(false);
  // Which karma button is currently being held (drives the fill animation).
  const [holding, setHolding] = useState<1 | -1 | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdFired = useRef(false);

  useEffect(() => () => clearHold(), []);

  function clearHold() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(null);
  }

  async function cast(kind: VoteKind, value: number) {
    if (!canVote || busy) return;
    setBusy(true);
    try {
      const endpoint =
        targetType === "document"
          ? `/api/documents/${targetId}/vote`
          : `/api/comments/comment/${targetId}/vote`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, kind })
      });
      if (!response.ok) return;
      setTally((await response.json()) as VoteTally);
    } catch {
      // Leave prior state; the next click retries.
    } finally {
      setBusy(false);
    }
  }

  function karmaVote(direction: 1 | -1, strong: boolean) {
    void cast("karma", nextKarmaVote(tally.ownVote, direction, strong));
  }

  function agreementVote(direction: 1 | -1) {
    void cast("agreement", tally.ownAgreement === direction ? 0 : direction);
  }

  // Pointer choreography for the karma buttons: press starts the hold timer;
  // release before it fires = normal vote, after it fires = strong vote (cast
  // the moment the timer fires, so the user gets feedback without releasing).
  function karmaPressHandlers(direction: 1 | -1) {
    const disabled = !canVote || busy;
    return {
      onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        holdFired.current = false;
        setHolding(direction);
        holdTimer.current = setTimeout(() => {
          holdFired.current = true;
          clearHold();
          karmaVote(direction, true);
        }, STRONG_VOTE_HOLD_MS);
      },
      onPointerUp: () => {
        if (disabled) return;
        const wasHolding = holdTimer.current !== null;
        clearHold();
        if (wasHolding && !holdFired.current) karmaVote(direction, false);
      },
      onPointerLeave: clearHold,
      onPointerCancel: clearHold,
      onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
      // Keyboard activation (Enter/Space) arrives as a click with detail 0;
      // pointer clicks are already handled above.
      onClick: (event: React.MouseEvent) => {
        if (!disabled && event.detail === 0) karmaVote(direction, false);
      }
    };
  }

  const strong = isStrongVote(tally.ownVote);
  const karmaClass = (direction: 1 | -1) =>
    [
      "forum-vote-btn",
      Math.sign(tally.ownVote) === direction ? "forum-vote-active" : "",
      Math.sign(tally.ownVote) === direction && strong ? "forum-vote-strong" : "",
      holding === direction ? "forum-vote-holding" : ""
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <div className={`forum-vote forum-vote-${orientation}`} data-busy={busy ? "true" : "false"}>
      <div className="forum-vote-axis forum-vote-karma" title="Overall vote — click and hold for a strong vote">
        <button
          type="button"
          className={karmaClass(1)}
          aria-label={tally.ownVote > 0 && strong ? "Strong upvote (active)" : "Upvote — hold for strong upvote"}
          disabled={!canVote || busy}
          style={{ "--hold-ms": `${STRONG_VOTE_HOLD_MS}ms` } as React.CSSProperties}
          {...karmaPressHandlers(1)}
        >
          ▲
        </button>
        <span className="forum-vote-score">{tally.score}</span>
        <button
          type="button"
          className={karmaClass(-1)}
          aria-label={tally.ownVote < 0 && strong ? "Strong downvote (active)" : "Downvote — hold for strong downvote"}
          disabled={!canVote || busy}
          style={{ "--hold-ms": `${STRONG_VOTE_HOLD_MS}ms` } as React.CSSProperties}
          {...karmaPressHandlers(-1)}
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
          onClick={() => agreementVote(1)}
        >
          ✓
        </button>
        <span className="forum-vote-score forum-vote-agreement-score">{tally.agreement}</span>
        <button
          type="button"
          className={`forum-vote-btn${tally.ownAgreement === -1 ? " forum-vote-active" : ""}`}
          aria-label="Disagree"
          disabled={!canVote || busy}
          onClick={() => agreementVote(-1)}
        >
          ✗
        </button>
      </div>
    </div>
  );
}
