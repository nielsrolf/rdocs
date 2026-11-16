import type { SelectionPopoverMode } from "./types";

// Pure so it can be tested headlessly (tests/link-popover-visibility.test.ts).
export function linkPopoverVisible({
  href,
  selectionPopoverMode
}: {
  href: string | undefined;
  selectionPopoverMode: SelectionPopoverMode | null;
}): boolean {
  if (!href) return false;
  // An open composer (comment / reaction / AI edit) is anchored to the same
  // selection, so the link bubble would sit on top of its input. The small
  // "menu" bubble sits above the selection and does not collide.
  return selectionPopoverMode === null || selectionPopoverMode === "menu";
}
