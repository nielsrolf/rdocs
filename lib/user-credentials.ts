import crypto from "node:crypto";

import { agentModelProvider } from "@/agent-core";
import { maskSecret, type DocumentEnv } from "@/lib/agent-env";
import {
  detectCredential,
  looksLikeMcpToken,
  type CredentialKind,
  type CredentialProvider
} from "@/lib/credential-detect";
import { hasAnthropicCredential } from "@/lib/agent-runner/agent-credential";
import { db } from "@/lib/db";
import { loadDocumentEnv } from "@/lib/document-env";

// Per-user AI credential store, at most one credential per provider. For
// "anthropic" a user connects EITHER an Anthropic API key OR a
// `claude setup-token` subscription OAuth token; for "openrouter"/"litellm"
// they connect that provider's API key. Every document they OWN inherits the
// credentials, and the agent authenticates under the owner's credential for
// the selected model's provider. Secrets are encrypted at rest (AES-256-GCM)
// and never returned in full over the API — listed back masked, like
// DocumentEnvVar.
//
// Resolution precedence when building a run's agent env:
//   document env (DocumentEnvVar) → document OWNER's UserCredential → host
//   ~/.claude fallback (Anthropic only, handled downstream in
//   agent-credential.ts).

export type { CredentialKind, CredentialProvider } from "@/lib/credential-detect";

export type OwnerCredential = { kind: CredentialKind; value: string };

export type NormalizedCredentialInput = OwnerCredential & { provider: CredentialProvider };

export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  "anthropic",
  "openrouter",
  "litellm",
  "github"
];

export function isCredentialProvider(value: unknown): value is CredentialProvider {
  return typeof value === "string" && (CREDENTIAL_PROVIDERS as string[]).includes(value);
}

export type MaskedUserCredential = {
  provider: CredentialProvider;
  kind: CredentialKind;
  masked: string;
  label: string | null;
  updatedAt: string;
};

// Anthropic OAuth tokens (from `claude setup-token`) begin sk-ant-oat; regular
// API keys begin sk-ant- but NOT sk-ant-oat. The OAuth prefix must be checked
// first because it is a strict extension of the API-key prefix.
const OAUTH_PREFIX = "sk-ant-oat";
const API_KEY_PREFIX = "sk-ant-";

/** Detect the credential kind from an Anthropic secret's prefix; null if neither. */
export function detectCredentialKind(value: string): CredentialKind | null {
  const trimmed = value.trim();
  if (trimmed.startsWith(OAUTH_PREFIX)) return "oauth";
  if (trimmed.startsWith(API_KEY_PREFIX)) return "api_key";
  return null;
}

/**
 * Validate + normalize a connect request. Without an explicit provider the
 * value's format decides (sk-ant… / sk-or… / gh… prefixes); unrecognizable
 * values must name a provider (in practice: LiteLLM, whose keys are opaque).
 * For "anthropic" the kind is auto-detected from the prefix; if an explicit
 * kind is supplied it must agree with the detected kind (mismatches are
 * rejected). For "openrouter"/"litellm"/"github" the value is an opaque API
 * key (kind "api_key"), but a value that looks like an Anthropic credential is
 * rejected as an almost certain mix-up. Throws an Error with a user-facing
 * message on any invalid input.
 */
export function normalizeCredentialInput(input: {
  provider?: CredentialProvider | null;
  kind?: CredentialKind | null;
  value: string;
}): NormalizedCredentialInput {
  const value = input.value.trim();
  if (!value) {
    throw new Error("Credential value is required.");
  }
  if (looksLikeMcpToken(value)) {
    throw new Error(
      "That is a gdocs-ai MCP token (gdai_…), not a provider credential — use it with `claude mcp add` instead."
    );
  }
  const provider = input.provider ?? detectCredential(value)?.provider;
  if (!provider) {
    throw new Error(
      "Couldn't recognize this credential's format. Specify the provider (a LiteLLM key, most likely)."
    );
  }
  const detected = detectCredentialKind(value);

  if (provider !== "anthropic") {
    if (detected) {
      throw new Error(
        `The value looks like an Anthropic credential (sk-ant-…) but the ${provider} provider was selected.`
      );
    }
    if (/\s/.test(value)) {
      throw new Error("API keys must not contain whitespace.");
    }
    return { provider, kind: "api_key", value };
  }

  if (!detected) {
    throw new Error(
      "Value must be an Anthropic API key (starts with sk-ant-) or a subscription OAuth token (starts with sk-ant-oat)."
    );
  }
  if (input.kind && input.kind !== detected) {
    throw new Error(
      `The value looks like ${detected === "oauth" ? "a subscription OAuth token" : "an API key"} but kind "${input.kind}" was requested.`
    );
  }
  return { provider, kind: detected, value };
}

