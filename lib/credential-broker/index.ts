import crypto from "node:crypto";

import { agentModelProvider } from "@/agent-core/agent-config";
import { OPENROUTER_BASE_URL, type DocumentEnv } from "@/agent-core/agent-env";
import { readHostClaudeOAuth, OAUTH_EXPIRY_MARGIN_MS } from "@/lib/agent-runner/agent-credential";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";

// Agent credential broker ("egress credential broker"): agent runs get per-run
// VIRTUAL credentials instead of the real API keys. The agent env carries the
// virtual token plus a *_BASE_URL override pointing at /api/broker/<keyId>;
// the proxy route (lib/credential-broker/proxy.ts) validates the virtual token
// per request, swaps in the real credential, and forwards to the upstream.
//
// Coverage (first increment — LLM credentials with reliable base-URL support):
//   - ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN (Anthropic-model runs),
//     including the host ~/.claude OAuth fallback (stored as secretRef so the
//     credential is re-read live at proxy time → mid-run refreshes work);
//   - OPENAI_API_KEY (always, when configured in the run env);
//   - OPENROUTER_API_KEY / LITELLM_API_KEY (when the selected model routes
//     through that provider — applyProviderEnv then points the SDK at the
//     broker via OPENROUTER_BASE_URL / LITELLM_BASE_URL).
// GITHUB_TOKEN is NOT brokered yet: the real token is already pinned into the
// worktree's git config (http.extraheader) for git itself, so an env-only swap
// would add confusion without confidentiality. Follow-up.
//
// What the broker does NOT do: prevent the agent from USING an API while its
// run is live. It prevents exfiltration-for-later (tokens die with the run),
// enables revocation, and gives a per-run audit trail.

export const BROKER_FLAG = "AGENT_CREDENTIAL_BROKER";
const VIRTUAL_PREFIX = "rdocs-vk-";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export type BrokerAuthMode = "authorization-bearer" | "x-api-key";

export function credentialBrokerEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const value = env[BROKER_FLAG];
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Base URL under which the AGENT reaches this app's broker route. Containers
 * reach the host via host.docker.internal; the in-process runner via
 * loopback. Behind the blue/green setup the stable entry point is Caddy on
 * :14141 either way. Override with AGENT_BROKER_BASE_URL.
 */
export function brokerBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.AGENT_BROKER_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host =
    (env.AGENT_RUNNER_MODE || "container") === "inprocess" ? "127.0.0.1" : "host.docker.internal";
  return `http://${host}:14141`;
}

export function hashBrokerToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// The broker runs on the HOST, where docker's magic hostname does not resolve.
// Upstreams configured for in-container use (e.g. the default LITELLM_BASE_URL
// http://host.docker.internal:9274) are normalized to loopback at mint time.
export function normalizeUpstreamForHost(upstreamBaseUrl: string): string {
  return upstreamBaseUrl.replace(/\/+$/, "").replace("://host.docker.internal", "://127.0.0.1");
}

export type BrokerRewritePlan = {
  /** Env var whose real value is replaced by the virtual token. */
  envKey: string;
  provider: string;
  upstreamBaseUrl: string;
  authMode: BrokerAuthMode;
  /** Exactly one of secretValue / secretRef. */
  secretValue?: string;
  secretRef?: string;
  /** Additional env vars pointing the client at the broker, given the per-key URL. */
  extraEnv: (brokerKeyUrl: string) => Record<string, string>;
};

/**
 * Which credentials in this run env get brokered, and how. Pure — no DB, no
 * token minting — so the substitution logic is unit-testable. `hostOAuth`
 * mirrors the container runner's host ~/.claude fallback: when the env has no
 * Anthropic credential but the host session exists, the broker takes over that
 * injection with a live secretRef instead of copying the raw token in.
 */
