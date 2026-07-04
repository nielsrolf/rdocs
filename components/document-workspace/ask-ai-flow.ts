// Ordering contract for the "Ask AI" button on a comment thread: a typed but
// unsent reply draft is usually what the user wants Claude to respond to, so
// it must be posted — and must succeed — before the AI run starts. A failed
// reply aborts the AI run so the agent never answers a thread that is missing
// the user's latest message.
export async function submitPendingReplyThenAskAi({
  draft,
  sendReply,
  askAi
}: {
  draft: string;
  sendReply: () => Promise<boolean>;
  askAi: () => Promise<void>;
}): Promise<"asked" | "reply-failed"> {
  if (draft.trim().length > 0) {
    const sent = await sendReply();
    if (!sent) {
      return "reply-failed";
    }
  }
  await askAi();
  return "asked";
}
