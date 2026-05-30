import { expect, test } from "@playwright/test";

import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { authenticate, cleanupFixture, documentContent, editor } from "./helpers";

// End-to-end coverage for the @mentions feature: autocomplete in the comment
// composer and the document body, recognized-mention highlighting (self vs.
// other), and doc-body mention notifications.

async function createDocWithMember() {
  const owner = await db.user.create({
    data: { email: `owner-${crypto.randomUUID()}@example.com`, name: "Owner Olivia", passwordHash: "x" }
  });
  const member = await db.user.create({
    data: { email: `member-${crypto.randomUUID()}@example.com`, name: "Member Mary", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: {
      title: "Mentions doc",
      content: serializeDocumentContent(documentContent("Discuss the plan here.")),
      ownerId: owner.id
    }
  });
  await db.documentMembership.create({
    data: { documentId: document.id, userId: member.id, permission: "EDIT" }
  });
  return { owner, member, document };
}

test("comment autocomplete inserts a mention that renders highlighted", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { owner, member, document } = await createDocWithMember();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    await authenticate(context, baseURL, owner.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toBeVisible();
    await expect(editor(page)).toContainText("Discuss the plan here.");

    // Select all + open the comment composer.
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.locator(".selection-bubble", { hasText: "Add comment" }).click();

    // Type "@Mem" — the autocomplete should offer Member Mary.
    const composer = page.locator(".comment-composer-popover .mention-textarea-wrap textarea");
    await composer.click();
    await composer.type("Please review @Mem");
    const option = page.locator(".mention-suggest-textarea .mention-suggest-item", { hasText: "Member Mary" });
    await expect(option).toBeVisible();
    await option.click();

    // The composer text now contains the resolved handle.
    await expect(composer).toHaveValue(/@Member Mary/);
    await page.locator(".comment-composer-popover .primary-button", { hasText: "Comment" }).click();

    // The rendered comment highlights the recognized mention of another person.
    const bubble = page.locator(".comment-bubble", { hasText: "Please review" });
    await expect(bubble.locator("span.mention.mention-other", { hasText: "@Member Mary" })).toBeVisible();

    // And a mention notification was recorded for that member.
    await expect
      .poll(() => db.commentMention.count({ where: { documentId: document.id, mentionedUserId: member.id } }))
      .toBe(1);
  } finally {
    await context.close();
    await db.user.delete({ where: { id: member.id } }).catch(() => undefined);
    await cleanupFixture(owner.id, document.id);
  }
});

test("opening from a mention notification flashes the mentioning comment", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { owner, member, document } = await createDocWithMember();
  const threadId = `thread-${crypto.randomUUID()}`;
  // Anchor the thread in the doc body (anchorless threads are hidden), then have
  // the member post a comment that @mentions the owner.
  await db.document.update({
    where: { id: document.id },
    data: {
      content: serializeDocumentContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Discuss the plan here.",
                marks: [{ type: "commentAnchor", attrs: { threadId } }]
              }
            ]
          }
        ]
      })
    }
  });
  const thread = await db.commentThread.create({
    data: { id: threadId, documentId: document.id, createdById: member.id, anchorText: "Discuss the plan here.", status: "OPEN" }
  });
  const comment = await db.comment.create({
    data: { threadId: thread.id, authorId: member.id, body: "Hey @Owner Olivia please check" }
  });
  await db.commentMention.create({
    data: { commentId: comment.id, documentId: document.id, mentionedUserId: owner.id, acknowledged: false }
  });

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    await authenticate(context, baseURL, owner.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toBeVisible();

    // The mentioning comment is flashed (deep-linked) and its @mention of the
    // viewer is highlighted as a self-mention.
    const bubble = page.locator(".comment-bubble", { hasText: "please check" });
    await expect(bubble).toHaveClass(/comment-bubble-mention-flash/);
    await expect(bubble.locator("span.mention.mention-self", { hasText: "@Owner Olivia" })).toBeVisible();
  } finally {
    await context.close();
    await db.user.delete({ where: { id: member.id } }).catch(() => undefined);
    await cleanupFixture(owner.id, document.id);
  }
});

test("doc-body autocomplete inserts a highlighted mention and notifies the member", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { owner, member, document } = await createDocWithMember();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    await authenticate(context, baseURL, owner.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toBeVisible();

    // Put the caret at the end of the paragraph and type a mention.
    await editor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" cc @Mem");
    const option = page.locator(".editor-page .mention-suggest .mention-suggest-item", {
      hasText: "Member Mary"
    });
    await expect(option).toBeVisible();
    await option.click();

    // A highlighted mention is now in the document body: the mark span carries
    // the literal handle and the decoration adds the (other-person) highlight.
    await expect(editor(page).locator("span.mention", { hasText: "@Member Mary" })).toBeVisible();
    await expect(editor(page).locator(".mention-other", { hasText: "@Member Mary" })).toBeVisible();

    // The member got a document-body mention notification.
    await expect
      .poll(() => db.documentMention.count({ where: { documentId: document.id, mentionedUserId: member.id } }))
      .toBe(1);
  } finally {
    await context.close();
    await db.user.delete({ where: { id: member.id } }).catch(() => undefined);
    await cleanupFixture(owner.id, document.id);
  }
});