// --- Encryption at rest (AES-256-GCM) -------------------------------------

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

// Parse the 32-byte encryption key from CREDENTIAL_ENCRYPTION_KEY (base64 or
// hex). Fails loudly with an actionable message when missing/malformed so we
// never silently store or read a credential without encryption.
function getEncryptionKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || !raw.trim()) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env."
    );
  }
  const trimmed = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 32) key = decoded;
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== 32) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes (base64 e.g. `openssl rand -base64 32`, or 64 hex chars)."
    );
  }
  return key;
}

/** Encrypt a secret to a self-describing `iv:tag:ciphertext` base64 string. */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/** Reverse encryptSecret. Throws if the key is missing or the payload is corrupt. */
export function decryptSecret(stored: string): string {
  const key = getEncryptionKey();
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new Error("Stored credential is malformed (expected iv:tag:ciphertext).");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final()
  ]);
  return dec.toString("utf8");
}

// --- DB access ------------------------------------------------------------

/** The decrypted credential a user connected for a provider, or null. */
export async function getUserCredential(
  userId: string,
  provider: CredentialProvider = "anthropic"
): Promise<OwnerCredential | null> {
  const row = await db.userCredential.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { kind: true, secret: true }
  });
  if (!row) return null;
  return { kind: row.kind as CredentialKind, value: decryptSecret(row.secret) };
}

/** Key-presence check (no decryption) — used to gate the model selector. */
export async function hasUserCredential(
  userId: string,
  provider: CredentialProvider
): Promise<boolean> {
  const row = await db.userCredential.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { id: true }
  });
  return Boolean(row);
}

/** Masked views safe to return over the API / show in the UI. */
export async function getUserCredentialsMasked(userId: string): Promise<MaskedUserCredential[]> {
  const rows = await db.userCredential.findMany({
    where: { userId },
    select: { provider: true, kind: true, secret: true, label: true, updatedAt: true }
  });
  const order = (p: string) => CREDENTIAL_PROVIDERS.indexOf(p as CredentialProvider);
  return rows
    .sort((a, b) => order(a.provider) - order(b.provider))
    .map((row) => ({
      provider: row.provider as CredentialProvider,
      kind: row.kind as CredentialKind,
      masked: maskSecret(decryptSecret(row.secret)),
      label: row.label,
      updatedAt: row.updatedAt.toISOString()
    }));
}

export async function upsertUserCredential(
  userId: string,
  credential: NormalizedCredentialInput,
  label?: string | null
): Promise<void> {
  const secret = encryptSecret(credential.value);
  await db.userCredential.upsert({
    where: { userId_provider: { userId, provider: credential.provider } },
    create: {
      userId,
      provider: credential.provider,
      kind: credential.kind,
      secret,
      label: label ?? null
    },
    update: { kind: credential.kind, secret, label: label ?? null }
  });
}

export async function deleteUserCredential(
  userId: string,
  provider: CredentialProvider = "anthropic"
): Promise<void> {
  await db.userCredential
    .delete({ where: { userId_provider: { userId, provider } } })
    .catch(() => undefined);
}

// --- Resolution -----------------------------------------------------------

/** The document-env variable each third-party provider authenticates with. */
export const PROVIDER_ENV_KEY = {
  openrouter: "OPENROUTER_API_KEY",
  litellm: "LITELLM_API_KEY"
} as const;

