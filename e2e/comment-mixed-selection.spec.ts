import { expect, test } from "@playwright/test";

import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { authenticate, cleanupFixture, editor } from "./helpers";

// Regression for the two "select all over mixed content" comment bugs:
//   1. Commenting on a select-all spanning text + image + widget used to fail
//      with "Unable to anchor the comment to the selected text" (or anchor only
//      the text). It must now succeed and cover the atoms too.
//   2. After select-all + delete, the comment must disappear from the rail,
//      just like a comment anchored on deleted text.

const MIXED_CONTENT = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Intro paragraph." }] },
    { type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } },
    { type: "embeddedWidget", attrs: { label: "Explorer" } },
    { type: "paragraph", content: [{ type: "text", text: "Closing paragraph." }] }
  ]
};

async function createMixedDocumentFixture() {
  const user = await db.user.create({
    data: { email: `e2e-${crypto.randomUUID()}@example.com`, name: "E2E User", passwordHash: "not-used" }
  });
  const document = await db.document.create({
    data: {
      title: "Mixed content",
      content: serializeDocumentContent(MIXED_CONTENT),
      ownerId: user.id
    }
  });
  return { user, document };
}

test("comment on a select-all over text + image + widget, then it disappears on delete", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { user, document } = await createMixedDocumentFixture();

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toBeVisible();
    await expect(editor(page)).toContainText("Intro paragraph.");

    // Select the whole document (text + image + widget) and open the composer.
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.locator(".selection-bubble", { hasText: "Add comment" }).click();

    await page.locator(".comment-composer-popover textarea").fill("Covers everything");
    await page.locator(".comment-composer-popover .primary-button", { hasText: "Comment" }).click();

    // The thread is created (no "Unable to anchor" error) and the comment shows.
    await expect(page.locator(".comment-bubble", { hasText: "Covers everything" })).toBeVisible();
    await expect(page.locator(".error-toast")).toHaveCount(0);

    // The anchor covers the block atoms, not just text: persisted thread id on the widget/image.
    await expect
      .poll(async () => {
        const row = await db.document.findUnique({ where: { id: document.id }, select: { content: true } });
        return row?.content ?? "";
      })
      .toContain("commentThreadIds");

    // Now select-all + delete. The anchored comment must disappear from the rail.
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");

    await expect(page.locator(".comment-bubble", { hasText: "Covers everything" })).toHaveCount(0);
  } finally {
    await context.close();
    await cleanupFixture(user.id, document.id);
  }
});
