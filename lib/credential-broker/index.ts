import crypto from "node:crypto";

import { agentModelProvider } from "@/agent-core/agent-config";
import { OPENROUTER_BASE_URL, type DocumentEnv } from "@/agent-core/agent-env";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";

// Agent credential broker ("egress credential broker"): agent runs get per-run
// VIRTUAL credentials instead of the real API keys. The agent env carries the
// virtual token plus a *_BASE_URL override pointing at /api/broker/<keyId>;
// the proxy route (lib/credential-broker/proxy.ts) validates the virtual token
// per request, swaps in the real credential, and forwards to the upstream.
//
// Coverage (first increment — LLM credentials with reliable base-URL support):
//   - ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN (Anthropic-model runs);
//   - OPENAI_API_KEY (always, when configured in the run env);
//   - OPENROUTER_API_KEY / LITELLM_API_KEY (when the selected model routes
//     through that provider — applyProviderEnv then points the SDK at the
//     broker via OPENROUTER_BASE_URL / LITELLM_BASE_URL).
//   - TINKER_API_KEY (opt-in, see tinkerBrokerEnabled): the Tinker SDK honors
//     TINKER_BASE_URL and sends the key as X-API-Key. Besides hiding the key,
//     the proxy tags every Tinker session with the workspace's cost project
//     (lib/credential-broker/tinker.ts).
//   - GITHUB_TOKEN / GH_TOKEN (provider "github"): ONE key fronts several
//     GitHub hosts, chosen by the first path segment after the key
//     (githubUpstream below): /git → github.com (git over HTTPS), /api →
//     api.github.com, /uploads, /raw. The run env gets the virtual token in
//     both variables, GITHUB_API_URL / GITHUB_GRAPHQL_URL, and GIT_CONFIG_*
//     variables that rewrite https://github.com/ to the /git prefix and send
//     the virtual token to it. `gh` is bridged inside the sandbox
//     (agent-core/github-broker-bridge.ts). The real token never enters the
//     sandbox: not in env, not in a git config, not in a remote URL.
//
// What the broker does NOT do: prevent the agent from USING an API while its
// run is live. It prevents exfiltration-for-later (tokens die with the run),
// enables revocation, and gives a per-run audit trail.

export const BROKER_FLAG = "AGENT_CREDENTIAL_BROKER";
const VIRTUAL_PREFIX = "rdocs-vk-";
// The Tinker SDK refuses an api key that does not start with "tml-".
const TINKER_KEY_PREFIX = "tml-";
export const TINKER_DEFAULT_BASE_URL = "https://tinker.thinkingmachines.dev/services/tinker-prod";

function isFlagOn(value: string | undefined): boolean {
  return Boolean(value) && ["1", "true", "yes", "on"].includes(value!.trim().toLowerCase());
}

/**
 * Tinker goes through the broker when the deployment says so
 * (AGENT_BROKER_TINKER=1) or the workspace does (RDOCS_BROKER_TINKER=1 in its
 * env — set for budgeted workspaces, lib/workspace-budget.ts). Opt-in because
 * training traffic is heavy and the proxy sits in the app process.
 */
export function tinkerBrokerEnabled(agentEnv: DocumentEnv, hostEnv: Record<string, string | undefined>): boolean {
  return isFlagOn(hostEnv.AGENT_BROKER_TINKER) || isFlagOn(agentEnv.RDOCS_BROKER_TINKER);
}

/** A virtual broker token, possibly behind a provider's mandatory key prefix. */
export function isVirtualBrokerToken(token: string): boolean {
  return token.startsWith(VIRTUAL_PREFIX) || token.startsWith(`${TINKER_KEY_PREFIX}${VIRTUAL_PREFIX}`);
}
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export type BrokerAuthMode = "authorization-bearer" | "x-api-key";

export const GITHUB_PROVIDER = "github";
export const GITHUB_DEFAULT_UPSTREAM = "https://github.com";

/**
 * Upstream base URL and auth scheme for one part of a GitHub broker key.
 * `base` is https://github.com in production; anything else (GitHub
 * Enterprise, a test double) is addressed by path on that one host.
 */
export function githubUpstream(
  base: string,
  segment: string
): { baseUrl: string; auth: "basic" | "bearer" } | null {
  const root = base.replace(/\/+$/, "");
  const dotCom = root === GITHUB_DEFAULT_UPSTREAM;
  if (segment === "git") return { baseUrl: root, auth: "basic" };
  if (segment === "api") return { baseUrl: dotCom ? "https://api.github.com" : `${root}/api/v3`, auth: "bearer" };
  if (segment === "uploads") return { baseUrl: dotCom ? "https://uploads.github.com" : `${root}/api/uploads`, auth: "bearer" };
  if (segment === "raw") return { baseUrl: dotCom ? "https://raw.githubusercontent.com" : `${root}/raw`, auth: "bearer" };
  return null;
}

/**
 * Add git configuration to an env through GIT_CONFIG_COUNT/KEY_n/VALUE_n,
 * after whatever the env already configures that way.
 */
export function appendGitConfigEnv(env: DocumentEnv, entries: [string, string][]): void {
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  let index = Number.isInteger(existing) && existing > 0 ? existing : 0;
  for (const [key, value] of entries) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
    index += 1;
  }
  env.GIT_CONFIG_COUNT = String(index);
}

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
 *
 * `runnerMode` is the ACTUAL runner of this run and wins over the global
 * AGENT_RUNNER_MODE: host-dev Slack runs force the in-process runner on a
 * container-mode deployment, and host.docker.internal does not resolve on the
 * host (FailedToOpenSocket).
 */
