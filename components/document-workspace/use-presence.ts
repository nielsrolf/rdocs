import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { Editor } from "@tiptap/react";

import { buildPresenceSelection } from "./collaboration";
import { createTrailingThrottle } from "./render-coalescing";

const PRESENCE_THROTTLE_MS = 120;

// Owns outbound presence: posts the local selection to the presence endpoint,
// throttled to one post per PRESENCE_THROTTLE_MS unless `immediate`.
//
// The payload is built when the post goes out, NOT when sendPresence is called.
// It used to be built on the first call of a window and every later call in
// that window was dropped — so the END state of a quick drag or a burst of
// Shift+Arrow presses never reached the other tabs, and their view of the
// selection "stayed wrong" until the next move (2026-11-07 report).
export function usePresence(params: {
  editor: Editor | null;
  documentId: string;
  shareToken: string | null;
  userName: string;
  clientIdRef: MutableRefObject<string>;
  colorRef: MutableRefObject<string>;
}) {
  const { editor, documentId, shareToken, userName, clientIdRef, colorRef } = params;
  const typingRef = useRef(false);
  const postRef = useRef<() => void>(() => undefined);
  const throttleRef = useRef<ReturnType<typeof createTrailingThrottle> | null>(null);
  if (!throttleRef.current) {
    throttleRef.current = createTrailingThrottle(() => postRef.current(), PRESENCE_THROTTLE_MS);
  }

  postRef.current = () => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    const payload = {
      clientId: clientIdRef.current,
      userName: userName || "Guest",
      color: colorRef.current,
      selection: buildPresenceSelection(editor.state),
      typing: typingRef.current,
      shareToken
    };
    void fetch(`/api/documents/${documentId}/collaboration/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => undefined);
  };

  function sendPresence(typing: boolean, immediate = false) {
    if (!editor) {
      return;
    }
    typingRef.current = typing;
    if (immediate) {
      throttleRef.current?.cancel();
      postRef.current();
      return;
    }
    throttleRef.current?.schedule();
  }

  // Drop any pending post on unmount.
  useEffect(() => {
    const throttle = throttleRef.current;
    return () => throttle?.cancel();
  }, []);

  return { sendPresence };
}
