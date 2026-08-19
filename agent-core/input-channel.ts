// Live user-message injection into a RUNNING agent turn.
//
// The Claude Agent SDK is driven in streaming-input mode: `query({ prompt })`
// takes an AsyncIterable of user messages. Historically agent-core yielded
// exactly one message and closed the iterator, so a message that arrived while
// the agent was working could only become a NEW chained run afterwards (the
// Slack ⏳ queue). An AgentInputChannel keeps that iterator open for the
// lifetime of the turn, so the host can push additional user messages that the
// harness picks up at the next turn boundary — the same behavior as typing into
// the Claude Code CLI while it works.
//
// Lifecycle: the channel is closed (a) when the agent submits its structured
// response, (b) when the turn's result frame arrives, or (c) in the run's
// finally. After close, push() returns false and the caller must fall back to
// queueing a follow-up run — never silently drop the message.

export type AgentInputChannel = {
  /** Queue a user message for the running turn. False when already closed. */
  push(text: string): boolean;
  /** Stop accepting messages; the iterator ends once the queue drains. */
  close(): void;
  isClosed(): boolean;
  /** Messages accepted but not yet handed to the SDK. */
  pendingCount(): number;
  [Symbol.asyncIterator](): AsyncIterator<string>;
};

export function createAgentInputChannel(): AgentInputChannel {
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  return {
    push(text: string) {
      if (closed) return false;
      const trimmed = typeof text === "string" ? text : String(text);
      if (!trimmed) return false;
      queue.push(trimmed);
      notify();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      notify();
    },
    isClosed() {
      return closed;
    },
    pendingCount() {
      return queue.length;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) {
          yield queue.shift() as string;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
  };
}
