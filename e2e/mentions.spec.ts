import { expect, test } from "@playwright/test";

import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { authenticate, cleanupFixture, editor } from "./helpers";

function docContent(text: string) {
  return serializeDocumentContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  });
}

test("@mentioning a member notifies them on the dashboard until they open the doc", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const owner = await db.user.create({
    data: { email: `owner-${crypto.randomUUID()}@example.com`, name: "Owner Olive", passwordHash: "x" }
  });
  const mentioned = await db.user.create({
    data: { email: `bob-${crypto.randomUUID()}@example.com`, name: "Mentioned Bob", passwordHash: "x" }
  });
  const document = await db.document.create({
    data: { title: "Mention doc", content: docContent("body"), ownerId: owner.id }
  });
  await db.documentMembership.create({
    data: { documentId: document.id, userId: mentioned.id, permission: "EDIT" }
  });
  const thread = await db.commentThread.create({
    data: { documentId: document.id, createdById: owner.id, anchorText: "body", status: "OPEN" }
  });
  await db.comment.create({ data: { threadId: thread.id, authorId: owner.id, body: "opening" } });

  const ownerCtx = await browser.newContext();
  const bobCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    // Owner replies, @mentioning Bob.
    await authenticate(ownerCtx, baseURL, owner.id);
    const reply = await ownerCtx.request.post(`/api/comments/${thread.id}/reply`, {
      data: { body: "hey @Mentioned Bob please review" }
    });
    expect(reply.status()).toBe(200);

    // A CommentMention row exists for Bob, unacknowledged.
    await expect
      .poll(async () =>
        db.commentMention.count({
          where: { documentId: document.id, mentionedUserId: mentioned.id, acknowledged: false }
        })
      )
      .toBe(1);

    // Bob's dashboard surfaces the mention badge.
    await authenticate(bobCtx, baseURL, mentioned.id);
    const page = await bobCtx.newPage();
    await page.goto("/dashboard");
    const row = page.locator(".doc-row", { hasText: "Mention doc" });
    await expect(row.locator(".mention-badge")).toHaveText(/@\s*1/);

    // Opening the document acknowledges Bob's mentions.
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toBeVisible();
    await expect
      .poll(async () =>
        db.commentMention.count({
          where: { documentId: document.id, mentionedUserId: mentioned.id, acknowledged: false }
        })
      )
      .toBe(0);

    // Badge is gone after returning to the dashboard.
    await page.goto("/dashboard");
    await expect(page.locator(".doc-row", { hasText: "Mention doc" })).toBeVisible();
    await expect(page.locator(".mention-badge")).toHaveCount(0);
  } finally {
    await ownerCtx.close();
    await bobCtx.close();
    await db.user.delete({ where: { id: mentioned.id } }).catch(() => undefined);
    await cleanupFixture(owner.id, document.id);
  }
});
