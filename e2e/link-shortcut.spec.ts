import { expect, test } from "@playwright/test";

import { authenticate, cleanupFixture, createDocumentFixture, editor, selectFirstParagraph } from "./helpers";

// Regression: LinkShortcut was configured during the first React render with
// a callback that closed over `editor === null`. The keymap consumed Mod-K but
// the callback silently returned, so no link prompt appeared.
test("Mod-K opens the link prompt and applies the URL to selected text", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const fixture = await createDocumentFixture("select me");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await authenticate(context, baseURL, fixture.user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${fixture.document.id}`);
    await editor(page).waitFor({ state: "visible" });
    await selectFirstParagraph(page);
    await expect(editor(page)).toBeFocused();
    await page.waitForTimeout(300);

    page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("prompt");
      await dialog.accept("https://example.com/paper");
    });
    await page.keyboard.press("Control+k");

    await expect(editor(page).locator('a[href="https://example.com/paper"]')).toHaveText("select me");
  } finally {
    await context.close();
    await cleanupFixture(fixture.user.id, fixture.document.id);
  }
});