/**
 * Layer the document owner's credential onto an already-loaded document env.
 * `ownerCredential` is the owner's credential FOR THE MODEL'S PROVIDER
 * (anthropic / openrouter / litellm).
 *
 *   - A credential already in the document env (DocumentEnvVar) wins — it is the
 *     team/shared-doc override, higher precedence than the owner's personal key.
 *   - OpenRouter/LiteLLM models: inject the owner's key as the provider env var
 *     (OPENROUTER_API_KEY / LITELLM_API_KEY) so applyProviderEnv picks it up.
 *   - Anthropic models: inject EXACTLY ONE credential var per the SDK's
 *     precedence rules — api_key → ANTHROPIC_API_KEY (and drop any
 *     CLAUDE_CODE_OAUTH_TOKEN); oauth → CLAUDE_CODE_OAUTH_TOKEN (and drop any
 *     ANTHROPIC_API_KEY, since the SDK would otherwise prefer the key).
 *   - No owner credential → unchanged; for Anthropic the host ~/.claude
 *     fallback (downstream) applies as before.
 */
export function applyOwnerCredentialEnv(
  agentEnv: DocumentEnv,
  ownerCredential: OwnerCredential | null,
  agentModel: string | null | undefined
): DocumentEnv {
  const provider = agentModelProvider(agentModel);
  if (provider === "local") return agentEnv;
  if (provider !== "anthropic") {
    const keyVar = PROVIDER_ENV_KEY[provider];
    if (agentEnv[keyVar]?.trim()) return agentEnv;
    if (!ownerCredential) return agentEnv;
    return { ...agentEnv, [keyVar]: ownerCredential.value };
  }
  if (hasAnthropicCredential(agentEnv)) return agentEnv;
  if (!ownerCredential) return agentEnv;
  const next: DocumentEnv = { ...agentEnv };
  if (ownerCredential.kind === "api_key") {
    next.ANTHROPIC_API_KEY = ownerCredential.value;
    delete next.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    next.CLAUDE_CODE_OAUTH_TOKEN = ownerCredential.value;
    delete next.ANTHROPIC_API_KEY;
  }
  return next;
}

/**
 * Fail-fast check for third-party provider keys AFTER the owner credential has
 * been layered in: an OpenRouter/LiteLLM run with no key anywhere would only
 * die later inside the sandbox (applyProviderEnv throws in the container), so
 * surface a clear, actionable error at the route instead. Returns null for
 * Anthropic models and when the key is present.
 */
export function providerKeyRequirementError(
  agentEnv: DocumentEnv,
  agentModel: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): string | null {
  const provider = agentModelProvider(agentModel);
  if (provider === "anthropic") return null;
  if (provider === "local") {
    if (agentEnv.LOCAL_MODEL_BASE_URL?.trim() || env.LOCAL_MODEL_BASE_URL?.trim()) return null;
    return "Local model selected but LOCAL_MODEL_BASE_URL is not configured on this server.";
  }
  const keyVar = PROVIDER_ENV_KEY[provider];
  if (agentEnv[keyVar]?.trim()) return null;
  const label = provider === "openrouter" ? "OpenRouter" : "LiteLLM";
  return `${label} model selected but no ${keyVar} is available. Add it in the document's Env menu, or connect a ${label} key in the AI credentials menu.`;
}

function isFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseEmailAllowlist(value: string | undefined): string[] | null {
  if (!value) return null;
  const emails = value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return emails.length > 0 ? emails : null;
}

export const CONNECT_CREDENTIAL_MESSAGE =
  "Connect an Anthropic credential in settings to run AI features.";

/**
 * Guards on falling back to the HOST ~/.claude credential. Returns a clear
 * user-facing message (so the run fails fast instead of hitting a cryptic 401)
 * when the resolved env has no Anthropic credential, the model routes through
 * the Anthropic provider (OpenRouter/LiteLLM bring their own keys), and either:
 *   - AGENT_REQUIRE_USER_CREDENTIAL is set (phase-4 multi-tenant mode: host
 *     fallback disabled for everyone), or
 *   - AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS is set and none of the accounts
 *     behind the run — the triggering user or the document owner — is on that
 *     comma-separated allowlist (host subscription is reserved for the listed
 *     accounts; everyone else brings their own key).
 * Returns null otherwise (fallback permitted).
 */
