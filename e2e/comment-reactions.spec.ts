import { expect, test } from "@playwright/test";

import { db } from "../lib/db";
import { authenticate, cleanupFixture, createDocumentFixture, editor } from "./helpers";

test("a comment can be reacted to and the reaction toggles + persists", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { user, document } = await createDocumentFixture("reaction doc");
  const thread = await db.commentThread.create({
    data: {
      documentId: document.id,
      createdById: user.id,
      anchorText: "reaction doc",
      status: "OPEN"
    }
  });
  const comment = await db.comment.create({
    data: { threadId: thread.id, authorId: user.id, body: "first comment" }
  });

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toBeVisible();

    // Activate the thread so the reaction picker is available.
    await page.locator(".comment-thread-anchor").first().click();

    const bubble = page.locator(".comment-bubble", { hasText: "first comment" });
    await bubble.locator(".comment-reaction-add").click();
    await bubble.locator(".comment-reaction-option", { hasText: "🎉" }).click();

    // Pill appears, mine, count 1.
    const pill = bubble.locator(".comment-reaction-pill", { hasText: "🎉" });
    await expect(pill).toHaveClass(/comment-reaction-pill-mine/);
    await expect(pill.locator(".comment-reaction-count")).toHaveText("1");

    // Persisted server-side.
    await expect
      .poll(async () =>
        db.commentReaction.count({ where: { commentId: comment.id, userId: user.id, emoji: "🎉" } })
      )
      .toBe(1);

    // Toggle off.
    await pill.click();
    await expect(bubble.locator(".comment-reaction-pill", { hasText: "🎉" })).toHaveCount(0);
    await expect
      .poll(async () => db.commentReaction.count({ where: { commentId: comment.id } }))
      .toBe(0);
  } finally {
    await context.close();
    await cleanupFixture(user.id, document.id);
  }
});
