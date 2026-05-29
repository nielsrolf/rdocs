import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { getVersion } from "@tiptap/pm/collab";
import type { Editor } from "@tiptap/react";

// Owns outbound presence: builds the local selection payload and posts it to the
// presence endpoint, debounced (120ms) unless `immediate`. Extracted from
// DocumentWorkspace; the shared client-id/color refs stay in the component
// because many other call sites use them, so they're passed in here.
export function usePresence(params: {
  editor: Editor | null;
  documentId: string;
  shareToken: string | null;
  userName: string;
  clientIdRef: MutableRefObject<string>;
  colorRef: MutableRefObject<string>;
}) {
  const { editor, documentId, shareToken, userName, clientIdRef, colorRef } = params;
  const presenceTimerRef = useRef<number | null>(null);

  function getPresenceSelection() {
    if (!editor) {
      return null;
    }
    const { anchor, head, from, to } = editor.state.selection;
    return { anchor, head, from, to, version: getVersion(editor.state) };
  }

  function sendPresence(typing: boolean, immediate = false) {
    if (!editor) {
      return;
    }

    const payload = {
      clientId: clientIdRef.current,
      userName: userName || "Guest",
      color: colorRef.current,
      selection: getPresenceSelection(),
      typing,
      shareToken
    };

    const postPresence = () => {
      void fetch(`/api/documents/${documentId}/collaboration/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(() => undefined);
    };

    if (immediate) {
      if (presenceTimerRef.current) {
        window.clearTimeout(presenceTimerRef.current);
        presenceTimerRef.current = null;
      }
      postPresence();
      return;
    }

    if (presenceTimerRef.current) {
      return;
    }

    presenceTimerRef.current = window.setTimeout(() => {
      presenceTimerRef.current = null;
      postPresence();
    }, 120);
  }

  // Clear any pending debounced post on unmount.
  useEffect(() => {
    return () => {
      if (presenceTimerRef.current) {
        window.clearTimeout(presenceTimerRef.current);
      }
    };
  }, []);

  return { sendPresence };
}
