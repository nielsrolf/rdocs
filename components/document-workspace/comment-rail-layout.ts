// Pure stacking pass for the comment rail: given each thread's desired top
// (the y of its anchor in the document) sorted-and-pushed-down so cards never
// overlap. Extracted from document-workspace.tsx so it can be unit tested.

export const COMMENT_CARD_GAP = 12;
export const COMMENT_CARD_FALLBACK_HEIGHT = 140;
export const COMMENT_CARD_FALLBACK_HEIGHT_ACTIVE = 252;
export const COMMENT_RAIL_TOP_MARGIN = 16;

export type CommentAnchorTop = { id: string; top: number };

export type CommentRailLayout = {
  offsets: Record<string, number>;
  /** Bottom edge of the lowest card — used to size the rail. */
  bottom: number;
};

export function layoutCommentRail(
  anchors: CommentAnchorTop[],
  activeThreadId: string | null,
  /** Measured card heights by thread id; falls back to an estimate when a card has not rendered yet. */
  heights: Record<string, number> = {}
): CommentRailLayout {
  const sorted = anchors
    .map((item) => ({ id: item.id, top: Math.max(COMMENT_RAIL_TOP_MARGIN, item.top) }))
    .sort((left, right) => left.top - right.top);

  let cursor = COMMENT_RAIL_TOP_MARGIN;
  const offsets: Record<string, number> = {};

  sorted.forEach((item) => {
    const top = Math.max(item.top, cursor);
    offsets[item.id] = top;
    const height =
      heights[item.id] ??
      (item.id === activeThreadId ? COMMENT_CARD_FALLBACK_HEIGHT_ACTIVE : COMMENT_CARD_FALLBACK_HEIGHT);
    cursor = top + height + COMMENT_CARD_GAP;
  });

  return { offsets, bottom: cursor };
}
