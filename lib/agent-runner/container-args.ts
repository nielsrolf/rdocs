import { buildAgentEnv, type DocumentEnv } from "@/agent-core";
import { AGENT_SESSION_PORT_ENV } from "@/agent-core/session-protocol";

// Pure helpers for spawning the agent container — kept separate from the runner
// so the hardening profile and env scrubbing are unit-testable without Docker.

export type ContainerRunSpec = {
  image: string;
  /** Stable container name (`--name`) so a cancel can `docker kill` it deterministically. */
  name?: string;
  /** Host path of the document worktree; bind-mounted rw at containerWorkspace. */
  workspaceHostPath: string;
  /** Host path of the --env-file (read by the container runtime on the host). */
  envFileHostPath: string;
  /**
   * Host path of the per-conversation SDK session store. When set, it is
   * bind-mounted rw at containerSessionDir and exported as CLAUDE_CONFIG_DIR,
   * so session transcripts (messages + tool calls) survive the container and
   * follow-up runs can resume the session. Without it, transcripts land in the
   * tmpfs HOME and die with the container.
   */
  sessionDirHostPath?: string;
  containerSessionDir?: string; // default "/agent-sessions"
  /** Which SDK owns the mounted native session directory. */
  agentHarness?: "claude-code" | "codex";
  uid?: number;
  gid?: number;
  memory?: string; // e.g. "2g"
  cpus?: string; // e.g. "2"
  pidsLimit?: number; // e.g. 512
  network?: string; // e.g. "bridge"; never "none" (agent needs egress)
  readOnly?: boolean; // read-only rootfs + tmpfs scratch (default true)
  containerWorkspace?: string; // default "/workspace"
  homeDir?: string; // default "/home/agent"
  // OCI runtime to select with `--runtime` (e.g. "runsc" for gVisor, which runs
  // a user-space kernel so the agent's syscalls don't hit the host kernel —
  // a stronger boundary for untrusted code). Unset → the engine default (runc).
  // Linux-only; register the runtime with the engine before using it.
  ociRuntime?: string;
  /**
   * Detached session container (`docker run -d`): its lifetime is NOT tied to
   * the app process that started it, so a deploy/crash no longer kills the run.
   * Requires sessionPort — without a published port there is no way to reach it.
   */
  detached?: boolean;
  /**
   * In-container port of the session HTTP API (agent-core/session-server.ts).
   * Published as an EPHEMERAL host port bound to 127.0.0.1; the host discovers
   * the mapping with `docker port`. Also exported as AGENT_SESSION_PORT, which
   * is what puts the entrypoint into session mode.
   */
  sessionPort?: number;
  /**
   * Per-container Bearer secret for the session API. Deliberately NOT part of
   * the argv (visible via `ps`) — the caller must put it in the env file.
   */
  sessionSecret?: string;
};

export const DEFAULT_CONTAINER_PIDS_LIMIT = 512;

/**
 * Process/thread ceiling for an agent container. 512 is plenty for normal repo
 * work but too low for workloads that fan out (ML training with dataloader
 * workers, parallel sweeps): the container hits the cgroup pids cap and child
 * processes die with rc=1, which looks like an application bug. The agent
 * cannot raise it from inside (read-only cgroupfs + cap-drop ALL), so it is a
 * host-side knob: AGENT_CONTAINER_PIDS_LIMIT. Floor 64; -1 means unlimited.
 */
export function resolveContainerPidsLimit(env: Record<string, string | undefined>): number {
  const raw = env.AGENT_CONTAINER_PIDS_LIMIT?.trim();
  if (!raw) return DEFAULT_CONTAINER_PIDS_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_CONTAINER_PIDS_LIMIT;
  if (parsed === -1) return -1;
  if (parsed < 64) return 64;
  return parsed;
}

export function resolveContainerUser(
  platform: NodeJS.Platform,
  uid: number | undefined,
  gid: number | undefined
): Pick<ContainerRunSpec, "uid" | "gid"> {
  // Docker Desktop's Linux VM exposes macOS bind mounts as root:root even
  // when the host path belongs to the current macOS user. Passing the macOS
  // numeric UID therefore makes both /workspace and CODEX_HOME unwritable.
  // Container root is still bounded by cap-drop/no-new-privileges/read-only
  // rootfs and Docker Desktop maps created bind-mount files back to the host
  // user. Native Linux preserves real UIDs, so keep the host UID there.
  if (platform === "darwin") return { uid: undefined, gid: undefined };
  return { uid, gid };
}

// Host env vars that are meaningless or actively wrong inside the container
// (they point at host filesystem locations). Dropped from the container env;
// the image supplies its own PATH/HOME, and we set HOME/TMPDIR explicitly.
const HOST_FS_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "OLDPWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  // Points at a host directory; inside the container it is either unset (tmpfs
  // HOME default) or set explicitly to the mounted session dir by
  // buildContainerRunArgs — a leaked host value would break both.
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS"
]);

