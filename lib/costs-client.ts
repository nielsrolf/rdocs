// Client for the compute-cost dashboard (services/costs, costs.nielsrolf.com).
//
// r-docs uses it for workspace budgets (lib/workspace-budget.ts): a budgeted
// workspace is a PROJECT there, with a lifetime budget, nested under the
// project that pays for it. The dashboard is the ledger: it reads every
// provider's bill and reports what a project has spent, per provider. It does
// not enforce anything — r-docs hands out the keys and enforces.
//
// Configuration comes from the PROVISIONER document's env, falling back to the
// server env:
//   COSTS_ADMIN_TOKEN   personal API token of a dashboard user (provisioner
//                     admin secret: never given to an agent run)
//   COSTS_API_URL     default http://127.0.0.1:14190 (the dashboard is on this
//                     host; the public URL sits behind Cloudflare)

export class CostsError extends Error {}

export const COSTS_ADMIN_TOKEN_ENV = "COSTS_ADMIN_TOKEN";
const DEFAULT_COSTS_API_URL = "http://127.0.0.1:14190";
const REQUEST_TIMEOUT_MS = 20_000;

type FetchLike = typeof fetch;

export type CostsConfig = { baseUrl: string; token: string };

export function resolveCostsConfig(
  provisionerEnv: Record<string, string>,
  hostEnv: Record<string, string | undefined> = process.env
): CostsConfig | null {
  const token = provisionerEnv[COSTS_ADMIN_TOKEN_ENV]?.trim() || hostEnv[COSTS_ADMIN_TOKEN_ENV]?.trim();
  if (!token) return null;
  const baseUrl = provisionerEnv.COSTS_API_URL?.trim() || hostEnv.COSTS_API_URL?.trim() || DEFAULT_COSTS_API_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export type CostsLimit = { project: string; budget_usd: number; spent_usd: number; remaining_usd: number };

/** `GET /api/projects/{name}/spend`: lifetime spend incl. sub-projects, per provider. */
export type CostsSpend = {
  name: string;
  parent: string | null;
  path: string[];
  budget_usd: number | null;
  spent_usd: number;
  estimated_usd: number;
  /** The tightest of the project's own budget and those above it; null = no budget applies. */
  remaining_usd: number | null;
  over_budget: boolean;
  limits: CostsLimit[];
  by_provider: Array<{ provider: string; usd: number; estimated_usd: number }>;
  /** provider → time of its last successful sync (null: never, or failing). */
  synced_at: Record<string, string | null>;
  closed_at: string | null;
};

async function costsRequest<T>(
  config: CostsConfig,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  fetchImpl: FetchLike
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new CostsError(
      `Cost dashboard ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      /* not JSON */
    }
    throw new CostsError(`Cost dashboard ${method} ${path} returned ${response.status}: ${detail}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CostsError(`Cost dashboard ${method} ${path} returned non-JSON.`);
  }
}

const projectPath = (name: string) => `/api/projects/${encodeURIComponent(name)}`;

/**
 * Create the project (or, when a project of that name exists, set the given
 * fields on it — a retry after a half-finished provisioning must not fail).
 */
export async function ensureCostsProject(
  config: CostsConfig,
  input: { name: string; parent: string | null; budgetUsd: number; externalRef: string; description: string },
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const created = await costsRequest<{
    budget_usd: number | null;
    parent: string | null;
    external_ref: string;
    closed_at: string | null;
  }>(
    config,
    "POST",
    "/api/projects",
    {
      name: input.name,
      parent: input.parent,
      budget_usd: input.budgetUsd,
      external_ref: input.externalRef,
      description: input.description
    },
    fetchImpl
  );
  // POST returns an existing project unchanged (also one that was closed earlier).
  if (created.budget_usd !== input.budgetUsd || created.external_ref !== input.externalRef || created.closed_at) {
    if (created.external_ref && created.external_ref !== input.externalRef) {
      throw new CostsError(`The cost project "${input.name}" already belongs to something else (${created.external_ref}).`);
    }
    await costsRequest(
      config,
      "PATCH",
      projectPath(input.name),
      { budget_usd: input.budgetUsd, external_ref: input.externalRef, parent: input.parent, closed: false },
      fetchImpl
    );
  }
}

export async function updateCostsProject(
  config: CostsConfig,
  name: string,
  patch: { budgetUsd?: number; closed?: boolean },
  fetchImpl: FetchLike = fetch
): Promise<void> {
  await costsRequest(
    config,
    "PATCH",
    projectPath(name),
    {
      ...(patch.budgetUsd !== undefined ? { budget_usd: patch.budgetUsd } : {}),
      ...(patch.closed !== undefined ? { closed: patch.closed } : {})
    },
    fetchImpl
  );
}

export async function deleteCostsProject(config: CostsConfig, name: string, fetchImpl: FetchLike = fetch) {
  await costsRequest(config, "DELETE", projectPath(name), undefined, fetchImpl);
}

export async function getCostsSpend(config: CostsConfig, name: string, fetchImpl: FetchLike = fetch) {
  return costsRequest<CostsSpend>(config, "GET", `${projectPath(name)}/spend`, undefined, fetchImpl);
}

/** A project name for a workspace: readable, and unique through the document id. */
export function costsProjectName(title: string, documentId: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${slug || "workspace"}-${documentId.slice(-6).toLowerCase()}`;
}
