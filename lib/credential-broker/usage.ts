/** Passive usage capture for brokered JSON and SSE responses. No prompts or credentials. */
export type BrokerUsage = {
  requestId: string;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  complete: boolean;
};

export function createUsageCapture(meta: Pick<BrokerUsage, "requestId" | "provider" | "costUsd">) {
  let pending = "";
  let sawUsage = false;
  let jsonBody: boolean | undefined;
  const usage: BrokerUsage = { ...meta, model: null, inputTokens: 0, outputTokens: 0,
    cachedInputTokens: 0, cacheWriteTokens: 0, complete: false };
  const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const parse = (line: string) => {
    const raw = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const frame = JSON.parse(raw);
      for (const value of [frame, frame.message, frame.response]) {
        if (!value || typeof value !== "object") continue;
        if (typeof value.model === "string") usage.model = value.model;
        const u = value.usage;
        if (!u || typeof u !== "object") continue;
        sawUsage = true;
        usage.inputTokens = number(u.input_tokens ?? u.prompt_tokens) ?? usage.inputTokens;
        usage.outputTokens = number(u.output_tokens ?? u.completion_tokens) ?? usage.outputTokens;
        usage.cachedInputTokens = number(u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens) ?? usage.cachedInputTokens;
        usage.cacheWriteTokens = number(u.cache_creation_input_tokens) ?? usage.cacheWriteTokens;
      }
    } catch { /* Non-data SSE lines and malformed frames carry no usage. */ }
  };
  return {
    push(text: string) {
      pending += text;
      if (jsonBody === undefined && pending.trim()) jsonBody = pending.trimStart().startsWith("{");
      let newline: number;
      while (!jsonBody && (newline = pending.indexOf("\n")) >= 0) {
        parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      // Bound memory for giant non-SSE payloads; never retain response bodies in events.
      if (pending.length > 2_000_000) pending = "";
    },
    finish(complete: boolean): BrokerUsage {
      parse(pending);
      usage.complete = complete && sawUsage;
      return usage;
    }
  };
}
