"use client";

import { useEffect } from "react";

// Every redeploy rebuilds .next with new content-hashed chunk names, so a tab
// that loaded the app before the deploy asks for chunks that no longer exist
// (ChunkLoadError / failed dynamic import) on its next client-side navigation.
// A full reload fetches fresh HTML that references the current build — do that
// automatically, at most once per minute so a genuinely broken deploy can't
// put the browser in a reload loop.

const RELOAD_STAMP_KEY = "rdocs-chunk-reload-at";
const MIN_RELOAD_INTERVAL_MS = 60_000;

function isChunkLoadError(value: unknown): boolean {
  if (!value) return false;
  const err = value as { name?: string; message?: string };
  if (err.name === "ChunkLoadError") return true;
  const message = typeof value === "string" ? value : err.message ?? "";
  return /Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(
    message
  );
}

function reloadOnce() {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_STAMP_KEY) ?? 0);
    if (Date.now() - last < MIN_RELOAD_INTERVAL_MS) return;
    window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable — still better to reload than to stay broken.
  }
  window.location.reload();
}

export function ChunkReloadRecovery() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) {
        event.preventDefault();
        reloadOnce();
      }
    };
    const onError = (event: ErrorEvent) => {
      if (isChunkLoadError(event.error ?? event.message)) {
        reloadOnce();
      }
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  return null;
}
