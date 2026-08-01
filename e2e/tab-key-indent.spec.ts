import { expect, test } from "@playwright/test";

import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { authenticate, cleanupFixture, editor } from "./helpers";

// Regression guard: the tab-title is rendered as an <input> inside the editor
// DOM. When ProseMirror does not consume a Tab press (e.g. sinkListItem fails
// on the first item of a list), the browser's default Tab-navigation used to
// move focus into that input — the cursor "jumped to the tab heading" instead
// of indenting. Tab/Shift-Tab must stay inside the editor: indent/outdent
// lists when possible, and be swallowed otherwise.
test("Tab indents lists and never moves focus to the tab-title input", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const user = await db.user.create({
    data: { email: `e2e-${crypto.randomUUID()}@example.com`, name: "E2E User", passwordHash: "x" }
  });
  const content = {
    type: "doc",
    content: [
      { type: "tabBreak", attrs: { tabId: "tab-one", title: "Tab One" } },
      { type: "paragraph", content: [{ type: "text", text: "plain paragraph" }] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "first item" }] }]
          },
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "second item" }] }]
          }
        ]
      }
    ]
  };
  const document = await db.document.create({
    data: { title: "Tab key document", content: serializeDocumentContent(content), ownerId: user.id }
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await editor(page).waitFor({ state: "visible" });

    // The root cause of the reported bug: the tab-title input (and its copy
    // button) sit inside the editor DOM with default tabIndex 0, so whenever
    // the editor does not consume a Tab press, browser tab-navigation moves
    // focus (the "cursor") into the tab heading. They must be excluded from
    // the tab order — still clickable, never Tab targets.
    await expect(page.locator(".tab-break-header-input")).toHaveAttribute("tabindex", "-1");
    await expect(page.locator(".tab-break-copy")).toHaveAttribute("tabindex", "-1");

    const secondItem = editor(page).locator(":text-is('second item')");
    await secondItem.click();
    // Let hydration/collab setup settle so the keypress hits the live editor.
    await expect(editor(page)).toBeFocused();
    await page.waitForTimeout(300);
    await secondItem.click();

    // Tab on a sinkable item indents it (nested bullet list appears)...
    await page.keyboard.press("Tab");
    await expect(editor(page).locator("ul ul li", { hasText: "second item" })).toHaveCount(1);
    // ...and focus stays in the editor, not on the tab-title input.
    await expect(page.locator(".tab-break-header-input")).not.toBeFocused();

    // Shift-Tab lifts it back out.
    await page.keyboard.press("Shift+Tab");
    await expect(editor(page).locator("ul ul li")).toHaveCount(0);
    await expect(page.locator(".tab-break-header-input")).not.toBeFocused();

    // Tab on the FIRST item cannot sink — it must be swallowed, not jump the
    // focus into the tab heading input (the reported bug).
    const firstItem = editor(page).locator(":text-is('first item')");
    await firstItem.click();
    await page.keyboard.press("Tab");
    await expect(page.locator(".tab-break-header-input")).not.toBeFocused();
    const focusInEditor = await page.evaluate(() => {
      const active = window.document.activeElement;
      return Boolean(active && active.closest(".ProseMirror"));
    });
    expect(focusInEditor).toBe(true);

    // Shift-Tab on a top-level item cannot lift further — backwards focus
    // navigation must not land on the tab-title input either.
    await firstItem.click();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(".tab-break-header-input")).not.toBeFocused();

    // Tab / Shift-Tab in a plain paragraph must also stay in the editor.
    const paragraph = editor(page).locator(":text-is('plain paragraph')");
    await paragraph.click();
    await page.keyboard.press("Tab");
    await expect(page.locator(".tab-break-header-input")).not.toBeFocused();
    await paragraph.click();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(".tab-break-header-input")).not.toBeFocused();
    const stillInEditor = await page.evaluate(() => {
      const active = window.document.activeElement;
      return Boolean(active && active.closest(".ProseMirror"));
    });
    expect(stillInEditor).toBe(true);
  } finally {
    await context.close();
    await cleanupFixture(user.id, document.id);
  }
});
