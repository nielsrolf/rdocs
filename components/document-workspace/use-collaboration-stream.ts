import { useEffect } from "react";
import type { MutableRefObject } from "react";
import type { Editor } from "@tiptap/react";

import { aggregateReactions, type RawReaction } from "@/lib/reactions";

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
  currentUserId: string | null;
  collabClientIdRef: MutableRefObject<string>;
  lastSseAtRef: MutableRefObject<number>;
  applyCollaborationPayload: (payload: CollaborationStepResponse) => boolean;
  pullCollaborationSteps: () => Promise<void> | void;
  // Called when a live "steps" event can't be applied (unrecoverable divergence):
  // the component decides between a sole-client force-push and a manual merge.
  onUnrecoverableDivergence: () => Promise<void> | void;
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
    currentUserId,
    collabClientIdRef,
    lastSseAtRef,
    applyCollaborationPayload,
    pullCollaborationSteps,
    onUnrecoverableDivergence,
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
      if (!applyCollaborationPayload(payload)) {
        void onUnrecoverableDivergence();
      }
    });

    // A sole-client force-push reset the room to a new version-0 baseline. The
    // collab plugin's version is fixed at editor creation, so any other tab still
    // attached to the old version can only re-seed by reloading. (The tab that
    // performed the force-push reloads itself; this covers stragglers.)
    stream.addEventListener("reset", () => {
      markSse();
      window.location.reload();
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

    // Reactions are per-user: the server sends the raw rows and each client
    // recomputes "reactedByMe" against its own viewer.
    stream.addEventListener("comment-reaction", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        threadId: string;
        commentId: string;
        reactions: RawReaction[];
      };
      if (!payload?.threadId || !payload?.commentId) return;
      const summary = aggregateReactions(payload.reactions ?? [], currentUserId);
      setThreads((current) =>
        current.map((t) =>
          t.id === payload.threadId
            ? {
                ...t,
                comments: t.comments.map((c) =>
                  c.id === payload.commentId ? { ...c, reactions: summary } : c
                )
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

    // Catch up the backlog once on connect. The SSE room streams only FUTURE
    // steps (the "ready" event carries the current version but no backlog), and
    // the fallback poll below runs only while the stream is UNHEALTHY. Without
    // this pull, an editor seeded from a stale SSR snapshot never converges:
    // soft-navigating back to a document you edited earlier replays Next.js's
    // cached RSC payload, re-seeding the editor at the pre-edit content+version,
    // and it would stay stale until a hard refresh or a fresh edit. A pull from
    // the seeded version fetches exactly the missed steps; it's a no-op when the
    // seed is already current (applyCollaborationPayload ignores a stale
    // fromVersion), and is safe to race with the stream (same version guard).
    void pullCollaborationSteps();

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