export function credentialRequirementError(
  agentEnv: DocumentEnv,
  agentModel: string | null | undefined,
  accountEmail: string | null | undefined | Array<string | null | undefined> = null,
  env: Record<string, string | undefined> = process.env
): string | null {
  if (agentModelProvider(agentModel) !== "anthropic") return null;
  if (hasAnthropicCredential(agentEnv)) return null;
  if (isFlagEnabled(env.AGENT_REQUIRE_USER_CREDENTIAL)) return CONNECT_CREDENTIAL_MESSAGE;
  const allowlist = parseEmailAllowlist(env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS);
  if (allowlist) {
    const emails = (Array.isArray(accountEmail) ? accountEmail : [accountEmail])
      .filter((email): email is string => Boolean(email))
      .map((email) => email.trim().toLowerCase());
    if (!emails.some((email) => allowlist.includes(email))) {
      return CONNECT_CREDENTIAL_MESSAGE;
    }
  }
  return null;
}

// --- GitHub auth resolution ------------------------------------------------

// Which GitHub token may act on a document's linked repository. Mirrors the
// AI-credential precedence so the trust model is uniform:
//
//   document env GITHUB_TOKEN (team/shared override)
//     → the TRIGGERING user's connected GitHub PAT
//     → the document OWNER's connected GitHub PAT
//     → the HOST token (the shared bot account), but ONLY when the runner or
//       owner is on AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS (same trust boundary
//       as the host Claude credential). Without that gate any user could read
//       and push every repo the bot account can see by simply linking it.
//
// A null result means "operate anonymously": public repos still clone/pull,
// pushes fail with a clear message.

export type GithubAuthSource = "document-env" | "runner" | "owner" | "host";

export type GithubAuth = { token: string; source: GithubAuthSource };

function hostTokenPermitted(
  emails: Array<string | null | undefined>,
  env: Record<string, string | undefined>
): boolean {
  const allowlist = parseEmailAllowlist(env.AGENT_HOST_CREDENTIAL_ALLOWED_EMAILS);
  if (!allowlist) return true;
  return emails
    .filter((email): email is string => Boolean(email))
    .some((email) => allowlist.includes(email.trim().toLowerCase()));
}

export async function resolveGithubAuthForDocument(
  documentId: string,
  runnerUserId: string | null = null,
  env: Record<string, string | undefined> = process.env
): Promise<GithubAuth | null> {
  const [docEnv, doc, runner] = await Promise.all([
    loadDocumentEnv(documentId),
    db.document.findUnique({
      where: { id: documentId },
      select: { ownerId: true, owner: { select: { email: true } } }
    }),
    runnerUserId
      ? db.user.findUnique({ where: { id: runnerUserId }, select: { id: true, email: true } })
      : null
  ]);

  const docEnvToken = docEnv.GITHUB_TOKEN?.trim();
  if (docEnvToken) return { token: docEnvToken, source: "document-env" };

  const runnerCredential = runner ? await getUserCredential(runner.id, "github") : null;
  if (runnerCredential) return { token: runnerCredential.value, source: "runner" };

  const ownerCredential =
    doc?.ownerId && doc.ownerId !== runner?.id ? await getUserCredential(doc.ownerId, "github") : null;
  if (ownerCredential) return { token: ownerCredential.value, source: "owner" };

  const hostToken = env.GITHUB_TOKEN?.trim();
  if (hostToken && hostTokenPermitted([runner?.email, doc?.owner?.email], env)) {
    return { token: hostToken, source: "host" };
  }

  return null;
}

/** Same resolution for a user outside any document (e.g. validating a PAT). */
export async function resolveGithubAuthForUser(
  userId: string | null,
  env: Record<string, string | undefined> = process.env
): Promise<GithubAuth | null> {
  if (userId) {
    const credential = await getUserCredential(userId, "github");
    if (credential) return { token: credential.value, source: "runner" };
  }
  const hostToken = env.GITHUB_TOKEN?.trim();
  if (hostToken) {
    const user = userId
      ? await db.user.findUnique({ where: { id: userId }, select: { email: true } })
      : null;
    if (hostTokenPermitted([user?.email], env)) return { token: hostToken, source: "host" };
  }
  return null;
}

