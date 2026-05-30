import { expect, test } from "@playwright/test";

import { db } from "../lib/db";
import { authenticate, cleanupFixture, createDocumentFixture, editor } from "./helpers";

test("an editor can add, mask, and delete document environment variables via the UI", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { user, document } = await createDocumentFixture("env doc");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await authenticate(context, baseURL, user.id);
    const page = await context.newPage();
    await page.goto(`/documents/${document.id}`);
    await expect(editor(page)).toBeVisible();

    await page.locator(".header-menu-env summary").click();
    const panel = page.locator(".env-panel");
    await expect(panel).toBeVisible();

    await panel.getByLabel("Variable name").fill("OPENAI_API_KEY");
    await panel.getByLabel("Variable value").fill("supersecretvalue123");
    await panel.getByRole("button", { name: "Add" }).click();

    // The value is shown masked, never in full.
    const row = panel.locator(".env-var-row", { hasText: "OPENAI_API_KEY" });
    await expect(row).toBeVisible();
    await expect(row.locator(".env-var-value")).toHaveText("sup*****123");
    await expect(panel).not.toContainText("supersecretvalue123");

    // The full value is persisted server-side for the agent.
    await expect
      .poll(async () => {
        const stored = await db.documentEnvVar.findUnique({
          where: { documentId_key: { documentId: document.id, key: "OPENAI_API_KEY" } },
          select: { value: true }
        });
        return stored?.value ?? null;
      })
      .toBe("supersecretvalue123");

    // Delete removes it.
    await row.getByRole("button", { name: "Delete OPENAI_API_KEY" }).click();
    await expect(panel.locator(".env-var-row")).toHaveCount(0);
  } finally {
    await context.close();
    await cleanupFixture(user.id, document.id);
  }
});

test("environment variables are isolated per document and gated to editors", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const a = await createDocumentFixture("doc A");
  const b = await createDocumentFixture("doc B");
  // Seed a secret on doc A only.
  await db.documentEnvVar.create({
    data: { documentId: a.document.id, key: "DOC_A_SECRET", value: "alpha-value-1234" }
  });

  const context = await browser.newContext();
  try {
    await authenticate(context, baseURL, a.user.id);

    // Doc A (owner = editor) sees its var, masked.
    const aRes = await context.request.get(`/api/documents/${a.document.id}/environment`);
    expect(aRes.status()).toBe(200);
    const aBody = await aRes.json();
    expect(aBody.vars).toHaveLength(1);
    expect(aBody.vars[0]).toMatchObject({ key: "DOC_A_SECRET", masked: "alp*****234" });
    expect(JSON.stringify(aBody)).not.toContain("alpha-value-1234");

    // A different document does not see doc A's variables.
    await authenticate(context, baseURL, b.user.id);
    const bRes = await context.request.get(`/api/documents/${b.document.id}/environment`);
    expect(bRes.status()).toBe(200);
    expect((await bRes.json()).vars).toHaveLength(0);

    // A comment-only viewer (no edit access) is forbidden from reading or writing env.
    await db.shareLink.update({ where: { id: a.shareLink.id }, data: { permission: "COMMENT" } });
    const viewerContext = await browser.newContext();
    try {
      const readAsViewer = await viewerContext.request.get(
        `/api/documents/${a.document.id}/environment?share=${a.shareLink.token}`
      );
      expect(readAsViewer.status()).toBe(403);
      const writeAsViewer = await viewerContext.request.post(
        `/api/documents/${a.document.id}/environment`,
        { data: { key: "EVIL", value: "x", shareToken: a.shareLink.token } }
      );
      expect(writeAsViewer.status()).toBe(403);
    } finally {
      await viewerContext.close();
    }

    // The injected secret never wrote anything for the viewer's doc.
    const evil = await db.documentEnvVar.findFirst({ where: { key: "EVIL" } });
    expect(evil).toBeNull();
  } finally {
    await context.close();
    await cleanupFixture(a.user.id, a.document.id);
    await cleanupFixture(b.user.id, b.document.id);
  }
});
