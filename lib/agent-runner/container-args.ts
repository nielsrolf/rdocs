import { buildAgentEnv, type DocumentEnv } from "@/agent-core";

// Pure helpers for spawning the agent container — kept separate from the runner
// so the hardening profile and env scrubbing are unit-testable without Docker.

export type ContainerRunSpec = {
  image: string;
  /** Host path of the document worktree; bind-mounted rw at containerWorkspace. */
  workspaceHostPath: string;
  /** Host path of the --env-file (read by the container runtime on the host). */
  envFileHostPath: string;
  uid?: number;
  gid?: number;
  memory?: string; // e.g. "2g"
  cpus?: string; // e.g. "2"
  pidsLimit?: number; // e.g. 512
  network?: string; // e.g. "bridge"; never "none" (agent needs egress)
  readOnly?: boolean; // read-only rootfs + tmpfs scratch (default true)
  containerWorkspace?: string; // default "/workspace"
  homeDir?: string; // default "/home/agent"
};

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

  const args = ["run", "--rm", "-i"];

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

  // Secrets/tokens (host-read env-file), plus container-appropriate HOME/TMPDIR.
  args.push("--env-file", spec.envFileHostPath);
  args.push("-e", `HOME=${home}`, "-e", "TMPDIR=/tmp", "-e", `AGENT_WORKSPACE=${workspace}`);

  // The ONLY host path exposed: this document's worktree.
  args.push("-w", workspace, "-v", `${spec.workspaceHostPath}:${workspace}`);

  args.push(spec.image);
  return args;
}
