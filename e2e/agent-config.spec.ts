import { expect, test } from "@playwright/test";

import { db } from "../lib/db";
import { authenticate, cleanupFixture, createDocumentFixture, editor } from "./helpers";

// Per-document agent config: editors can pick the model + thinking effort from
// the Agents panel, and the choice persists to the document row.
test("agent model + thinking effort can be configured and persist", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { user, document } = await createDocumentFixture("hello world");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toBeVisible();

    // Open the Agents panel.
    await page.getByRole("button", { name: /^Agents/ }).click();

    const modelSelect = page.locator(".agent-config-select").first();
    const effortSelect = page.locator(".agent-config-select").nth(1);

    // Defaults reflect the unconfigured document.
    await expect(modelSelect).toHaveValue("sonnet");
    await expect(effortSelect).toHaveValue("off");

    // Change both and wait for the PATCH to land (save indicator returns to Saved).
    await modelSelect.selectOption("opus");
    await effortSelect.selectOption("high");

    await expect
      .poll(async () => {
        const row = await db.document.findUnique({
          where: { id: document.id },
          select: { agentModel: true, agentEffort: true }
        });
        return `${row?.agentModel}:${row?.agentEffort}`;
      })
      .toBe("opus:high");

    // The choice survives a reload (server round-trips it back into the UI).
    await page.reload();
    await expect(editor(page)).toBeVisible();
    await page.getByRole("button", { name: /^Agents/ }).click();
    await expect(page.locator(".agent-config-select").first()).toHaveValue("opus");
    await expect(page.locator(".agent-config-select").nth(1)).toHaveValue("high");
  } finally {
    await context.close();
    await cleanupFixture(user.id, document.id);
  }
});

// A viewer (no edit access) sees the config but cannot change it.
test("agent config selectors are disabled without edit access", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { user, document, shareLink } = await createDocumentFixture("hello world");
  // Downgrade the share link to view-only and visit as an anonymous viewer.
  await db.shareLink.update({ where: { id: shareLink.id }, data: { permission: "COMMENT" } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}?share=${shareLink.token}`);
    await expect(editor(page)).toBeVisible();
    await page.getByRole("button", { name: /^Agents/ }).click();
    await expect(page.locator(".agent-config-select").first()).toBeDisabled();
    await expect(page.locator(".agent-config-select").nth(1)).toBeDisabled();
  } finally {
    await context.close();
    await cleanupFixture(user.id, document.id);
  }
});
