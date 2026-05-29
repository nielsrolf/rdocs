import { useEffect } from "react";
import type { MutableRefObject } from "react";
import type { Editor } from "@tiptap/react";

import type { CollaborationStepResponse, RemotePresenceView } from "./collaboration";
import type { CommentView, ThreadView } from "./types";

// Owns the live collaboration transport for a document: the SSE EventSource
// (steps + thread/comment events + presence) and the fallback polling that only
// runs while the stream is unhealthy. Extracted from DocumentWorkspace to keep
// that component focused; behavior is unchanged (same effect, same deps).
export function useCollaborationStream(params: {
  documentId: string;
  editor: Editor | null;
  shareToken: string | null;
  collabClientIdRef: MutableRefObject<string>;
  lastSseAtRef: MutableRefObject<number>;
  applyCollaborationPayload: (payload: CollaborationStepResponse) => boolean;
  pullCollaborationSteps: () => Promise<void> | void;
  sendPresence: (typing: boolean, immediate?: boolean) => void;
  setThreads: (updater: (current: ThreadView[]) => ThreadView[]) => void;
  setDocumentUpdatedAt: (value: string) => void;
  setRemotePresence: (next: RemotePresenceView[]) => void;
  setRemoteNotice: (value: string | null) => void;
}) {
  const {
    documentId,
    editor,
    shareToken,
    collabClientIdRef,
    lastSseAtRef,
    applyCollaborationPayload,
    pullCollaborationSteps,
    sendPresence,
    setThreads,
    setDocumentUpdatedAt,
    setRemotePresence,
    setRemoteNotice
  } = params;

  useEffect(() => {
    if (!editor) {
      return;
    }

    const shareQuery = shareToken ? `&share=${encodeURIComponent(shareToken)}` : "";
    const stream = new EventSource(
      `/api/documents/${documentId}/collaboration/stream?clientId=${encodeURIComponent(
        collabClientIdRef.current
      )}${shareQuery}`
    );

    // Stream is considered healthy for SSE_HEALTHY_WINDOW_MS after any event.
    // The server pings every 15s, so a window above that means "any received
    // message keeps it healthy"; only a real stall (or onerror) reopens polling.
    const SSE_HEALTHY_WINDOW_MS = 20_000;
    const markSse = () => {
      lastSseAtRef.current = Date.now();
    };
    const sseHealthy = () => Date.now() - lastSseAtRef.current < SSE_HEALTHY_WINDOW_MS;
    stream.addEventListener("ping", markSse);

    stream.addEventListener("steps", (event) => {
      markSse();
      const payload = JSON.parse((event as MessageEvent).data) as CollaborationStepResponse;
      applyCollaborationPayload(payload);
    });

    // Live thread sync — server broadcasts comment-create/reply/update/delete
    // so collaborators see new comments without reloading.
    stream.addEventListener("thread-created", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        thread: ThreadView;
        updatedAt?: string | null;
      };
      if (!payload?.thread?.id) return;
      setThreads((current) =>
        current.some((t) => t.id === payload.thread.id) ? current : [payload.thread, ...current]
      );
      if (typeof payload.updatedAt === "string") {
        setDocumentUpdatedAt(payload.updatedAt);
      }
    });

    stream.addEventListener("thread-updated", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { thread: ThreadView };
      if (!payload?.thread?.id) return;
      setThreads((current) =>
        current.map((t) => (t.id === payload.thread.id ? { ...t, ...payload.thread } : t))
      );
    });

    stream.addEventListener("thread-deleted", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { threadId: string };
      if (!payload?.threadId) return;
      setThreads((current) => current.filter((t) => t.id !== payload.threadId));
    });

    stream.addEventListener("comment-created", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        threadId: string;
        comment: CommentView;
      };
      if (!payload?.threadId || !payload?.comment?.id) return;
      setThreads((current) =>
        current.map((t) =>
          t.id === payload.threadId
            ? t.comments.some((c) => c.id === payload.comment.id)
              ? t
              : { ...t, comments: [...t.comments, payload.comment] }
            : t
        )
      );
    });

    stream.addEventListener("comment-updated", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        threadId: string;
        comment: CommentView;
      };
      if (!payload?.threadId || !payload?.comment?.id) return;
      setThreads((current) =>
        current.map((t) =>
          t.id === payload.threadId
            ? {
                ...t,
                comments: t.comments.map((c) => (c.id === payload.comment.id ? payload.comment : c))
              }
            : t
        )
      );
    });

    stream.addEventListener("comment-deleted", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        threadId: string;
        commentId: string;
      };
      if (!payload?.threadId || !payload?.commentId) return;
      setThreads((current) =>
        current.map((t) =>
          t.id === payload.threadId
            ? { ...t, comments: t.comments.filter((c) => c.id !== payload.commentId) }
            : t
        )
      );
    });

    const handlePresence = (event: Event) => {
      markSse();
      const payload = JSON.parse((event as MessageEvent).data) as { presence?: RemotePresenceView[] };
      const nextPresence = Array.isArray(payload.presence) ? payload.presence : [];
      setRemotePresence(nextPresence.filter((presence) => presence.clientId !== collabClientIdRef.current));
    };

    stream.addEventListener("presence", handlePresence);
    stream.addEventListener("ready", handlePresence);
    stream.onerror = () => {
      // Stream dropped — force the polling fallback back on until it recovers.
      lastSseAtRef.current = 0;
      setRemoteNotice("Reconnecting live collaboration...");
    };
    sendPresence(false, true);
    // Poll only as a fallback: while the SSE stream is healthy the server pushes
    // steps/presence, so these polls are skipped (no network hit). They resume
    // within 500ms of a stream stall or onerror.
    const stepPull = window.setInterval(() => {
      if (sseHealthy()) return;
      void pullCollaborationSteps();
    }, 500);
    const presencePoll = window.setInterval(async () => {
      if (sseHealthy()) return;
      const presenceShareQuery = shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";
      const response = await fetch(
        `/api/documents/${documentId}/collaboration/presence${presenceShareQuery}`,
        { cache: "no-store" }
      ).catch(() => null);
      const data = await response?.json().catch(() => null);
      const nextPresence: RemotePresenceView[] = Array.isArray(data?.presence) ? data.presence : [];
      setRemotePresence(nextPresence.filter((presence) => presence.clientId !== collabClientIdRef.current));
    }, 500);

    return () => {
      window.clearInterval(stepPull);
      window.clearInterval(presencePoll);
      stream.close();
      void fetch(`/api/documents/${documentId}/collaboration/presence`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          clientId: collabClientIdRef.current,
          shareToken
        })
      }).catch(() => undefined);
    };
  }, [documentId, editor, shareToken]);
}
