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

async function main() {
  const raw = await readStdin();
  let job: {
    input: Record<string, unknown> & { workspacePath: string | null };
    agentConfig?: unknown;
    agentEnv?: Record<string, string>;
    validation?: Parameters<typeof buildSubmissionValidator>[0];
  };
  try {
    job = JSON.parse(raw);
  } catch (error) {
    emit({ type: "error", message: `Failed to parse job JSON from stdin: ${(error as Error).message}` });
    process.exitCode = 1;
    return;
  }

  // The agent runs against the in-container mount, not the host path.
  job.input.workspacePath = CONTAINER_WORKSPACE;

  const validateSubmission = job.validation
    ? buildSubmissionValidator(job.validation, { workspacePath: CONTAINER_WORKSPACE })
    : undefined;

  try {
    const output = await runClaudeResearchAgent(job.input as never, {
      onProgress: (event: ClaudeAgentProgressEvent) => emit({ type: "progress", event }),
      agentConfig: job.agentConfig as never,
      agentEnv: job.agentEnv,
      validateSubmission
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
