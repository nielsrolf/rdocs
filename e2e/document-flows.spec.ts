import { expect, test } from "@playwright/test";

import {
  authenticate,
  cleanupFixture,
  createDocumentFixture,
  editor,
  placeCursorAtStart,
  saveIndicator,
  selectFirstParagraph,
  visibleEditorText
} from "./helpers";

// End-to-end coverage of the flows that historically failed in ways unit tests
// couldn't see (they require the real editor + collab pipeline + server):
//   - typed edits persist across a reload ("saving failed / work was lost"),
//   - a comment can be created and is displayed, surviving a reload.

test("typed edits persist across a reload", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { user, document } = await createDocumentFixture("Original body text");
  const context = await browser.newContext();
  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toHaveText("Original body text");

    await placeCursorAtStart(page);
    await page.keyboard.type("PERSISTED ", { delay: 10 });

    // Wait for the collaboration flush to confirm the save.
    await expect(saveIndicator(page)).toHaveText("Saved", { timeout: 8_000 });

    await page.reload();
    await expect
      .poll(() => visibleEditorText(page), { timeout: 8_000, intervals: [100, 250, 500] })
      .toContain("PERSISTED Original body text");

    await context.close();
  } finally {
    await cleanupFixture(user.id, document.id);
  }
});

test("a comment can be created and survives a reload", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { user, document } = await createDocumentFixture("Comment me please");
  const context = await browser.newContext();
  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toHaveText("Comment me please");

    // Select the paragraph, open the comment composer, post a comment.
    await selectFirstParagraph(page);
    await page.getByRole("button", { name: "Add comment" }).click();
    await page.getByPlaceholder("Add a comment").fill("This is my comment");
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    // The comment is displayed in the rail.
    const rail = page.locator(".comment-rail");
    await expect(rail.getByText("This is my comment")).toBeVisible({ timeout: 8_000 });

    // And it survives a reload (persisted + re-displayed).
    await page.reload();
    await expect(editor(page)).toHaveText("Comment me please");
    await expect(page.locator(".comment-rail").getByText("This is my comment")).toBeVisible({
      timeout: 8_000
    });

    await context.close();
  } finally {
    await cleanupFixture(user.id, document.id);
  }
});
