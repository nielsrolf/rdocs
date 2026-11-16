import assert from "node:assert/strict";
import test from "node:test";

import { linkPopoverVisible } from "../components/document-workspace/link-popover-visibility";

// Regression (2026-11-16): commenting on linked text left the link details
// bubble (URL / Open / Edit / Remove) floating on top of the comment field,
// because the selection still sits inside the link while the composer is open.

test("the link bubble shows for a link under the cursor", () => {
  assert.equal(linkPopoverVisible({ href: "https://example.com", selectionPopoverMode: null }), true);
  // The small "Add comment / Edit with AI" menu sits above the selection and does not collide.
  assert.equal(linkPopoverVisible({ href: "https://example.com", selectionPopoverMode: "menu" }), true);
});

test("the link bubble is hidden while a comment, reaction or AI-edit composer is open", () => {
  for (const mode of ["comment", "react", "edit"] as const) {
    assert.equal(
      linkPopoverVisible({ href: "https://example.com", selectionPopoverMode: mode }),
      false,
      `mode ${mode}`
    );
  }
});

test("no link, no bubble", () => {
  assert.equal(linkPopoverVisible({ href: undefined, selectionPopoverMode: null }), false);
  assert.equal(linkPopoverVisible({ href: "", selectionPopoverMode: null }), false);
});
