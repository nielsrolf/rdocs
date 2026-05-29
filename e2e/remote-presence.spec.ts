import { expect, test } from "@playwright/test";

import {
  authenticate,
  cleanupFixture,
  createDocumentFixture,
  editor,
  placeCursorAtStart,
  selectFirstParagraph
} from "./helpers";

// End-to-end coverage for the remote cursor/selection rendering that broke when
// people typed in earlier sections (bug 8). We assert that a collaborator's
// selection is shown to the other user AND that it survives a local edit made
// BEFORE it — i.e. the position mapping keeps the decoration alive rather than
// dropping/mis-placing it.

test("a collaborator's selection is shown to the other user and survives an earlier edit", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { user, document, shareLink } = await createDocumentFixture("Shared selection target text");

  try {
    const ownerContext = await browser.newContext();
    await authenticate(ownerContext, baseURL, user.id);
    const guestContext = await browser.newContext();

    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();

    await Promise.all([
      ownerPage.goto(`/documents/${document.id}`),
      guestPage.goto(`/documents/${document.id}?share=${shareLink.token}`)
    ]);
    await expect(editor(ownerPage)).toHaveText("Shared selection target text");
    await expect(editor(guestPage)).toHaveText("Shared selection target text");

    // Guest selects the paragraph -> presence broadcast carries the selection.
    await selectFirstParagraph(guestPage);

    // Owner renders the guest's remote selection decoration.
    await expect(ownerPage.locator(".remote-collab-selection").first()).toBeVisible({ timeout: 8_000 });

    // Owner edits BEFORE the guest's selection. The decoration must remain (the
    // mapping shifts it rather than dropping it).
    await placeCursorAtStart(ownerPage);
    await ownerPage.keyboard.type("PREFIX ", { delay: 10 });

    await expect(ownerPage.locator(".remote-collab-selection").first()).toBeVisible({ timeout: 8_000 });

    await ownerContext.close();
    await guestContext.close();
  } finally {
    await cleanupFixture(user.id, document.id);
  }
});
