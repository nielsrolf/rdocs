// "Durable app" mode of a workspace.
//
// Normally every agent run gets a fresh, disposable container. A durable-app
// workspace instead has ONE long-lived container (lib/agent-runner/durable.ts)
// that runs every agent session of that workspace in turn, with the base
// workspace bind-mounted directly (no per-run clone) and one port published
// to the host, which the front door (services/frontdoor, Caddy) routes under a
// `<label>.<DURABLE_APP_DOMAIN_SUFFIX>` hostname. The agent can therefore
// start an internet-facing app in its workspace, keep it running between
// sessions, and restart it in the next session.
//
// This module owns the DurableApp row (per WORKSPACE-owning document), the
// hostname/port bookkeeping, and the front-door route. The container itself is
// managed by the runner. Everything is gated on the workspace owner's email
// (`DURABLE_APP_ALLOWED_EMAILS`): publishing under the deployment's domain is a
// deliberate operator grant, not a self-service feature.

import { AGENT_SESSION_PORT } from "@/agent-core/session-protocol";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { db } from "@/lib/db";
import { resolveWorkspaceDocumentId } from "@/lib/research-workspace";

const execFileAsync = promisify(execFile);

export const DURABLE_CONTAINER_PREFIX = "gdocs-durable-";

export function durableContainerName(workspaceDocumentId: string) {
  return `${DURABLE_CONTAINER_PREFIX}${workspaceDocumentId.replace(/[^a-zA-Z0-9_.-]+/g, "-")}`;
}

export class DurableAppError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = "DurableAppError";
  }
}

type Env = Record<string, string | undefined>;

export function durableAppDomainSuffix(env: Env = process.env): string {
  return (env.DURABLE_APP_DOMAIN_SUFFIX ?? "").trim().replace(/^\.+/, "").toLowerCase() || "nielsrolf.com";
}

export function durableAppPortRange(env: Env = process.env): { from: number; to: number } {
  const raw = (env.DURABLE_APP_PORT_RANGE ?? "").trim();
  const match = /^(\d{2,5})-(\d{2,5})$/.exec(raw);
  if (match) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from >= 1024 && to <= 65535 && from < to) return { from, to };
  }
  return { from: 16000, to: 16999 };
}

/** Who may turn a workspace into a durable app: the workspace OWNER's email must be listed. */
export function durableAppsAllowedFor(email: string | null | undefined, env: Env = process.env): boolean {
  if (!email) return false;
  const allowed = (env.DURABLE_APP_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validate `<label>.<suffix>`. Exactly one label (Cloudflare's universal
 * certificate covers one level of wildcard), lowercase, DNS-safe. Returns the
 * normalized hostname.
 */
export function validateDurableHostname(input: string, env: Env = process.env): string {
  const suffix = durableAppDomainSuffix(env);
  const trimmed = input.trim().toLowerCase().replace(/\.+$/, "");
  // A bare label ("dev") means "<label>.<suffix>".
  const hostname = trimmed.includes(".") ? trimmed : trimmed ? `${trimmed}.${suffix}` : trimmed;
  if (!hostname.endsWith(`.${suffix}`)) {
    throw new DurableAppError(`Hostname must end with .${suffix}.`);
  }
  const label = hostname.slice(0, -(suffix.length + 1));
  if (!HOSTNAME_LABEL.test(label) || label.includes(".")) {
    throw new DurableAppError(`Hostname must be a single DNS label followed by .${suffix} (e.g. myapp.${suffix}).`);
  }
  return hostname;
}

export function validateAppPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DurableAppError("App port must be an integer between 1 and 65535.");
  }
  if (port === AGENT_SESSION_PORT) {
    throw new DurableAppError(`Port ${port} is the agent session port inside the container; pick another one.`);
  }
  return port;
}

// --------------------------------------------------------------- front door

function frontdoorDir(env: Env = process.env) {
  return (env.FRONTDOOR_DIR ?? "").trim() || path.resolve(process.cwd(), "..", "frontdoor");
}

type CaddyRoute = {
  match?: { host?: string[] }[];
  handle?: { handler?: string; upstreams?: { dial?: string }[] }[];
};

