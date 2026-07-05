import { expect, test } from "@playwright/test";

import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { authenticate, cleanupFixture, editor } from "./helpers";

// The outline tab edit/delete buttons sit on the right of each row, hidden until
// the row is hovered or focused, fading in over the (truncated) title so they
// stay fully visible no matter how long the tab name is.
test("outline tab actions stay hidden at rest and reveal on hover/focus", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const user = await db.user.create({
    data: { email: `verify-${crypto.randomUUID()}@example.com`, name: "Verify User", passwordHash: "x" }
  });
  const content = {
    type: "doc",
    content: [
      {
        type: "tabBreak",
        attrs: { tabId: "tab-long", title: "A Very Long Tab Title That Will Definitely Overflow The Sidebar" }
      },
      { type: "paragraph", content: [{ type: "text", text: "first tab body" }] },
      { type: "tabBreak", attrs: { tabId: "tab-two", title: "Second Tab" } },
      { type: "paragraph", content: [{ type: "text", text: "second tab body" }] }
    ]
  };
  const document = await db.document.create({
    data: { title: "Verify document", content: serializeDocumentContent(content), ownerId: user.id }
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await editor(page).waitFor({ state: "visible" });

    const row = page.locator(".doc-tab-row").first();
    const actions = row.locator(".doc-tab-actions");
    await expect(actions).toBeAttached();

    // At rest the overlay is transparent and ignores the pointer.
    await expect(actions).toHaveCSS("opacity", "0");
    await expect(actions).toHaveCSS("pointer-events", "none");

    // Hover reveals it, fully opaque and interactive, so all four buttons are usable.
    await row.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(actions).toHaveCSS("pointer-events", "auto");
    await expect(actions.locator("button")).toHaveCount(4);

    // Regression guard: even with a very long title, the row must not overflow
    // the sidebar (which would push the action buttons off-screen to the right).
    const fits = await page.evaluate(() => {
      // `document` here is the Prisma fixture in the enclosing scope, not the DOM
      // global — go through `window` so TypeScript resolves the browser document.
      const inner = window.document.querySelector(".doc-outline-inner") as HTMLElement | null;
      const actionsEl = window.document.querySelector(".doc-tab-actions");
      if (!inner || !actionsEl) return null;
      const innerRect = inner.getBoundingClientRect();
      const actionsRect = actionsEl.getBoundingClientRect();
      return {
        noHorizontalOverflow: inner.scrollWidth <= inner.clientWidth + 1,
        actionsWithinSidebar: actionsRect.right <= innerRect.right + 1 && actionsRect.left >= innerRect.left - 1
      };
    });
    expect(fits?.noHorizontalOverflow).toBe(true);
    expect(fits?.actionsWithinSidebar).toBe(true);
  } finally {
    await context.close();
    await cleanupFixture(user.id, document.id);
  }
});
