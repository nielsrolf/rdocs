import { expect, test } from "@playwright/test";

import { db } from "../lib/db";
import { authenticate, cleanupFixture, editor } from "./helpers";

// The tour spans dashboard → document and advances on app events. The steps
// that require live AI runs / GitHub access advance via the same event bus the
// real handlers use, so this exercises the state machine, anchors, starter
// content, and persistence without external dependencies.

async function createEmptyUser() {
  return db.user.create({
    data: {
      email: `e2e-tour-${crypto.randomUUID()}@example.com`,
      name: "Tour User",
      passwordHash: "not-used"
    }
  });
}

function fireTourEvent(name: string) {
  return `window.dispatchEvent(new CustomEvent("rdocs-tour-event", { detail: "${name}" }))`;
}

test("onboarding tour walks from dashboard through the document steps", async ({
  page,
  context,
  baseURL
}) => {
  const user = await createEmptyUser();
  let documentId: string | null = null;

  try {
    await authenticate(context, baseURL!, user.id);
    await page.goto("/dashboard");

    // Fresh user with zero documents → the offer card shows.
    const offer = page.getByRole("dialog", { name: "Take the tour" });
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "Start the tour" }).click();

    // Step 1's primary button creates the document (it must never just
    // advance the tour without creating one).
    await expect(page.getByText("Step 1 of 10")).toBeVisible();
    await page.getByRole("button", { name: "Create document" }).click();

    // Crossing into the document advances to the title step.
    await expect(page.getByText("Step 2 of 10")).toBeVisible();
    await page.getByLabel("Document title").fill("How to use r-docs");
    await page.getByRole("button", { name: "Next" }).click();

    // Headings step offers starter content; inserting it fills the editor.
    // The editor is a tall anchor, so the tooltip docks — and must be fully
    // inside the viewport (it used to run off the top of the screen).
    await expect(page.getByText("Step 3 of 10")).toBeVisible();
    const tooltipBox = await page.locator(".tour-tooltip").boundingBox();
    const viewport = page.viewportSize()!;
    expect(tooltipBox!.y).toBeGreaterThanOrEqual(0);
    expect(tooltipBox!.y + tooltipBox!.height).toBeLessThanOrEqual(viewport.height);
    await page.getByRole("button", { name: "Insert starter content" }).click();
    await expect(editor(page)).toContainText("How to use r-docs");
    await expect(editor(page)).toContainText("AI credentials and GitHub PAT");
    await page.getByRole("button", { name: "Next" }).click();

    // Repo step advances on the repo-linked app event.
    await expect(page.getByText("Step 4 of 10")).toBeVisible();
    await expect(page.getByText("github.com/nielsrolf/rdocs")).toBeVisible();
    await page.evaluate(fireTourEvent("repo-linked"));

    // Credentials step: connect (event) or skip — the free-qwen path is named.
    await expect(page.getByText("Step 5 of 10")).toBeVisible();
    await expect(page.getByText(/free local qwen model/)).toBeVisible();
    await page.evaluate(fireTourEvent("credential-connected"));

    // AI edit step → comment step → Ask AI step → agent step, via their events.
    await expect(page.getByText("Step 6 of 10")).toBeVisible();
    await page.evaluate(fireTourEvent("ai-edit-started"));
    await expect(page.getByText("Step 7 of 10")).toBeVisible();
    await page.evaluate(fireTourEvent("comment-created"));
    await expect(page.getByText("Step 8 of 10")).toBeVisible();
    await page.evaluate(fireTourEvent("ask-ai"));
    await expect(page.getByText("Step 9 of 10")).toBeVisible();
    await page.evaluate(fireTourEvent("agent-run-started"));

    // Final step → Finish persists completion.
    await expect(page.getByText("Step 10 of 10")).toBeVisible();
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.getByText("Step 10 of 10")).not.toBeVisible();

    const stored = await page.evaluate(() => window.localStorage.getItem("rdocs-tour-v1"));
    expect(stored).toContain("completedAt");

    // Back on the dashboard the offer must not reappear.
    await page.goto("/dashboard");
    await expect(page.getByRole("dialog", { name: "Take the tour" })).not.toBeVisible();

    documentId = new URL(page.url()).pathname.split("/").pop() ?? null;
  } finally {
    const doc = await db.document.findFirst({ where: { ownerId: user.id }, select: { id: true } });
    await cleanupFixture(user.id, documentId ?? doc?.id ?? "");
  }
});

test("tour offer can be dismissed and stays dismissed", async ({ page, context, baseURL }) => {
  const user = await createEmptyUser();
  try {
    await authenticate(context, baseURL!, user.id);
    await page.goto("/dashboard");
    const offer = page.getByRole("dialog", { name: "Take the tour" });
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "No thanks" }).click();
    await expect(offer).not.toBeVisible();

    await page.reload();
    await expect(page.getByRole("dialog", { name: "Take the tour" })).not.toBeVisible();
  } finally {
    await cleanupFixture(user.id, "");
  }
});
