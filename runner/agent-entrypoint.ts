// Container entrypoint. Runs INSIDE the hardened agent container.
//
// TWO TRANSPORTS
// --------------
// 1. SESSION mode (default for app-managed runs; selected by AGENT_SESSION_PORT):
//    the container is started detached and serves the session HTTP API from
//    agent-core/session-server.ts. Its lifetime is NOT tied to the app process
//    that started it — any process can attach, replay the frame log from a
//    cursor, steer, cancel, and collect the result. See
//    agent-core/session-protocol.ts for the reasoning.
// 2. STDIO mode (legacy fallback, AGENT_DETACHED_CONTAINERS=false): the original
//    piped protocol below, kept because it is the only path that works without
//    a published port.
//
// Both modes run the SAME job execution; only frame delivery differs.
//
// Legacy stdio protocol (NDJSON over the process's stdio):
//   stdin  : newline-delimited frames. The FIRST line is the JSON AgentJob
//            ({ input, agentConfig, agentEnv, validation }); every later line is
//            a steering frame {type:"user_message",text} injected into the
//            RUNNING agent turn (see agent-core/input-channel.ts). stdin stays
//            open for the life of the run — we never wait for it to end.
//   stdout : newline-delimited frames — {type:"progress",event} | {type:"result",output} | {type:"error",message}
//   stderr : human logs only (never parsed by the host)
//
// The workspace is bind-mounted at /workspace; we override the job's host
// workspacePath with the in-container path. Submission validation (including the
// untrusted widget build) is reconstructed from the serializable spec and runs
// HERE, in the sandbox — never on the app host.

