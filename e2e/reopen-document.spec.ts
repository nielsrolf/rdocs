import { expect, test } from "@playwright/test";

import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { authenticate, documentContent, editor } from "./helpers";

// Regression for the "reopen shows a stale document" bug:
//
//   Open document A, edit it, switch to another document, then switch back to A
//   WITHOUT a hard refresh. A showed its pre-edit state; only refreshing the
//   page revealed the edits.
//
// Mechanism: switching back re-seeds the editor from Next.js's client Router
// Cache, which replays the RSC payload captured when A was first opened — so the
// editor seeds at the pre-edit content+version. The live SSE room streams only
// FUTURE steps, so nothing fetches the edits committed in between and the tab
// stays stale until a hard refresh. The fix makes the client pull the backlog
// once on connect, healing the stale seed.
//
// This reproduces the stale-seed via the BACK button: back/forward navigation
// restores from the Router Cache unconditionally (independent of staleTimes), so
// it deterministically replays the pre-edit snapshot — the same code path a real
// user hits when a cached document page is reused. Navigation is in-app only (a
// hard reload would bypass the cache and hide the bug).
test("editing a document then navigating away and back shows the edits (no refresh)", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");

  const user = await db.user.create({
    data: { email: `reopen-${crypto.randomUUID()}@example.com`, name: "Reopen User", passwordHash: "x" }
  });
  const docA = await db.document.create({
    data: {
      title: "Alpha document",
      content: serializeDocumentContent(documentContent("Alpha original.")),
      ownerId: user.id
    }
  });
  const docB = await db.document.create({
    data: {
      title: "Bravo document",
      content: serializeDocumentContent(documentContent("Bravo body.")),
      ownerId: user.id
    }
  });

  const context = await browser.newContext();

  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();

    // ── Open A and edit it. Wait for the edit to persist via the collab push.
    await page.goto(`/documents/${docA.id}`);
    await editor(page).waitFor({ state: "visible" });
    await expect(editor(page)).toContainText("Alpha original.");

    const savePush = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/documents/${docA.id}/collaboration`) &&
        response.request().method() === "POST" &&
        response.ok()
    );
    await editor(page).click();
    await page.keyboard.type("EDITED");
    await savePush;
    await expect(editor(page)).toContainText("EDITED");

    // ── Soft-navigate to B (File → Recent → Bravo), then back to A via the
    //    browser back button (which restores A from the Router Cache).
    await page.locator(".header-menu-file > summary").click();
    const bravoLink = page.locator(`.file-menu-list a[href="/documents/${docB.id}"]`);
    await bravoLink.waitFor({ state: "visible" });
    await bravoLink.click();
    await page.waitForURL(`**/documents/${docB.id}**`);
    await expect(editor(page)).toContainText("Bravo body.");
    await expect(editor(page)).not.toContainText("Alpha");

    await page.goBack();
    await page.waitForURL(`**/documents/${docA.id}**`);
    await editor(page).waitFor({ state: "visible" });
    await expect(editor(page)).toContainText("Alpha original.");

    // The bug: A re-renders from the stale cached snapshot, showing "Alpha
    // original." WITHOUT the edit. The connect-time catch-up pull heals the
    // stale seed, so the edit must reappear with no refresh.
    await expect(editor(page)).toContainText("EDITED");
  } finally {
    await context.close();
    await db.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId IN (?, ?)", docA.id, docB.id).catch(
      () => undefined
    );
    await db.document.deleteMany({ where: { ownerId: user.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});
