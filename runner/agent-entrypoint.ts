// Container entrypoint. Runs INSIDE the hardened agent container.
//
// Protocol (NDJSON over the process's stdio):
//   stdin  : a single JSON AgentJob ({ input, agentConfig, agentEnv, validation })
//   stdout : newline-delimited frames — {type:"progress",event} | {type:"result",output} | {type:"error",message}
//   stderr : human logs only (never parsed by the host)
//
// The workspace is bind-mounted at /workspace; we override the job's host
// workspacePath with the in-container path. Submission validation (including the
// untrusted widget build) is reconstructed from the serializable spec and runs
// HERE, in the sandbox — never on the app host.

import {
  buildSubmissionValidator,
  runClaudeResearchAgent,
  runMergeConflictResolver,
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

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
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
  const raw = await readStdin();
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
      await runMergeConflictResolver({
        workspacePath: CONTAINER_WORKSPACE,
        commitSha: job.commitSha,
        model: job.agentConfig?.model,
        agentEnv: job.agentEnv,
        // Inside the container: the mount namespace is the boundary.
        isolatedRuntime: true
      });
      emit({ type: "result", output: { kind: "merge_resolve", ok: true } });
      return;
    }

    // The agent runs against the in-container mount, not the host path.
    job.input.workspacePath = CONTAINER_WORKSPACE;
    const validateSubmission = job.validation
      ? buildSubmissionValidator(job.validation, { workspacePath: CONTAINER_WORKSPACE })
      : undefined;
    const output = await runClaudeResearchAgent(job.input as never, {
      onProgress: (event: ClaudeAgentProgressEvent) => emit({ type: "progress", event }),
      // Live mid-run comments cross the container boundary as their own frame;
      // the host persists them (or buffers them into the result if it has no
      // handler).
      onComment: (comment) => emit({ type: "comment", comment }),
      agentConfig: job.agentConfig as never,
      agentEnv: job.agentEnv,
      validateSubmission,
      // We are inside the hardened container: its mount namespace is the
      // filesystem boundary, so skip the in-process workspace guard / kernel
      // sandbox that would otherwise block legitimate reads outside /workspace.
      isolatedRuntime: true
    });
    emit({ type: "result", output });
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