export function planBrokerRewrites(
  agentEnv: DocumentEnv,
  agentModel: string | null | undefined,
  opts: {
    hostEnv?: Record<string, string | undefined>;
    hostOAuthAvailable?: boolean;
  } = {}
): BrokerRewritePlan[] {
  const hostEnv = opts.hostEnv ?? process.env;
  const provider = agentModelProvider(agentModel);
  const plans: BrokerRewritePlan[] = [];

  if (agentEnv.OPENAI_API_KEY?.trim()) {
    plans.push({
      envKey: "OPENAI_API_KEY",
      provider: "openai",
      upstreamBaseUrl: "https://api.openai.com",
      authMode: "authorization-bearer",
      secretValue: agentEnv.OPENAI_API_KEY.trim(),
      extraEnv: (url) => ({ OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_BASE: `${url}/v1` })
    });
  }

  if (provider === "anthropic") {
    if (agentEnv.ANTHROPIC_API_KEY?.trim()) {
      plans.push({
        envKey: "ANTHROPIC_API_KEY",
        provider: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
        authMode: "x-api-key",
        secretValue: agentEnv.ANTHROPIC_API_KEY.trim(),
        extraEnv: (url) => ({ ANTHROPIC_BASE_URL: url })
      });
    } else if (agentEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
      plans.push({
        envKey: "CLAUDE_CODE_OAUTH_TOKEN",
        provider: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
        authMode: "authorization-bearer",
        secretValue: agentEnv.CLAUDE_CODE_OAUTH_TOKEN.trim(),
        extraEnv: (url) => ({ ANTHROPIC_BASE_URL: url })
      });
    } else if (opts.hostOAuthAvailable) {
      plans.push({
        envKey: "CLAUDE_CODE_OAUTH_TOKEN",
        provider: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
        authMode: "authorization-bearer",
        secretRef: "host-claude-oauth",
        extraEnv: (url) => ({ ANTHROPIC_BASE_URL: url })
      });
    }
  } else if (provider === "openrouter" && agentEnv.OPENROUTER_API_KEY?.trim()) {
    plans.push({
      envKey: "OPENROUTER_API_KEY",
      provider: "openrouter",
      upstreamBaseUrl: OPENROUTER_BASE_URL,
      authMode: "authorization-bearer",
      secretValue: agentEnv.OPENROUTER_API_KEY.trim(),
      // Requires applyProviderEnv to honor OPENROUTER_BASE_URL (agent-core).
      extraEnv: (url) => ({ OPENROUTER_BASE_URL: url })
    });
  } else if (provider === "litellm" && agentEnv.LITELLM_API_KEY?.trim()) {
    const upstream = (agentEnv.LITELLM_BASE_URL ?? hostEnv.LITELLM_BASE_URL)?.trim();
    if (upstream) {
      plans.push({
        envKey: "LITELLM_API_KEY",
        provider: "litellm",
        upstreamBaseUrl: upstream,
        authMode: "authorization-bearer",
        secretValue: agentEnv.LITELLM_API_KEY.trim(),
        extraEnv: (url) => ({ LITELLM_BASE_URL: url })
      });
    }
  }

  return plans;
}

export type BrokerizeResult = {
  agentEnv: DocumentEnv;
  /** Providers brokered, for logging / the run timeline. */
  minted: string[];
};

/**
 * Replace real credentials in a run's agent env with per-run virtual broker
 * keys. No-op (returns the env unchanged) when AGENT_CREDENTIAL_BROKER is not
 * enabled or nothing in the env is brokerable. Call AFTER
 * loadAgentEnvWithFreeFallback and BEFORE handing the env to the runner.
 */