export function brokerBaseUrl(
  env: Record<string, string | undefined> = process.env,
  runnerMode?: string
): string {
  const explicit = env.AGENT_BROKER_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const mode = runnerMode ?? env.AGENT_RUNNER_MODE ?? "container";
  const host = mode === "inprocess" ? "127.0.0.1" : "host.docker.internal";
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
  /** Prefix the provider's client insists on for a key (the virtual token gets it too). */
  tokenPrefix?: string;
  /** Additional env vars pointing the client at the broker, given the per-key URL. */
  extraEnv: (brokerKeyUrl: string) => Record<string, string>;
  /** Other env vars that carried the same real credential and get the virtual token too. */
  aliasEnvKeys?: string[];
  /** Git configuration (via GIT_CONFIG_*) that sends git through the broker. */
  gitConfig?: (brokerKeyUrl: string, virtualToken: string) => [string, string][];
};

/**
 * Which credentials in this run env get brokered, and how. Pure — no DB, no
 * token minting — so the substitution logic is unit-testable.
 */
export function planBrokerRewrites(
  agentEnv: DocumentEnv,
  agentModel: string | null | undefined,
  opts: {
    hostEnv?: Record<string, string | undefined>;
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
    }
  }

  // Tool credentials: OPENROUTER_API_KEY / LITELLM_API_KEY are injected into
  // every run env (not just runs on that provider's models), so broker them
  // whenever present — otherwise a real key would leak into e.g. a
  // Claude-model run while the broker is supposed to hold all secrets.
  if (agentEnv.OPENROUTER_API_KEY?.trim()) {
    plans.push({
      envKey: "OPENROUTER_API_KEY",
      provider: "openrouter",
      upstreamBaseUrl: OPENROUTER_BASE_URL,
      authMode: "authorization-bearer",
      secretValue: agentEnv.OPENROUTER_API_KEY.trim(),
      // Requires applyProviderEnv to honor OPENROUTER_BASE_URL (agent-core).
      extraEnv: (url) => ({ OPENROUTER_BASE_URL: url })
    });
  }

  if (agentEnv.LITELLM_API_KEY?.trim()) {
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

  // A static Tinker key ("tml-…"). A JWT credential ("eyJ…") or a credential
  // command is the user's own dynamic auth and is left alone.
  const tinkerKey = agentEnv.TINKER_API_KEY?.trim();
  if (tinkerKey?.startsWith(TINKER_KEY_PREFIX) && tinkerBrokerEnabled(agentEnv, hostEnv)) {
    plans.push({
      envKey: "TINKER_API_KEY",
      provider: "tinker",
      upstreamBaseUrl: agentEnv.TINKER_BASE_URL?.trim() || TINKER_DEFAULT_BASE_URL,
      authMode: "x-api-key",
      secretValue: tinkerKey,
      tokenPrefix: TINKER_KEY_PREFIX,
      extraEnv: (url) => ({ TINKER_BASE_URL: url })
    });
  }

  // GitHub: the token leaves the run env entirely. Both variable names are
  // replaced even when only one was set or they differed — a run has ONE
  // GitHub identity, and a real token left in the other name would defeat this.
  const githubToken = agentEnv.GITHUB_TOKEN?.trim() || agentEnv.GH_TOKEN?.trim();
  if (githubToken && !isVirtualBrokerToken(githubToken)) {
    plans.push({
      envKey: "GITHUB_TOKEN",
      aliasEnvKeys: ["GH_TOKEN"],
      provider: GITHUB_PROVIDER,
      upstreamBaseUrl: hostEnv.RDOCS_GITHUB_UPSTREAM?.trim() || GITHUB_DEFAULT_UPSTREAM,
      authMode: "authorization-bearer",
      secretValue: githubToken,
      extraEnv: (url) => ({
        RDOCS_GITHUB_BROKER_URL: url,
        GITHUB_API_URL: `${url}/api`,
        GITHUB_GRAPHQL_URL: `${url}/api/graphql`
      }),
      gitConfig: (url, token) => [
        [`url.${url}/git/.insteadOf`, "https://github.com/"],
        [`http.${url}/.extraheader`, `Authorization: Bearer ${token}`]
      ]
    });
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
    /** Actual runner mode of this run — beats AGENT_RUNNER_MODE for the broker URL. */
    runnerMode?: string;
  }
): Promise<BrokerizeResult> {
  const hostEnv = opts.hostEnv ?? process.env;
  if (!credentialBrokerEnabled(hostEnv)) return { agentEnv, minted: [] };

  const plans = planBrokerRewrites(agentEnv, opts.agentModel, { hostEnv });
  if (plans.length === 0) return { agentEnv, minted: [] };

  const base = brokerBaseUrl(hostEnv, opts.runnerMode);
  const next: DocumentEnv = { ...agentEnv };
  const minted: string[] = [];
  for (const plan of plans) {
    const token = `${plan.tokenPrefix ?? ""}${VIRTUAL_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
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
    for (const alias of plan.aliasEnvKeys ?? []) next[alias] = token;
    const keyUrl = `${base}/api/broker/${row.id}`;
    Object.assign(next, plan.extraEnv(keyUrl));
    if (plan.gitConfig) appendGitConfigEnv(next, plan.gitConfig(keyUrl, token));
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
  if (!presentedToken || !isVirtualBrokerToken(presentedToken)) {
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
  if (key.secret) {
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