// Build the env the agent should see inside the container: the scrubbed agent
// env (API keys, tokens, locale, per-doc secrets) MINUS host-filesystem vars.
// HOME/TMPDIR are injected separately by buildContainerRunArgs.
export function buildContainerEnv(
  hostEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  agentEnv: DocumentEnv = {}
): Record<string, string> {
  const base = buildAgentEnv(hostEnv, agentEnv);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (HOST_FS_ENV_VARS.has(key)) continue;
    // Drop empty/blank values. Crucially this prevents an empty ANTHROPIC_API_KEY
    // (e.g. `ANTHROPIC_API_KEY=` in .env) from shadowing the injected
    // CLAUDE_CODE_OAUTH_TOKEN — the container has no ~/.claude fallback.
    if (!value.trim()) continue;
    out[key] = value;
  }
  return out;
}

// Serialize for `docker --env-file`: one VAR=VALUE per line, value is the
// literal rest of the line (no shell interpolation). Drops values containing a
// newline, which the env-file format cannot represent.
export function serializeEnvFile(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .filter(([, value]) => !value.includes("\n"))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

export function buildContainerRunArgs(spec: ContainerRunSpec): string[] {
  const workspace = spec.containerWorkspace ?? "/workspace";
  const home = spec.homeDir ?? "/home/agent";
  const readOnly = spec.readOnly ?? true;

  // Detached: no stdin pipe (there is no parent holding the other end) and the
  // session HTTP API replaces it for job delivery, steering and cancellation.
  // Piped: stdin IS the protocol, and the container dies with its parent.
  const args = spec.detached ? ["run", "--rm", "-d"] : ["run", "--rm", "-i"];

  if (spec.detached && spec.sessionPort) {
    // Ephemeral host port on loopback only. Off-host reachability would make the
    // Bearer secret the ONLY gate; here it is the second of two.
    args.push("-p", `127.0.0.1::${spec.sessionPort}`);
  }

  if (spec.name) {
    args.push("--name", spec.name);
  }

  // Stronger isolation runtime (e.g. gVisor's runsc) when configured. An extra
  // layer on top of the flags below, not a replacement for them.
  if (spec.ociRuntime) {
    args.push("--runtime", spec.ociRuntime);
  }

  // Run as the host user so bind-mounted files stay host-owned (lets the app
  // commit/serve them afterward).
  if (typeof spec.uid === "number" && typeof spec.gid === "number") {
    args.push("--user", `${spec.uid}:${spec.gid}`);
  }

  // Drop every Linux capability; forbid privilege escalation.
  args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");

  // Read-only rootfs with tmpfs scratch for /tmp and HOME, so the agent cannot
  // tamper with the image and writes go nowhere persistent except the workspace.
  if (readOnly) {
    args.push("--read-only");
    args.push("--tmpfs", "/tmp:rw,nosuid,nodev,exec");
    args.push("--tmpfs", `${home}:rw,nosuid,nodev,exec`);
  }

  // Resource ceilings.
  args.push("--pids-limit", String(spec.pidsLimit ?? 512));
  if (spec.memory) args.push("--memory", spec.memory);
  if (spec.cpus) args.push("--cpus", spec.cpus);

  // Egress is required (Anthropic API, PyPI, npm, CDNs); never --network none.
  args.push("--network", spec.network ?? "bridge");

  // Docker Desktop resolves host.docker.internal implicitly; native Linux
  // Docker does not, so the credential broker and Slack transcribe paths that
  // containers reach over that name fail to resolve without this mapping.
  args.push("--add-host", "host.docker.internal:host-gateway");

  // Secrets/tokens (host-read env-file), plus container-appropriate HOME/TMPDIR.
  args.push("--env-file", spec.envFileHostPath);
  args.push("-e", `HOME=${home}`, "-e", "TMPDIR=/tmp", "-e", `AGENT_WORKSPACE=${workspace}`);
  if (spec.detached && spec.sessionPort) {
    // The entrypoint selects session mode on the presence of this variable.
    // The matching secret goes in the env file, never here.
    args.push("-e", `${AGENT_SESSION_PORT_ENV}=${spec.sessionPort}`);
  }
  if (spec.agentHarness === "claude-code") {
    // Docker Desktop must run as container root so its root-owned bind mounts
    // remain writable. Claude Code normally rejects bypassPermissions as root,
    // but explicitly permits it when IS_SANDBOX=1 because an outer sandbox is
    // the security boundary. That is exactly this runner: capabilities are
    // dropped, privilege escalation is forbidden, and the rootfs is read-only.
    args.push("-e", "IS_SANDBOX=1");
  }

  // The document's worktree — plus, for conversation runs, the conversation's
  // session store (SDK transcripts) so follow-up runs can resume the session.
  args.push("-w", workspace, "-v", `${spec.workspaceHostPath}:${workspace}`);
  if (spec.sessionDirHostPath) {
    const sessionDir = spec.containerSessionDir ?? "/agent-sessions";
    args.push("-v", `${spec.sessionDirHostPath}:${sessionDir}`);
    args.push("-e", `${spec.agentHarness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}=${sessionDir}`);
  }

  args.push(spec.image);
  return args;
}
