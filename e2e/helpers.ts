import { type BrowserContext, type Page } from "@playwright/test";

import { createSessionToken } from "../lib/auth";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

export function documentContent(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  };
}

export async function createDocumentFixture(initialText: string) {
  const user = await db.user.create({
    data: {
      email: `e2e-${crypto.randomUUID()}@example.com`,
      name: "E2E User",
      passwordHash: "not-used"
    }
  });
  const document = await db.document.create({
    data: {
      title: "Untitled document",
      content: serializeDocumentContent(documentContent(initialText)),
      ownerId: user.id
    }
  });
  const shareLink = await db.shareLink.create({
    data: {
      documentId: document.id,
      createdById: user.id,
      permission: "EDIT",
      token: crypto.randomUUID().replaceAll("-", "")
    }
  });
  return { user, document, shareLink };
}

export async function createTabbedDocumentFixture() {
  const user = await db.user.create({
    data: { email: `e2e-${crypto.randomUUID()}@example.com`, name: "E2E User", passwordHash: "not-used" }
  });
  const content = {
    type: "doc",
    content: [
      { type: "tabBreak", attrs: { tabId: "tab-one", title: "Tab One" } },
      { type: "paragraph", content: [{ type: "text", text: "first tab body" }] },
      { type: "tabBreak", attrs: { tabId: "tab-two", title: "Tab Two" } },
      { type: "paragraph", content: [{ type: "text", text: "second tab body" }] }
    ]
  };
  const document = await db.document.create({
    data: { title: "Tabbed document", content: serializeDocumentContent(content), ownerId: user.id }
  });
  return { user, document };
}

export async function cleanupFixture(userId: string, documentId: string) {
  await db.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", documentId).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

export async function authenticate(context: BrowserContext, baseURL: string, userId: string) {
  const token = await createSessionToken(userId);
  await context.addCookies([
    {
      name: "gdocs_ai_session",
      value: token,
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax"
    }
  ]);
}

export function editor(page: Page) {
  return page.locator(".ProseMirror");
}

export function saveIndicator(page: Page) {
  return page.locator(".save-indicator");
}

export async function visibleEditorText(page: Page) {
  return (await editor(page).innerText()).replace(/\n+/g, "\n").trim();
}

export async function placeCursorAtStart(page: Page) {
  await editor(page).evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const firstText = walker.nextNode();
    if (!firstText) throw new Error("Editor has no text node");
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element as HTMLElement).focus();
  });
}

// Select the first paragraph so the selection bubble / remote selection
// decoration appears. Uses the keyboard (Shift+End) so ProseMirror's selection
// state updates naturally — a raw DOM range doesn't reliably sync into PM.
export async function selectFirstParagraph(page: Page) {
  await placeCursorAtStart(page);
  await page.keyboard.press("Shift+End");
}