/**
 * Build the agent env for a document run: document env, layered with a
 * connected UserCredential for the model's provider, with the phase-4
 * requirement (Anthropic) / provider-key requirement (OpenRouter, LiteLLM)
 * enforced. Drop-in replacement for loadDocumentEnv at the three agent-run
 * call sites.
 *
 * Credential precedence:
 *   document env (team/shared override) → the TRIGGERING user's credential
 *   (runs you start bill your account) → the document OWNER's credential →
 *   host fallback (Anthropic only, allowlist-gated downstream).
 */
export async function loadAgentEnvForDocument(
  documentId: string,
  agentModel: string | null | undefined,
  runnerUserId: string | null = null
): Promise<DocumentEnv> {
  const [docEnv, doc, runner] = await Promise.all([
    loadDocumentEnv(documentId),
    db.document.findUnique({
      where: { id: documentId },
      select: { ownerId: true, owner: { select: { email: true } } }
    }),
    runnerUserId
      ? db.user.findUnique({ where: { id: runnerUserId }, select: { id: true, email: true } })
      : null
  ]);
  const provider = agentModelProvider(agentModel);
  const runnerCredential =
    runner && provider !== "local" ? await getUserCredential(runner.id, provider) : null;
  const ownerCredential =
    !runnerCredential && provider !== "local" && doc?.ownerId && doc.ownerId !== runner?.id
      ? await getUserCredential(doc.ownerId, provider)
      : null;
  const env = applyOwnerCredentialEnv(docEnv, runnerCredential ?? ownerCredential, agentModel);
  const requirementError =
    credentialRequirementError(env, agentModel, [runner?.email, doc?.owner?.email]) ??
    providerKeyRequirementError(env, agentModel);
  if (requirementError) {
    throw new Error(requirementError);
  }
  // GitHub auth for the run: the host token is no longer allowlisted into the
  // agent env, so whatever the per-document resolution yields (possibly
  // nothing) is exactly what the agent gets.
  const githubAuth = await resolveGithubAuthForDocument(documentId, runnerUserId);
  if (githubAuth) {
    if (!env.GITHUB_TOKEN?.trim()) env.GITHUB_TOKEN = githubAuth.token;
    if (!env.GH_TOKEN?.trim()) env.GH_TOKEN = githubAuth.token;
  }
  return env;
}

/** The deployment's free local model ("local/<name>"), when configured. */
export function freeLocalAgentModel(
  env: Record<string, string | undefined> = process.env
): string | null {
  const name = env.LOCAL_MODEL_NAME?.trim();
  const base = env.LOCAL_MODEL_BASE_URL?.trim();
  return name && base ? `local/${name}` : null;
}

export type AgentRunEnvResolution = {
  agentEnv: DocumentEnv;
  /** Stored-model shape ("local/<name>" when the fallback fired). */
  agentConfig: { model: string | null; effort: string | null };
  usedFreeFallback: boolean;
};

/**
 * loadAgentEnvForDocument, but an Anthropic-model run with NO credential
 * anywhere falls back to the deployment's free local model instead of failing
 * with "Connect an Anthropic credential…" — so brand-new users (e.g. mid
 * onboarding tour) get a working, free first run. Only that exact failure
 * triggers the fallback; provider-key errors and unrelated failures still
 * throw. Callers surface `usedFreeFallback` in the run timeline so nobody
 * mistakes qwen output for Claude's.
 */
export async function loadAgentEnvWithFreeFallback(
  documentId: string,
  agentConfig: { model: string | null; effort: string | null },
  runnerUserId: string | null = null
): Promise<AgentRunEnvResolution> {
  try {
    const agentEnv = await loadAgentEnvForDocument(documentId, agentConfig.model, runnerUserId);
    return { agentEnv, agentConfig, usedFreeFallback: false };
  } catch (error) {
    const fallbackModel = freeLocalAgentModel();
    const isCredentialMiss =
      error instanceof Error && error.message === CONNECT_CREDENTIAL_MESSAGE;
    if (!fallbackModel || !isCredentialMiss) {
      throw error;
    }
    const fallbackConfig = { model: fallbackModel, effort: agentConfig.effort };
    const agentEnv = await loadAgentEnvForDocument(documentId, fallbackModel, runnerUserId);
    return { agentEnv, agentConfig: fallbackConfig, usedFreeFallback: true };
  }
}