export async function brokerizeAgentEnvForRun(
  agentEnv: DocumentEnv,
  opts: {
    aiRunId: string;
    agentModel: string | null | undefined;
    hostEnv?: Record<string, string | undefined>;
    homeDir?: string;
  }
): Promise<BrokerizeResult> {
  const hostEnv = opts.hostEnv ?? process.env;
  if (!credentialBrokerEnabled(hostEnv)) return { agentEnv, minted: [] };

  const hostOAuthAvailable =
    agentModelProvider(opts.agentModel) === "anthropic" &&
    Boolean(readHostClaudeOAuth({ homeDir: opts.homeDir ?? hostEnv.HOME }));
  const plans = planBrokerRewrites(agentEnv, opts.agentModel, { hostEnv, hostOAuthAvailable });
  if (plans.length === 0) return { agentEnv, minted: [] };

  const base = brokerBaseUrl(hostEnv);
  const next: DocumentEnv = { ...agentEnv };
  const minted: string[] = [];
  for (const plan of plans) {
    const token = `${VIRTUAL_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
    const row = await db.agentBrokerKey.create({
      data: {
        tokenHash: hashBrokerToken(token),
        aiRunId: opts.aiRunId,
        provider: plan.provider,
        upstreamBaseUrl: normalizeUpstreamForHost(plan.upstreamBaseUrl),
        authMode: plan.authMode,
        secret: plan.secretValue ? encryptSecret(plan.secretValue) : null,
        secretRef: plan.secretRef ?? null,
        expiresAt: new Date(Date.now() + DEFAULT_TTL_MS)
      },
      select: { id: true }
    });
    next[plan.envKey] = token;
    Object.assign(next, plan.extraEnv(`${base}/api/broker/${row.id}`));
    minted.push(plan.provider);
  }
  console.log(
    `[broker] minted ${minted.length} virtual key(s) for run ${opts.aiRunId}: ${minted.join(", ")}`
  );
  return { agentEnv: next, minted };
}

/** Revoke a run's virtual keys and wipe the stored secret material. */
export async function revokeBrokerKeysForRun(aiRunId: string): Promise<number> {
  const result = await db.agentBrokerKey.updateMany({
    where: { aiRunId, revokedAt: null },
    data: { revokedAt: new Date(), secret: null }
  });
  if (result.count > 0) {
    console.log(`[broker] revoked ${result.count} virtual key(s) for run ${aiRunId}`);
  }
  return result.count;
}

export type BrokerResolution =
  | {
      ok: true;
      keyId: string;
      aiRunId: string | null;
      provider: string;
      upstreamBaseUrl: string;
      authMode: BrokerAuthMode;
      secretValue: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Per-request validation: the presented virtual token must hash-match the key,
 * the key must be live (not revoked/expired), and the owning run must still be
 * RUNNING — so every run-termination path (success, failure, reaper) cuts
 * access even without an explicit revoke.
 */
export async function resolveBrokerRequest(
  keyId: string,
  presentedToken: string | null,
  opts: { now?: number; homeDir?: string } = {}
): Promise<BrokerResolution> {
  const now = opts.now ?? Date.now();
  if (!presentedToken || !presentedToken.startsWith(VIRTUAL_PREFIX)) {
    return { ok: false, status: 401, error: "Missing or malformed broker token." };
  }
  const key = await db.agentBrokerKey.findUnique({ where: { id: keyId } });
  if (!key) return { ok: false, status: 401, error: "Unknown broker key." };
  const presentedHash = Buffer.from(hashBrokerToken(presentedToken), "hex");
  const storedHash = Buffer.from(key.tokenHash, "hex");
  if (presentedHash.length !== storedHash.length || !crypto.timingSafeEqual(presentedHash, storedHash)) {
    return { ok: false, status: 401, error: "Invalid broker token." };
  }
  if (key.revokedAt) return { ok: false, status: 401, error: "Broker key revoked." };
  if (key.expiresAt && key.expiresAt.getTime() <= now) {
    return { ok: false, status: 401, error: "Broker key expired." };
  }
  if (key.aiRunId) {
    const run = await db.aiRun.findUnique({ where: { id: key.aiRunId }, select: { status: true } });
    if (!run || run.status !== "RUNNING") {
      return { ok: false, status: 401, error: "Broker key's run is no longer active." };
    }
  }

  let secretValue: string | null = null;
  if (key.secretRef === "host-claude-oauth") {
    const oauth = readHostClaudeOAuth({ homeDir: opts.homeDir ?? process.env.HOME });
    if (!oauth) {
      return { ok: false, status: 401, error: "Host Claude session unavailable." };
    }
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now + OAUTH_EXPIRY_MARGIN_MS) {
      return { ok: false, status: 401, error: "Host Claude session expired." };
    }
    secretValue = oauth.token;
  } else if (key.secret) {
    try {
      secretValue = decryptSecret(key.secret);
    } catch {
      return { ok: false, status: 500, error: "Broker key secret unreadable." };
    }
  }
  if (!secretValue) {
    return { ok: false, status: 401, error: "Broker key has no usable credential." };
  }

  return {
    ok: true,
    keyId: key.id,
    aiRunId: key.aiRunId,
    provider: key.provider,
    upstreamBaseUrl: key.upstreamBaseUrl,
    authMode: key.authMode as BrokerAuthMode,
    secretValue
  };
}
