import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { authenticate, cleanupFixture, createDocumentFixture, editor, placeCursorAtStart } from "./helpers";

// User report (2026-11-07), two tabs on one document:
//  1. "when the other person types, their cursor jumps around a bit"
//  2. "the names of the cursors are often in the way — only show them initially
//     for one second, and on hover"
//  3. "text I selected in one tab is sometimes displayed wrong on the other tab
//     and stays wrong"

const TEXT = "alpha beta gamma";

async function openPair(browser: import("@playwright/test").Browser, baseURL: string) {
  const fixture = await createDocumentFixture(TEXT);
  const ownerContext = await browser.newContext();
  await authenticate(ownerContext, baseURL, fixture.user.id);
  const guestContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const guest = await guestContext.newPage();
  await Promise.all([
    owner.goto(`/documents/${fixture.document.id}`),
    guest.goto(`/documents/${fixture.document.id}?share=${fixture.shareLink.token}`)
  ]);
  await expect.poll(() => docText(owner), { timeout: 10_000 }).toBe(TEXT);
  await expect.poll(() => docText(guest), { timeout: 10_000 }).toBe(TEXT);
  return { fixture, contexts: [ownerContext, guestContext] as BrowserContext[], owner, guest };
}

// Document text without remote-cursor widgets (their name labels live in the DOM).
async function docText(page: Page) {
  return editor(page).evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".remote-collab-cursor").forEach((cursor) => cursor.remove());
    return clone.textContent ?? "";
  });
}

async function guestTextBeforeCaret(page: Page) {
  return page.evaluate(() => {
    const dom = document.querySelector(".ProseMirror") as HTMLElement & {
      editor?: { state: { selection: { head: number }; doc: { textBetween: (from: number, to: number) => string } } };
    };
    const state = dom.editor?.state;
    return state ? state.doc.textBetween(1, state.selection.head) : null;
  });
}

// Text of the first paragraph split at the remote cursor (label text excluded).
async function splitAtRemoteCursor(page: Page) {
  return page.evaluate(() => {
    const paragraph = document.querySelector(".ProseMirror p");
    const cursor = paragraph?.querySelector(".remote-collab-cursor");
    if (!paragraph || !cursor) return null;
    const before = document.createRange();
    before.setStart(paragraph, 0);
    before.setEndBefore(cursor);
    const after = document.createRange();
    after.setStartAfter(cursor);
    after.setEnd(paragraph, paragraph.childNodes.length);
    return { before: before.toString(), after: after.toString() };
  });
}

test("a typing collaborator's cursor stays right after their text and never jumps ahead", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { fixture, contexts, owner, guest } = await openPair(browser, baseURL);
  try {
    // Guest puts the caret after "alpha" (position 6) through the editor API —
    // simulated arrow presses race the DOM->ProseMirror selection sync.
    await editor(guest).click();
    await guest.evaluate(() => {
      const dom = document.querySelector(".ProseMirror") as HTMLElement & {
        editor?: { commands: { focus: (pos: number) => boolean } };
      };
      dom.editor?.commands.focus(6);
    });
    expect(await guestTextBeforeCaret(guest)).toBe("alpha");
    await expect.poll(async () => (await splitAtRemoteCursor(owner))?.before, { timeout: 8_000 }).toBe("alpha");

    // Sample the owner's view continuously while the guest types.
    await owner.evaluate(() => {
      const w = window as unknown as { __samples: Array<{ before: string; after: string }>; __stop: boolean };
      w.__samples = [];
      w.__stop = false;
      const tick = () => {
        const paragraph = document.querySelector(".ProseMirror p");
        const cursor = paragraph?.querySelector(".remote-collab-cursor");
        if (paragraph && cursor) {
          const before = document.createRange();
          before.setStart(paragraph, 0);
          before.setEndBefore(cursor);
          const after = document.createRange();
          after.setStartAfter(cursor);
          after.setEnd(paragraph, paragraph.childNodes.length);
          w.__samples.push({ before: before.toString(), after: after.toString() });
        }
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await guest.keyboard.type("XYZXYZXYZ", { delay: 70 });
    await expect.poll(async () => (await splitAtRemoteCursor(owner))?.before, { timeout: 8_000 }).toBe(
      "alphaXYZXYZXYZ"
    );
    await owner.waitForTimeout(500);

    const samples = await owner.evaluate(() => {
      const w = window as unknown as { __samples: Array<{ before: string; after: string }>; __stop: boolean };
      w.__stop = true;
      return w.__samples;
    });
    // The cursor must always sit exactly between the typed text and " beta":
    // anything else is the cursor drawn ahead of / behind text on screen.
    const wrong = samples.filter((sample) => !sample.after.startsWith(" beta"));
    console.log(`[remote-cursor] ${samples.length} samples, ${wrong.length} misplaced`, wrong.slice(0, 5));
    expect(samples.length).toBeGreaterThan(20);
    expect(wrong).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    await cleanupFixture(fixture.user.id, fixture.document.id);
  }
});

test("a quick keyboard selection shows up on the other tab with its FINAL extent", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { fixture, contexts, owner, guest } = await openPair(browser, baseURL);
  try {
    await placeCursorAtStart(guest);
    await guest.waitForTimeout(300);
    // Eight quick presses: all land inside one presence-throttle window.
    for (let i = 0; i < 8; i += 1) await guest.keyboard.press("Shift+ArrowRight");
    expect(await guest.evaluate(() => window.getSelection()?.toString())).toBe("alpha be");

    await owner.waitForTimeout(1500);
    const shown = await owner.evaluate(() =>
      Array.from(document.querySelectorAll(".remote-collab-selection"))
        .map((element) => element.textContent ?? "")
        .join("")
    );
    expect(shown).toBe("alpha be");
  } finally {
    for (const context of contexts) await context.close();
    await cleanupFixture(fixture.user.id, fixture.document.id);
  }
});

test("a remote cursor's name shows briefly, then only on hover", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { fixture, contexts, owner, guest } = await openPair(browser, baseURL);
  try {
    await placeCursorAtStart(guest);
    await guest.keyboard.press("ArrowRight");
    const label = owner.locator(".remote-collab-cursor-label").first();
    await expect(label).toBeAttached({ timeout: 8_000 });

    const opacity = () => label.evaluate((element) => Number(getComputedStyle(element).opacity));
    await expect.poll(opacity, { timeout: 2_000 }).toBeGreaterThan(0.5); // shown on arrival
    await expect.poll(opacity, { timeout: 4_000 }).toBeLessThan(0.1); // then gets out of the way

    // Keep the owner's own caret away from the label so the "covers caret" rule doesn't interfere.
    await owner.locator(".remote-collab-cursor").first().hover();
    await expect.poll(opacity, { timeout: 2_000 }).toBeGreaterThan(0.5);
  } finally {
    for (const context of contexts) await context.close();
    await cleanupFixture(fixture.user.id, fixture.document.id);
  }
});
