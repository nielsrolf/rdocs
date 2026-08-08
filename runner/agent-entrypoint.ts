// Container entrypoint. Runs INSIDE the hardened agent container.
//
// Protocol (NDJSON over the process's stdio):
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

import { execFileSync } from "node:child_process";

import {
  buildSubmissionValidator,
  createAgentInputChannel,
  agentHarnessForModel,
  runClaudeResearchAgent,
  runMergeConflictResolver,
  type AgentInputChannel,
  type ClaudeAgentProgressEvent
} from "./agent-core/index";

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

async function main() {
  const inputChannel = createAgentInputChannel();
  const raw = await readJobAndSteer(inputChannel);
  let job: EntrypointJob;
  try {
    job = JSON.parse(raw);
  } catch (error) {
    emit({ type: "error", message: `Failed to parse job JSON from stdin: ${(error as Error).message}` });
    process.exitCode = 1;
    return;
  }

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
      onComment: (comment) => emit({ type: "comment", comment }),
      // Interim Slack updates cross the boundary the same way; the host posts
      // them to the thread.
      onSlackMessage: (text) => emit({ type: "slack_message", text }),
      // The SDK session id crosses as its own frame so the host can persist it
      // (AiRun.sdkSessionId) for follow-up session resume.
      onSessionId: (sessionId) => emit({ type: "session", sessionId }),
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
      // session through this channel (Claude harness; the Codex path ignores
      // it and the host never registers an injector for those runs).
      inputChannel,
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

main()
  .catch((error) => {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  // stdin is held open by the host for steering; release it so the process can
  // exit as soon as the run is done.
  .finally(() => {
    process.stdin.pause();
    process.stdin.destroy();
  });
