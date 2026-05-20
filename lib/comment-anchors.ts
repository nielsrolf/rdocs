import { stripCommentAnchorMarks } from "@/lib/content";

export function differsOnlyByCommentAnchors(currentContent: unknown, nextContent: unknown) {
  return JSON.stringify(stripCommentAnchorMarks(currentContent)) === JSON.stringify(stripCommentAnchorMarks(nextContent));
}
