// The POST half of starting an AI selection-edit run.
//
// Three call sites in document-workspace.tsx kick off `/ai-edit` (fresh edit,
// retry of a failed edit, session follow-up). They each hand-rolled the same
// request → parse → "is there an aiRunId?" dance, but their RECOVERY differs
// (drop the marker / re-arm the retry toast / roll back the optimistic run), so
// only this shared half is extracted. Callers get one normalized result and
// keep their own failure handling.

export type AiEditKickoffBody = {
  selectedText: string;
  instruction: string;
  selectionId?: string | null;
  selectedMarkdown?: string | null;
  selectedContext?: string | null;
  parentRunId?: string | null;
  shareToken?: string | null;
  suggest?: boolean;
};

export type AiEditKickoffResult =
  | { ok: true; aiRunId: string; status: number; elapsedMs: number }
  | {
      ok: false;
      aiRunId: null;
      // Server-provided message when there was one, else a generic fallback.
      error: string;
      // null when the request itself threw (offline, aborted) rather than
      // returning a response.
      status: number | null;
      // Only set when the server answered with a string `error` field — call
      // sites log this separately from the user-facing message.
      serverError: string | null;
      threw: boolean;
      elapsedMs: number;
    };

export async function startAiEditRun(
  documentId: string,
  body: AiEditKickoffBody,
  opts: {
    fallbackError?: string;
    // Called when fetch itself rejected, so the caller can log with its own scope.
    onFetchError?: (error: unknown) => void;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<AiEditKickoffResult> {
  const startedAt = Date.now();
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(`/api/documents/${documentId}/ai-edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).catch((error) => {
    opts.onFetchError?.(error);
    return null;
  });

  const data = (await response?.json().catch(() => null)) as
    | { aiRunId?: unknown; error?: unknown }
    | null;
  const aiRunId = typeof data?.aiRunId === "string" ? data.aiRunId : null;
  const elapsedMs = Date.now() - startedAt;

  if (!response?.ok || !aiRunId) {
    const serverError = typeof data?.error === "string" ? data.error : null;
    return {
      ok: false,
      aiRunId: null,
      error: serverError ?? opts.fallbackError ?? "AI edit failed to start.",
      status: response?.status ?? null,
      serverError,
      threw: !response,
      elapsedMs
    };
  }

  return { ok: true, aiRunId, status: response.status, elapsedMs };
}
