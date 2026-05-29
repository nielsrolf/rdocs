import { expect, test } from "@playwright/test";

import { authenticate, cleanupFixture, createTabbedDocumentFixture, editor } from "./helpers";

// On small screens the outline (which normally hosts tab navigation) is hidden,
// so tabbed documents were unusable. A mobile tab strip surfaces the tabs.
test("tabs are navigable on a small screen via the mobile tab strip", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { user, document } = await createTabbedDocumentFixture();
  const context = await browser.newContext({ viewport: { width: 800, height: 900 } });
  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toBeVisible();

    const strip = page.locator(".mobile-tab-strip");
    await expect(strip).toBeVisible();
    await expect(strip.getByRole("button", { name: "Tab One" })).toBeVisible();
    await expect(strip.getByRole("button", { name: "Tab Two" })).toBeVisible();

    // Tab One is active initially; switching activates Tab Two.
    await strip.getByRole("button", { name: "Tab Two" }).click();
    await expect(page.locator(".mobile-tab-chip-active")).toHaveText("Tab Two");

    await context.close();
  } finally {
    await cleanupFixture(user.id, document.id);
  }
});