import { execFileSync, spawn } from "node:child_process";
import { chownSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { spawnSync } from "node:child_process";

import {
  buildSubmissionValidator,
  createAgentInputChannel,
  agentHarnessForModel,
  runClaudeResearchAgent,
  runMergeConflictResolver,
  type AgentInputChannel,
  type ClaudeAgentProgressEvent
} from "./agent-core/index";
import {
  AGENT_SESSION_PORT,
  AGENT_SESSION_PORT_ENV,
  AGENT_SESSION_SECRET_ENV,
  createAgentSessionState,
  type AgentSessionFrameBody
} from "./agent-core/session-protocol";
import { createAgentSessionServer } from "./agent-core/session-server";

const CONTAINER_WORKSPACE = process.env.AGENT_WORKSPACE ?? "/workspace";

// Keep stdout pure NDJSON: route any stray console.log/info/debug to stderr.
// (console.warn/error already write to stderr.)
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
const toStderr = (...args: unknown[]) => {
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
};
console.log = toStderr as typeof console.log;
console.info = toStderr as typeof console.info;
console.debug = toStderr as typeof console.debug;

function emit(frame: Record<string, unknown>) {
  rawStdoutWrite(JSON.stringify(frame) + "\n");
}

// Inner Docker daemon for docker-in-container runs (gVisor or Sysbox).
// Applies only when ALL of: the runner marked this a docker-capable run
// (AGENT_INNER_DOCKER — container root alone is NOT a reliable signal, Docker
// Desktop's hardened profile is also root and dockerd can never start there),
// we actually are root, the image ships dockerd, and no daemon is already up.
// Non-fatal on every path: an agent without docker is degraded, not broken.

// Default route of the sandbox: interface, its IPv4 address and MTU. Read from
// /proc and node:os because the agent images ship no iproute2.
function defaultRoute(): { dev: string; addr?: string; mtu?: number } | undefined {
  try {
    const lines = readFileSync("/proc/net/route", "utf8").split("\n").slice(1);
    const row = lines.map((l) => l.trim().split(/\s+/)).find((f) => f.length > 7 && f[1] === "00000000" && f[7] === "00000000");
    if (!row) return undefined;
    const dev = row[0];
    const addr = (networkInterfaces()[dev] ?? []).find((i) => i.family === "IPv4" && !i.internal)?.address;
    let mtu: number | undefined;
    try {
      const n = Number(readFileSync(`/sys/class/net/${dev}/mtu`, "utf8").trim());
      if (Number.isFinite(n) && n > 0) mtu = n;
    } catch {
      // keep undefined
    }
    return { dev, addr, mtu };
  } catch {
    return undefined;
  }
}

// gVisor: dockerd cannot program NAT (netstack exposes no nat table to the
// iptables tooling dockerd uses), so we start it with --iptables=false and
// install the one masquerade rule inner containers need for egress ourselves —
// mirroring gVisor's own images/basic/docker/start-dockerd.sh. Requires the
// runsc runtime to be registered with --net-raw (iptables-legacy talks to the
// sandbox kernel over a raw socket); without it the rule fails and inner
// containers only get egress with --network=host. The host MTU is copied into
// dockerd because gVisor does not reliably forward fragmented packets.
function gvisorDockerdArgs(): string[] {
  const args = ["--iptables=false", "--ip6tables=false"];
  const route = defaultRoute();
  if (!route) {
    process.stderr.write("[agent-entrypoint] inner docker: no default route in the sandbox; inner containers will lack egress\n");
    return args;
  }
  if (route.mtu) args.push(`--mtu=${route.mtu}`);
  try {
    writeFileSync("/proc/sys/net/ipv4/ip_forward", "1");
  } catch (error) {
    process.stderr.write(`[agent-entrypoint] inner docker: could not enable ip_forward: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (!route.addr) return args;
  const iptables = existsSync("/usr/sbin/iptables-legacy") ? "/usr/sbin/iptables-legacy" : "iptables";
  for (const proto of ["tcp", "udp"]) {
    const r = spawnSync(iptables, ["-t", "nat", "-A", "POSTROUTING", "-o", route.dev, "-p", proto, "-j", "SNAT", "--to-source", route.addr], {
      encoding: "utf8",
      timeout: 10_000
    });
    if (r.status !== 0) {
      process.stderr.write(
        `[agent-entrypoint] inner docker: SNAT rule (${proto}) failed — inner containers get egress only with --network=host. ` +
          `Is runsc registered with --net-raw? ${(r.stderr || r.error?.message || "").trim()}\n`
      );
      break;
    }
  }
  return args;
}

async function maybeStartInnerDockerd(): Promise<void> {
  if (process.env.AGENT_INNER_DOCKER !== "1") return;
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  if (!existsSync("/usr/bin/dockerd")) return;
  if (existsSync("/var/run/docker.sock")) return;
  const dockerdArgs = process.env.AGENT_INNER_DOCKER_PROFILE === "gvisor" ? gvisorDockerdArgs() : [];
  try {
    // dockerd is chatty; keep the run's stderr clean and leave its logs in the
    // container for in-sandbox debugging. Fall back to discarding if the log
    // can't be opened.
    let logFd: number | "ignore" = "ignore";
    try {
      // /tmp is writable under every profile (tmpfs when the rootfs is read-only).
      logFd = openSync("/tmp/dockerd.log", "a");
    } catch {
      // keep "ignore"
    }
    const child = spawn("/usr/bin/dockerd", dockerdArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
    child.on("error", (error) => {
      process.stderr.write(`[agent-entrypoint] inner dockerd failed to start: ${error.message}\n`);
    });
    child.unref();
  } catch (error) {
    process.stderr.write(
      `[agent-entrypoint] inner dockerd spawn threw: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return;
  }
  // Wait (bounded) for the socket so the agent's very first `docker` call works.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync("/var/run/docker.sock")) {
      process.stderr.write("[agent-entrypoint] inner dockerd is up (/var/run/docker.sock)\n");
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stderr.write(
    "[agent-entrypoint] inner dockerd socket did not appear within 20s; continuing without docker\n"
  );
}

// gVisor profile: the container starts as sandbox root (dockerd needs it), but
// the AGENT must run as the host user so bind-mounted workspace/session writes
// come back host-owned (gVisor has no userns remap the way Sysbox does). The
// runner passes AGENT_RUN_USER=uid:gid; we hand the docker socket to that user
// and drop privileges in-process before agent-core starts. Irreversible by
// design: the agent cannot get root back. A failed drop is fatal — running the
// agent as root would leave root-owned files the app cannot commit or clean.
function dropToRunUser(): void {
  const raw = process.env.AGENT_RUN_USER;
  if (!raw) return;
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const match = /^(\d+):(\d+)$/.exec(raw.trim());
  if (!match) throw new Error(`[agent-entrypoint] AGENT_RUN_USER must be uid:gid, got ${JSON.stringify(raw)}`);
  const uid = Number(match[1]);
  const gid = Number(match[2]);
  if (existsSync("/var/run/docker.sock")) {
    try {
      chownSync("/var/run/docker.sock", uid, gid);
    } catch (error) {
      process.stderr.write(
        `[agent-entrypoint] could not chown docker socket: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
  process.setgroups?.([gid]);
  process.setgid!(gid);
  process.setuid!(uid);
  process.stderr.write(`[agent-entrypoint] dropped privileges to ${uid}:${gid}\n`);
}

// Reads the job (first line) and then keeps consuming stdin, routing steering
// frames into `channel` for as long as the run lasts.
function readJobAndSteer(channel: AgentInputChannel): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let job: string | null = null;
    process.stdin.setEncoding("utf8");
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (job === null) {
        job = trimmed;
        resolve(job);
        return;
      }
      try {
        const frame = JSON.parse(trimmed) as { type?: string; text?: unknown };
        if (frame.type === "user_message" && typeof frame.text === "string") {
          if (!channel.push(frame.text)) {
            process.stderr.write("[agent-entrypoint] dropped steering message (turn already ended)\n");
          }
          return;
        }
      } catch {
        // fall through
      }
      process.stderr.write("[agent-entrypoint] ignored unrecognized stdin frame\n");
    };
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    process.stdin.on("end", () => {
      if (buffer.trim()) handleLine(buffer);
      channel.close();
      // Legacy hosts wrote the job without a trailing newline and closed
      // stdin immediately; that job only surfaces here.
      if (job === null) reject(new Error("stdin closed before a job frame arrived"));
    });
    process.stdin.on("error", reject);
  });
}

type EntrypointJob =
  | {
      kind?: "agent_turn";
      input: Record<string, unknown> & { workspacePath: string | null };
      agentConfig?: { model?: string | null; effort?: string | null };
      agentEnv?: Record<string, string>;
      validation?: Parameters<typeof buildSubmissionValidator>[0];
    }
  | {
      kind: "merge_resolve";
      commitSha: string;
      agentConfig?: { model?: string | null };
      agentEnv?: Record<string, string>;
    };

// Runs one job and emits its frames through `emit`. Transport-agnostic: the
// stdio and session modes differ only in what `emit` does and where the job and
// the steering messages came from.
async function executeJob(
  job: EntrypointJob,
  emit: (frame: AgentSessionFrameBody) => void,
  inputChannel: AgentInputChannel,
  signal?: AbortSignal
) {
  try {
    if (job.kind === "merge_resolve") {
      // Resolve a git merge in the bind-mounted base checkout — IN-SANDBOX.
      const mergeInput = {
        workspacePath: CONTAINER_WORKSPACE,
        commitSha: job.commitSha,
        model: job.agentConfig?.model,
        agentEnv: job.agentEnv,
        // Inside the container: the mount namespace is the boundary.
        isolatedRuntime: true,
        // Same reason as the agent turn below: keep the CLI's config root on
        // the mounted store instead of letting it default under HOME.
        sessionConfigDir:
          (agentHarnessForModel(job.agentConfig?.model) === "codex"
            ? process.env.CODEX_HOME
            : process.env.CLAUDE_CONFIG_DIR)?.trim() || undefined
      };
      if (agentHarnessForModel(job.agentConfig?.model) === "codex") {
        const { runCodexMergeConflictResolver } = await import("./agent-core/codex-agent");
        await runCodexMergeConflictResolver(mergeInput);
      } else {
        await runMergeConflictResolver(mergeInput);
      }
      emit({ type: "result", output: { kind: "merge_resolve", ok: true } });
      return;
    }

    // Per-user GitHub auth: make plain `git clone/push https://github.com/…`
    // work with the run's resolved token (gh reads GH_TOKEN by itself). The
    // token lands in $HOME/.gitconfig — a tmpfs private to THIS container, and
    // the same env already carries it; no new exposure. Container-only: the
    // in-process runner must never rewrite the host's git config.
    const githubToken = job.agentEnv?.GITHUB_TOKEN?.trim();
    if (githubToken) {
      try {
        execFileSync("git", [
          "config",
          "--global",
          `url.https://x-access-token:${githubToken}@github.com/.insteadOf`,
          "https://github.com/"
        ]);
      } catch {
        // execFileSync errors include the full argv, which contains the token.
        process.stderr.write("[agent-entrypoint] git auth config failed: git config exited unsuccessfully.\n");
      }
    }

    // The agent runs against the in-container mount, not the host path.
    job.input.workspacePath = CONTAINER_WORKSPACE;
    const validateSubmission = job.validation
      ? buildSubmissionValidator(job.validation, { workspacePath: CONTAINER_WORKSPACE })
      : undefined;
    const runOptions = {
      onProgress: (event: ClaudeAgentProgressEvent) => emit({ type: "progress", event }),
      // Live mid-run comments cross the container boundary as their own frame;
      // the host persists them (or buffers them into the result if it has no
      // handler).
      onComment: (comment: unknown) => emit({ type: "comment", comment }),
      // Interim Slack updates cross the boundary the same way; the host posts
      // them to the thread.
      onSlackMessage: (text: string) => emit({ type: "slack_message", text }),
      // The SDK session id crosses as its own frame so the host can persist it
      // (AiRun.sdkSessionId) for follow-up session resume.
      onSessionId: (sessionId: string) => emit({ type: "session", sessionId }),
      // A ChatGPT-subscription Codex run rotates its auth.json refresh token;
      // the refreshed blob crosses as its own frame so the host can persist it
      // into the user's stored credential (secret material — never logged).
      onCodexAuthRefreshed: (authJson: string) => emit({ type: "codex_auth", authJson }),
      agentConfig: job.agentConfig as never,
      agentEnv: job.agentEnv,
      // The runner mounts the conversation's session store here and exports it
      // on the CONTAINER env; buildAgentEnv scrubs unknown host vars, so it has
      // to be forwarded explicitly or the CLI would write transcripts into the
      // container's tmpfs HOME (losing session resume) and look there for
      // credentials.
      sessionConfigDir:
        (agentHarnessForModel(job.agentConfig?.model) === "codex"
          ? process.env.CODEX_HOME
          : process.env.CLAUDE_CONFIG_DIR)?.trim() || undefined,
      validateSubmission,
      // Steering messages the host writes to stdin mid-run reach the live
      // session through this channel: Claude consumes it as streaming input,
      // Codex pumps it into the app-server's turn/steer.
      inputChannel,
      // Session mode cancels IN-PROCESS (POST /cancel) instead of relying on the
      // host to kill the container: a detached container has no parent to signal
      // it, and an aborted SDK loop still gets to emit its terminal frame.
      signal,
      // We are inside the hardened container: its mount namespace is the
      // filesystem boundary, so skip the in-process workspace guard / kernel
      // sandbox that would otherwise block legitimate reads outside /workspace.
      isolatedRuntime: true
    };
    const output = agentHarnessForModel(job.agentConfig?.model) === "codex"
      ? await (await import("./agent-core/codex-agent")).runCodexResearchAgent(job.input as never, runOptions)
      : await runClaudeResearchAgent(job.input as never, runOptions);
    emit({ type: "result", output });
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

function parseJob(raw: string): EntrypointJob | null {
  try {
    return JSON.parse(raw) as EntrypointJob;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- stdio mode
async function stdioMain() {
  const inputChannel = createAgentInputChannel();
  const raw = await readJobAndSteer(inputChannel);
  const job = parseJob(raw);
  if (!job) {
    emit({ type: "error", message: "Failed to parse job JSON from stdin." });
    process.exitCode = 1;
    return;
  }
  await executeJob(job, emit, inputChannel);
}

// -------------------------------------------------------------- session mode
// How long we wait for the host to post a job before concluding it is never
// coming (the app crashed between `docker run -d` and POST /job).
const JOB_WAIT_MS = 10 * 60_000;

async function sessionMain(port: number) {
  const secret = process.env[AGENT_SESSION_SECRET_ENV]?.trim();
  if (!secret) {
    process.stderr.write(`[agent-session] ${AGENT_SESSION_SECRET_ENV} is required in session mode\n`);
    process.exitCode = 1;
    return;
  }

  const inputChannel = createAgentInputChannel();
  const abort = new AbortController();
  const state = createAgentSessionState({
    noContactTtlMs: numberEnv("AGENT_SESSION_NO_CONTACT_MS"),
    terminalHoldMs: numberEnv("AGENT_SESSION_TERMINAL_HOLD_MS"),
    maxLifetimeMs: numberEnv("AGENT_SESSION_MAX_LIFETIME_MS")
  });

  let resolveJob: ((job: unknown) => void) | null = null;
  const jobArrived = new Promise<unknown>((resolve) => {
    resolveJob = resolve;
  });
  let exit: ((reason: string) => void) | null = null;
  const exited = new Promise<string>((resolve) => {
    exit = resolve;
  });

  const server = createAgentSessionServer({
    state,
    secret,
    handlers: {
      onJob: (job) => resolveJob?.(job),
      onMessage: (text) => {
        const delivered = inputChannel.push(text);
        if (!delivered) {
          process.stderr.write("[agent-session] steering message rejected (turn already ended)\n");
        }
        return delivered;
      },
      onCancel: () => {
        process.stderr.write("[agent-session] cancel requested by host\n");
        abort.abort(new Error("Cancelled by user."));
        inputChannel.close();
      },
      onExit: (reason) => exit?.(reason)
    }
  });

  await server.listen(port);
  process.stderr.write(`[agent-session] listening on ${port}\n`);

  const raw = await Promise.race([
    jobArrived,
    exited.then(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), JOB_WAIT_MS).unref?.())
  ]);
  if (raw == null) {
    process.stderr.write("[agent-session] no job arrived; exiting\n");
    await server.close();
    return;
  }

  const job = typeof raw === "string" ? parseJob(raw) : (raw as EntrypointJob);
  if (!job) {
    server.emit({ type: "error", message: "Failed to parse job JSON." });
  } else {
    await executeJob(job, (frame) => server.emit(frame), inputChannel, abort.signal);
  }

  // The terminal frame is in the log; the container now stays alive until the
  // host has persisted it and calls POST /release (or a TTL fires). THIS is what
  // makes a result survive the process that started the run.
  const reason = await exited;
  process.stderr.write(`[agent-session] exiting (${reason})\n`);
  await server.close();
}

function numberEnv(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

// Session mode is selected by the host exporting AGENT_SESSION_PORT in the
// container env file; the value is normally the protocol default (the host side
// maps a random 127.0.0.1 port onto it), but it stays overridable.
const sessionPortEnv = process.env[AGENT_SESSION_PORT_ENV]?.trim();
const main = sessionPortEnv
  ? () => sessionMain(numberEnv(AGENT_SESSION_PORT_ENV) ?? AGENT_SESSION_PORT)
  : stdioMain;

maybeStartInnerDockerd()
  // Always runs, even when dockerd was skipped or failed: the agent must never
  // run as sandbox root when the runner asked for a host user.
  .then(() => dropToRunUser())
  .then(() => main())
  .catch((error) => {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(() => {
    // stdio mode holds stdin open for steering; release it so the process can
    // exit as soon as the run is done. (Session mode never reads stdin.)
    process.stdin.pause();
    process.stdin.destroy();
  });
