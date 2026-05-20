import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { createSessionToken } from "../lib/auth";
import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";

const INITIAL_TEXT = "This is the original text";
const GUEST_PREFIX = "this is typed by the guest";
const OWNER_SUFFIX = "this is typed by the owner";

function documentContent(text: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }]
      }
    ]
  };
}

async function createDocumentFixture() {
  const user = await db.user.create({
    data: {
      email: `e2e-collab-${crypto.randomUUID()}@example.com`,
      name: "Niels",
      passwordHash: "not-used"
    }
  });

  const document = await db.document.create({
    data: {
      title: "Untitled document",
      content: serializeDocumentContent(documentContent(INITIAL_TEXT)),
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

  return { document, shareLink, user };
}

async function cleanupFixture(userId: string, documentId: string) {
  await db.$executeRawUnsafe("DELETE FROM CollaborationStep WHERE documentId = ?", documentId).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
}

async function authenticateOwner(context: BrowserContext, baseURL: string, userId: string) {
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

function editor(page: Page) {
  return page.locator(".ProseMirror");
}

function saveIndicator(page: Page) {
  return page.locator(".save-indicator");
}

async function placeCursorAtStart(page: Page) {
  await editor(page).evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const firstText = walker.nextNode();
    if (!firstText) {
      throw new Error("Editor has no text node");
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element as HTMLElement).focus();
  });
}

async function placeCursorAtEnd(page: Page) {
  await editor(page).evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let lastText: Node | null = null;
    let next = walker.nextNode();
    while (next) {
      lastText = next;
      next = walker.nextNode();
    }

    if (!lastText) {
      throw new Error("Editor has no text node");
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(lastText, lastText.textContent?.length ?? 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element as HTMLElement).focus();
  });
}

async function visibleEditorText(page: Page) {
  return (await editor(page).innerText()).replace(/\n+/g, "\n").trim();
}

async function expectBothEditorsToConverge(ownerPage: Page, guestPage: Page) {
  await expect
    .poll(
      async () => ({
        guest: await visibleEditorText(guestPage),
        owner: await visibleEditorText(ownerPage)
      }),
      {
        timeout: 12_000,
        intervals: [100, 250, 500]
      }
    )
    .toEqual({
      guest: `${GUEST_PREFIX}\n${INITIAL_TEXT}\n${OWNER_SUFFIX}`,
      owner: `${GUEST_PREFIX}\n${INITIAL_TEXT}\n${OWNER_SUFFIX}`
    });

  await expect(saveIndicator(ownerPage)).toHaveText("Saved", { timeout: 5_000 });
  await expect(saveIndicator(guestPage)).toHaveText("Saved", { timeout: 5_000 });
}

test("owner and guest converge after guest inserts first and owner inserts second line", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) {
    throw new Error("baseURL is required");
  }

  const { document, shareLink, user } = await createDocumentFixture();

  try {
    const ownerContext = await browser.newContext();
    await authenticateOwner(ownerContext, baseURL, user.id);
    const guestContext = await browser.newContext();

    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();

    await Promise.all([
      ownerPage.goto(`/documents/${document.id}`),
      guestPage.goto(`/documents/${document.id}?share=${shareLink.token}`)
    ]);

    await expect(editor(ownerPage)).toHaveText(INITIAL_TEXT);
    await expect(editor(guestPage)).toHaveText(INITIAL_TEXT);

    await placeCursorAtStart(guestPage);
    await guestPage.keyboard.type(GUEST_PREFIX, { delay: 10 });
    await guestPage.keyboard.press("Enter");

    await expect
      .poll(() => visibleEditorText(ownerPage), {
        timeout: 8_000,
        intervals: [100, 250, 500]
      })
      .toContain(GUEST_PREFIX);

    await placeCursorAtEnd(ownerPage);
    await ownerPage.keyboard.press("Enter");
    await ownerPage.keyboard.type(OWNER_SUFFIX, { delay: 10 });

    await expectBothEditorsToConverge(ownerPage, guestPage);

    await ownerContext.close();
    await guestContext.close();
  } finally {
    await cleanupFixture(user.id, document.id);
  }
});
