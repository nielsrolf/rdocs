// List prices for model calls whose provider does not report a cost.
//
// A call through LiteLLM comes back with its real cost (a response header), and
// that is what the run's usage shows. A call made directly on an Anthropic
// credential comes back with token counts only. To say what an agent session
// "cost" we price those tokens at Anthropic's list prices: for an API key that
// approximates the bill, for a Claude subscription (OAuth) nothing is billed
// per token and the figure is hypothetical. Either way it is an ESTIMATE and
// is kept apart from reported cost (`RunUsageSummary.estimatedCostUsd`).
//
// Prices: USD per million tokens, Anthropic first-party API, as of 2026-11-03.
// Update when a model ships (same moment as ANTHROPIC_LATEST_MODEL_ALIASES).
// Not modelled: the 1-hour cache write rate (all cache writes are priced at the
// 5-minute rate, 1.25x input), Haiku 5.5's higher rate above 100K prompt
// tokens, fast mode, batch discounts. Models missing here get no estimate.

type Price = { input: number; output: number; cacheRead: number };

const CACHE_WRITE_MULTIPLIER = 1.25;

// Matched by longest prefix, so dated ids ("claude-haiku-4-5-20251001") and
// LiteLLM-style names ("anthropic/claude-sonnet-5-5") resolve too.
const ANTHROPIC_PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-mythos-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 1 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 }
};

const PREFIXES = Object.keys(ANTHROPIC_PRICES).sort((a, b) => b.length - a.length);

function priceFor(model: string | null | undefined): Price | null {
  if (!model) return null;
  const name = model.toLowerCase().replace(/^anthropic\//, "");
  // "claude-opus-5" must not claim "claude-opus-50": the prefix ends the id or is followed by "-".
  const key = PREFIXES.find((prefix) => name === prefix || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}@`));
  return key ? ANTHROPIC_PRICES[key] : null;
}

export type TokenCounts = {
  /** Uncached input tokens (Anthropic's `input_tokens`). */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
};

/** List-price cost of these tokens on that model, or null when the model has no known price. */
export function estimateListPriceUsd(model: string | null | undefined, tokens: TokenCounts): number | null {
  const price = priceFor(model);
  if (!price) return null;
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cachedInputTokens * price.cacheRead +
      tokens.cacheWriteTokens * price.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000
  );
}