/** Current `hostname → localhost:<port>` map of the front door (null when unavailable). */
export async function readFrontdoorRoutes(env: Env = process.env): Promise<Map<string, number> | null> {
  try {
    const raw = await fs.readFile(path.join(frontdoorDir(env), "caddy.json"), "utf8");
    const config = JSON.parse(raw) as { apps?: { http?: { servers?: Record<string, { routes?: CaddyRoute[] }> } } };
    const out = new Map<string, number>();
    for (const server of Object.values(config.apps?.http?.servers ?? {})) {
      for (const route of server.routes ?? []) {
        const hosts = route.match?.[0]?.host ?? [];
        const dial = route.handle?.find((h) => h.handler === "reverse_proxy")?.upstreams?.[0]?.dial ?? "";
        const port = Number(dial.split(":").pop());
        for (const host of hosts) {
          if (Number.isFinite(port)) out.set(host.toLowerCase(), port);
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * A hostname may only be claimed if the front door does not already route it
 * somewhere else — add-route.sh UPDATES existing routes, so without this check
 * a durable app could hijack docs.<suffix>.
 */
export async function assertHostnameFree(hostname: string, ownHostPort: number | null, env: Env = process.env) {
  const routes = await readFrontdoorRoutes(env);
  const current = routes?.get(hostname);
  if (current !== undefined && current !== ownHostPort) {
    throw new DurableAppError(`${hostname} is already routed by the front door to another service.`, 409);
  }
  const other = await db.durableApp.findFirst({ where: { hostname }, select: { documentId: true, hostPort: true } });
  if (other && other.hostPort !== ownHostPort) {
    throw new DurableAppError(`${hostname} is already used by another workspace.`, 409);
  }
}

async function runFrontdoorScript(script: string, args: string[], env: Env = process.env) {
  const file = path.join(frontdoorDir(env), script);
  await execFileAsync(file, args, { timeout: 30_000 });
}

export async function applyFrontdoorRoute(hostname: string, hostPort: number, env: Env = process.env) {
  await runFrontdoorScript("add-route.sh", [hostname, String(hostPort)], env);
}

export async function removeFrontdoorRoute(hostname: string, env: Env = process.env) {
  await runFrontdoorScript("remove-route.sh", [hostname], env).catch((error) => {
    console.warn(`[durable-app] failed to remove front-door route for ${hostname}: ${String(error)}`);
  });
}

// ------------------------------------------------------------------ records

export type DurableAppRecord = {
  workspaceDocumentId: string;
  enabled: boolean;
  hostname: string | null;
  appPort: number;
  hostPort: number | null;
  containerId: string | null;
  running: boolean;
  startedAt: Date | null;
  innerDocker: boolean;
  allowed: boolean;
  domainSuffix: string;
  publicUrl: string | null;
};

async function loadWorkspaceDocument(documentId: string) {
  const workspaceDocumentId = (await resolveWorkspaceDocumentId(documentId)) ?? documentId;
  const document = await db.document.findUnique({
    where: { id: workspaceDocumentId },
    select: { id: true, ownerId: true, agentInnerDocker: true, owner: { select: { email: true } }, durableApp: true }
  });
  if (!document) throw new DurableAppError("Document not found.", 404);
  return document;
}

export async function getDurableApp(documentId: string): Promise<DurableAppRecord> {
  const document = await loadWorkspaceDocument(documentId);
  const app = document.durableApp;
  return {
    workspaceDocumentId: document.id,
    enabled: app?.enabled ?? false,
    hostname: app?.hostname ?? null,
    appPort: app?.appPort ?? 3000,
    hostPort: app?.hostPort ?? null,
    containerId: app?.containerId ?? null,
    running: Boolean(app?.containerId && app?.sessionEndpoint),
    startedAt: app?.startedAt ?? null,
    innerDocker: document.agentInnerDocker,
    allowed: durableAppsAllowedFor(document.owner.email),
    domainSuffix: durableAppDomainSuffix(),
    publicUrl: app?.enabled && app.hostname ? `https://${app.hostname}` : null
  };
}

/** Lowest free host port in DURABLE_APP_PORT_RANGE (DB-unique; the front door map is a second check). */
export async function allocateHostPort(env: Env = process.env): Promise<number> {
  const { from, to } = durableAppPortRange(env);
  const taken = new Set((await db.durableApp.findMany({ select: { hostPort: true } })).map((row) => row.hostPort));
  const routed = new Set((await readFrontdoorRoutes(env))?.values() ?? []);
  for (let port = from; port <= to; port += 1) {
    if (!taken.has(port) && !routed.has(port)) return port;
  }
  throw new DurableAppError("No free host port left for durable apps.", 507);
}

export type ConfigureDurableAppInput = {
  enabled?: boolean;
  hostname?: string | null;
  appPort?: number;
  innerDocker?: boolean;
};

/**
 * Owner-only update of the workspace's durable-app settings. Enabling with a
 * hostname allocates a host port and installs the front-door route; disabling
 * removes the route and stops the container (the agent's app goes offline —
 * that is the point of turning it off).
 */
export async function configureDurableApp(
  documentId: string,
  actorUserId: string,
  input: ConfigureDurableAppInput
): Promise<DurableAppRecord> {
  const document = await loadWorkspaceDocument(documentId);
  if (document.ownerId !== actorUserId) {
    throw new DurableAppError("Only the workspace owner can change durable-app settings.", 403);
  }

  if (input.innerDocker !== undefined && input.innerDocker !== document.agentInnerDocker) {
    await db.document.update({ where: { id: document.id }, data: { agentInnerDocker: input.innerDocker } });
  }

  const wantsDurableChange =
    input.enabled !== undefined || input.hostname !== undefined || input.appPort !== undefined;
  if (!wantsDurableChange) return getDurableApp(documentId);

  if (!durableAppsAllowedFor(document.owner.email)) {
    throw new DurableAppError("Durable apps are not enabled for this workspace's owner on this deployment.", 403);
  }

  const existing = document.durableApp;
  const enabled = input.enabled ?? existing?.enabled ?? false;
  const appPort = validateAppPort(input.appPort ?? existing?.appPort ?? 3000);
  const hostname =
    input.hostname === undefined
      ? existing?.hostname ?? null
      : input.hostname === null || input.hostname.trim() === ""
        ? null
        : validateDurableHostname(input.hostname);

  let hostPort = existing?.hostPort ?? null;
  if (enabled) {
    if (!hostname) throw new DurableAppError("A hostname is required to enable the durable app.");
    await assertHostnameFree(hostname, hostPort);
    if (hostPort === null) hostPort = await allocateHostPort();
  }

  const routeChanged =
    existing?.hostname !== hostname || existing?.appPort !== appPort || existing?.enabled !== enabled;

  await db.durableApp.upsert({
    where: { documentId: document.id },
    create: { documentId: document.id, enabled, hostname, appPort, hostPort },
    update: { enabled, hostname, appPort, hostPort }
  });

  // Front door: route follows the enabled hostname; the previous hostname is
  // released when it changes.
  if (existing?.hostname && existing.hostname !== hostname) {
    await removeFrontdoorRoute(existing.hostname);
  }
  if (enabled && hostname && hostPort !== null) {
    await applyFrontdoorRoute(hostname, hostPort);
  } else if (!enabled && existing?.hostname) {
    await removeFrontdoorRoute(existing.hostname);
  }

  // A port change or a disable needs the container recreated/stopped: the
  // published port is fixed at `docker run`.
  if (routeChanged && existing?.containerId) {
    await stopDurableContainer(document.id);
  }

  return getDurableApp(documentId);
}

/** What the runner needs to run a job in the workspace's durable container. */
export type DurableRunTarget = {
  workspaceDocumentId: string;
  containerName: string;
  hostname: string | null;
  appPort: number;
  hostPort: number | null;
  innerDocker: boolean;
};

/**
 * Durable target for a run on `documentId`, or null when the workspace is not
 * (or no longer allowed to be) a durable app. Re-checks the owner allowlist at
 * run time so revoking the grant takes effect without touching rows.
 */
export async function resolveDurableRunTarget(documentId: string): Promise<DurableRunTarget | null> {
  const document = await loadWorkspaceDocument(documentId).catch(() => null);
  if (!document?.durableApp?.enabled) return null;
  if (!durableAppsAllowedFor(document.owner.email)) {
    console.warn(`[durable-app] workspace ${document.id} is durable but its owner is not allowlisted; running normally`);
    return null;
  }
  const app = document.durableApp;
  return {
    workspaceDocumentId: document.id,
    containerName: durableContainerName(document.id),
    hostname: app.hostname,
    appPort: app.appPort,
    hostPort: app.hostPort,
    innerDocker: document.agentInnerDocker
  };
}

/** Docker-in-docker preference of the workspace a run belongs to (default on). */
export async function resolveInnerDockerPreference(documentId: string): Promise<boolean> {
  const document = await loadWorkspaceDocument(documentId).catch(() => null);
  return document?.agentInnerDocker ?? true;
}

// ---------------------------------------------------------------- container

/** Force-remove the workspace's durable container (if any) and clear its handle. */
export async function stopDurableContainer(workspaceDocumentId: string, runtime = process.env.AGENT_CONTAINER_RUNTIME || "docker") {
  await execFileAsync(runtime, ["rm", "-f", durableContainerName(workspaceDocumentId)], { timeout: 60_000 }).catch(() => null);
  await db.durableApp
    .updateMany({
      where: { documentId: workspaceDocumentId },
      data: { containerId: null, sessionEndpoint: null, sessionSecret: null, startedAt: null }
    })
    .catch(() => null);
}
