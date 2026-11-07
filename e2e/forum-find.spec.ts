import { expect, test } from "@playwright/test";

import { db } from "../lib/db";
import { authenticate, cleanupFixture, createDocumentFixture } from "./helpers";

// Cmd/Ctrl-F on a forum post must reach the browser's native find, which is
// the only find that sees the comment section below the post. The studio's
// in-editor find bar only searches the document, so it must not hijack the
// shortcut there. Folded replies are `hidden="until-found"` so native find
// can still reveal them.
test("forum post: Ctrl-F is the browser's find, folded replies stay findable", async ({ page, context, baseURL }) => {
  const { user, document } = await createDocumentFixture("forum post body");
  try {
    await db.document.update({
      where: { id: document.id },
      data: { forumPostedAt: new Date(), forumPublic: true }
    });
    const thread = await db.commentThread.create({
      data: { documentId: document.id, createdById: user.id, origin: "forum", anchorText: "" }
    });
    const root = await db.comment.create({
      data: { threadId: thread.id, authorId: user.id, body: "top level comment xylophone" }
    });
    await db.comment.create({
      data: { threadId: thread.id, authorId: user.id, parentId: root.id, body: "nested reply zebrafish" }
    });

    await authenticate(context, baseURL!, user.id);
    await page.goto(`/forum/${document.id}`);
    await expect(page.getByText("top level comment xylophone")).toBeVisible();
    await page.getByText("forum post body").click();
    await page.waitForTimeout(300);

    const prevented = await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
      window.document.querySelector(".gdocs-prosemirror")!.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
    await expect(page.locator(".find-bar")).toHaveCount(0);

    await page.getByRole("button", { name: /Hide 1 reply/ }).first().click();
    const children = page.locator(".forum-comment-children").first();
    await expect(children).toHaveAttribute("hidden", "until-found");
    // What native find does when it matches inside an until-found subtree.
    await children.evaluate((el) => el.dispatchEvent(new Event("beforematch")));
    await expect(page.getByText("nested reply zebrafish")).toBeVisible();
    await expect(children).not.toHaveAttribute("hidden", /.*/);
  } finally {
    await cleanupFixture(user.id, document.id);
  }
});
