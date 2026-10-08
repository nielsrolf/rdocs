import {
  ANTHROPIC_LATEST_MODEL_ALIASES,
  type AnthropicLatestFamily,
  type LatestAnthropicModels
} from "@/agent-core";

// Which concrete Claude model a "latest" alias ("claude-opus-latest", …) means
// right now. Discovered from the Anthropic Models API (GET /v1/models), newest
// `created_at` per family, and cached process-wide.
//
// Credentials: there is no host Anthropic credential (and must never be one —
// see "No host credentials, ever" in CLAUDE.md), so the catalog is refreshed
// with whichever ACCOUNT credential is already in hand: the run's resolved
// Anthropic key/OAuth token at run start, or the viewer's own credential when
// the model picker asks. Listing models is read-only and unbilled; the
// credential is only sent to api.anthropic.com, never stored here. Without any
// successful discovery, the built-in fallbacks in agent-core apply.

export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
// A failed refresh is not retried on every run start.
export const MODEL_CATALOG_RETRY_MS = 10 * 60 * 1000;
const MODEL_CATALOG_TIMEOUT_MS = 5000;
const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const FAMILIES = new Set<AnthropicLatestFamily>(
  Object.values(ANTHROPIC_LATEST_MODEL_ALIASES).map((alias) => alias.family)
);
// "claude-<family>-<major>[-<minor>]" — undated canonical ids only, so a
// dated snapshot ("…-20250929") never shadows its alias-style sibling.
const CANONICAL_ID_RE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/;

export type AnthropicModelListing = {
  id: string;
  display_name?: string;
  created_at?: string;
};

export type AnthropicCatalogCredential = { kind: "api_key" | "oauth"; value: string };

type CatalogState = {
  latest: LatestAnthropicModels;
  fetchedAt: number | null;
  lastAttemptAt: number | null;
  inFlight: Promise<void> | null;
};

const CATALOG_GLOBAL_KEY = Symbol.for("rdocs.anthropicModelCatalog");

// globalThis, not module scope: Next evaluates instrumentation (Slack runs) and
// route handlers in different module contexts (same rule as the run registry).
function state(): CatalogState {
  const holder = globalThis as unknown as Record<symbol, CatalogState | undefined>;
  holder[CATALOG_GLOBAL_KEY] ??= { latest: {}, fetchedAt: null, lastAttemptAt: null, inFlight: null };
  return holder[CATALOG_GLOBAL_KEY]!;
}

/** Test seam: forget everything discovered. */
export function resetAnthropicModelCatalog(): void {
  const holder = globalThis as unknown as Record<symbol, CatalogState | undefined>;
  delete holder[CATALOG_GLOBAL_KEY];
}

/** Human label from a Models API display name ("Claude Opus 5.5" → "Opus 5.5"). */
function labelFor(model: AnthropicModelListing, family: string, major: string, minor?: string): string {
  const display = model.display_name?.trim();
  if (display) return display.replace(/^Claude\s+/i, "");
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`;
}

/**
 * Pick the newest model per tracked family from a Models API listing: highest
 * (major, minor) version, ties broken by `created_at`. Pure — the unit seam.
 */
export function pickLatestAnthropicModels(models: readonly AnthropicModelListing[]): LatestAnthropicModels {
  const best = new Map<
    AnthropicLatestFamily,
    { model: AnthropicModelListing; version: [number, number]; created: number; label: string }
  >();
  for (const model of models) {
    const match = CANONICAL_ID_RE.exec(model.id);
    if (!match) continue;
    const [, family, major, minor] = match;
    if (!FAMILIES.has(family as AnthropicLatestFamily)) continue;
    const version: [number, number] = [Number(major), minor ? Number(minor) : 0];
    const created = Date.parse(model.created_at ?? "") || 0;
    const current = best.get(family as AnthropicLatestFamily);
    const newer =
      !current ||
      version[0] > current.version[0] ||
      (version[0] === current.version[0] &&
        (version[1] > current.version[1] || (version[1] === current.version[1] && created > current.created)));
    if (newer) {
      best.set(family as AnthropicLatestFamily, {
        model,
        version,
        created,
        label: labelFor(model, family, major, minor)
      });
    }
  }
  const latest: LatestAnthropicModels = {};
  for (const [family, entry] of best) latest[family] = { id: entry.model.id, label: entry.label };
  return latest;
}

/** GET /v1/models (all pages) with an account credential. */
export async function fetchAnthropicModelListing(
  credential: AnthropicCatalogCredential,
  fetchImpl: typeof fetch = fetch
): Promise<AnthropicModelListing[]> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (credential.kind === "oauth") {
    headers.authorization = `Bearer ${credential.value}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = credential.value;
  }
  const models: AnthropicModelListing[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < 10; page++) {
    const url = new URL("/v1/models", ANTHROPIC_API_BASE);
    url.searchParams.set("limit", "100");
    if (afterId) url.searchParams.set("after_id", afterId);
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(`Anthropic Models API returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: AnthropicModelListing[];
      has_more?: boolean;
      last_id?: string | null;
    };
    models.push(...(body.data ?? []).filter((m) => typeof m?.id === "string"));
    if (!body.has_more || !body.last_id) break;
    afterId = body.last_id;
  }
  return models;
}

/** The Anthropic account credential in a resolved run env, if any. */
export function anthropicCatalogCredentialFromEnv(
  env: Record<string, string | undefined>
): AnthropicCatalogCredential | null {
  // A custom ANTHROPIC_BASE_URL means the credential belongs to some proxy,
  // not api.anthropic.com — don't send it there.
  if (env.ANTHROPIC_BASE_URL?.trim()) return null;
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { kind: "api_key", value: apiKey };
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauth) return { kind: "oauth", value: oauth };
  return null;
}

/** What is currently known (possibly empty → callers use the built-in fallbacks). */
export function getLatestAnthropicModels(): LatestAnthropicModels {
  return { ...state().latest };
}

/**
 * Refresh the catalog when it is stale, using `credential`. Never throws: a
 * failure is logged and the previous (or built-in) answer stays in effect.
 * Concurrent callers share one request.
 */
export async function refreshLatestAnthropicModels(
  credential: AnthropicCatalogCredential | null,
  opts: { now?: number; fetchImpl?: typeof fetch } = {}
): Promise<LatestAnthropicModels> {
  const s = state();
  const now = opts.now ?? Date.now();
  const fresh = s.fetchedAt !== null && now - s.fetchedAt < MODEL_CATALOG_TTL_MS;
  const recentlyTried = s.lastAttemptAt !== null && now - s.lastAttemptAt < MODEL_CATALOG_RETRY_MS;
  if (!credential || fresh || recentlyTried) {
    if (s.inFlight) await s.inFlight;
    return getLatestAnthropicModels();
  }
  if (!s.inFlight) {
    s.lastAttemptAt = now;
    s.inFlight = (async () => {
      try {
        const latest = pickLatestAnthropicModels(
          await fetchAnthropicModelListing(credential, opts.fetchImpl)
        );
        if (Object.keys(latest).length > 0) {
          s.latest = { ...s.latest, ...latest };
          s.fetchedAt = now;
        }
      } catch (error) {
        console.warn("[model-catalog] refreshing latest Claude models failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        s.inFlight = null;
      }
    })();
  }
  await s.inFlight;
  return getLatestAnthropicModels();
}
