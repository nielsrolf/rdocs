import { expect, test, type Frame } from "@playwright/test";

// ChunkReloadRecovery (root layout) reloads the page once when a stale tab
// hits a missing post-deploy chunk, and rate-limits so a broken deploy can't
// reload-loop. Simulated via the same signal Next emits: an unhandled promise
// rejection whose error is a ChunkLoadError.

function fireChunkError() {
  const err = new Error("Loading chunk 5105 failed.");
  err.name = "ChunkLoadError";
  Promise.reject(err);
}

test("a ChunkLoadError triggers exactly one rate-limited reload", async ({ page }) => {
  await page.goto("/sign-in");
  await page.waitForLoadState("load");

  const firstReload = page.waitForEvent("framenavigated", {
    predicate: (frame: Frame) => frame === page.mainFrame(),
    timeout: 5000
  });
  await page.evaluate(fireChunkError);
  await firstReload;

  // Let the reload fully settle so its own navigation events can't leak into
  // the second observation window.
  await page.waitForLoadState("load");
  await page.waitForTimeout(500);

  const stamp = await page.evaluate(() => window.sessionStorage.getItem("rdocs-chunk-reload-at"));
  expect(Number(stamp)).toBeGreaterThan(0);

  // A second error inside the rate-limit window must not navigate again.
  let navigatedAgain = false;
  const listener = (frame: Frame) => {
    if (frame === page.mainFrame()) navigatedAgain = true;
  };
  page.on("framenavigated", listener);
  await page.evaluate(fireChunkError);
  await page.waitForTimeout(1500);
  page.off("framenavigated", listener);
  expect(navigatedAgain).toBe(false);
});
